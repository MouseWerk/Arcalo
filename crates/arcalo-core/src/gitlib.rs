//! The git commands of the sync on libgit2, for systems without a `git` program (the Android
//! companion app; feature `embedded-git`).
//!
//! [`run`] takes the same arguments the sync passes to the system git and answers in git's
//! output format, so `gitsync` (tree sync, merge with the server, conflicts, the mass-deletion
//! guard, the restore check) is the same code on every device. Only the commands and options
//! the sync uses are understood; anything else is refused as an unknown command.
//!
//! HTTPS goes through libgit2's OpenSSL. The access token is given to the server when it asks
//! for credentials (HTTP Basic, `x-access-token`), only for HTTP(S) remotes, never written to
//! `.git/config`. The proxy and `http.sslVerify` of the network settings apply; a pinned public
//! key (`http.pinnedPubkey`) is not supported here and refuses the connection instead.

use std::cell::Cell;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use git2::{
    CertificateCheckStatus, Cred, CredentialType, Delta, DiffFindOptions, DiffOptions, Direction, ErrorClass,
    ErrorCode, FetchOptions, IndexAddOption, ObjectType, Oid, ProxyOptions, PushOptions, RemoteCallbacks, Repository,
    ResetType, Signature, Tree, build::CheckoutBuilder,
};

use super::{Git, GitOutput};

/// Whether [`Git::new`] uses libgit2: always on Android; in tests of this crate when
/// `ARCALO_TEST_EMBEDDED_GIT` is set (the sync's tests then run on libgit2).
pub(super) fn default_on() -> bool {
    cfg!(target_os = "android") || (cfg!(test) && std::env::var_os("ARCALO_TEST_EMBEDDED_GIT").is_some())
}

/// The CA bundle libgit2's OpenSSL checks servers against (Android: written by [`init_tls`]).
static CA_FILE: OnceLock<PathBuf> = OnceLock::new();

/// Writes the CA bundle for HTTPS into `dir` and points libgit2 at it: the system's
/// certificates (Android: `/system/etc/security/cacerts`, the updatable store of Android 14 and
/// later), else Mozilla's root store compiled in. Called once at the start of the app.
pub fn init_tls(dir: &Path) -> crate::Result<PathBuf> {
    let mut pem = String::new();
    for d in ["/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"] {
        let Ok(rd) = fs::read_dir(d) else { continue };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        files.sort();
        for f in files {
            // Each file holds one certificate in PEM, followed by its description as text.
            if let Ok(text) = fs::read_to_string(&f)
                && let (Some(a), Some(b)) =
                    (text.find("-----BEGIN CERTIFICATE-----"), text.find("-----END CERTIFICATE-----"))
                && a < b
            {
                pem.push_str(&text[a..b + "-----END CERTIFICATE-----".len()]);
                pem.push('\n');
            }
        }
        if !pem.is_empty() {
            break;
        }
    }
    #[cfg(target_os = "android")]
    if pem.is_empty() {
        use base64::Engine;
        for der in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
            pem.push_str("-----BEGIN CERTIFICATE-----\n");
            let b64 = base64::engine::general_purpose::STANDARD.encode(der.as_ref());
            for chunk in b64.as_bytes().chunks(64) {
                pem.push_str(std::str::from_utf8(chunk).unwrap_or_default());
                pem.push('\n');
            }
            pem.push_str("-----END CERTIFICATE-----\n");
        }
    }
    fs::create_dir_all(dir)?;
    let file = dir.join("git-ca.pem");
    if !pem.is_empty() {
        fs::write(&file, pem)?;
        // SAFETY: called once at start-up, before any git operation runs.
        unsafe { git2::opts::set_ssl_cert_file(&file) }.map_err(|e| crate::Error::State(e.message().to_owned()))?;
        let _ = CA_FILE.set(file.clone());
    }
    Ok(file)
}

/// Runs the git command `args` in `cwd`. Never fails: errors come back as git's would, a
/// non-zero exit with the reason in `stderr`.
pub(super) fn run(git: &Git, cwd: Option<&Path>, args: &[&str]) -> GitOutput {
    set_timeouts(git.timeout);
    let (config, rest) = split_config(args);
    let mut out = String::new();
    match dispatch(git, cwd, &config, &rest, &mut out) {
        Ok(true) => GitOutput { ok: true, stdout: out, stderr: String::new() },
        Ok(false) => GitOutput { ok: false, stdout: out, stderr: String::new() },
        Err(e) => GitOutput { ok: false, stdout: String::new(), stderr: describe(&e) },
    }
}

fn set_timeouts(timeout: Duration) {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| {
        let ms = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: global libgit2 options, set once before the first network operation.
        unsafe {
            let _ = git2::opts::set_server_connect_timeout_in_milliseconds(ms.min(30_000));
            let _ = git2::opts::set_server_timeout_in_milliseconds(ms);
        }
    });
}

/// git's wording for a libgit2 error, so the sync classifies it like the program's
/// (`failure_message`: sign-in, not reachable, locked, …).
fn describe(e: &git2::Error) -> String {
    let msg = e.message();
    if e.code() == ErrorCode::Auth || msg.contains("authentication") || msg.contains("401") {
        return format!("fatal: Authentication failed: {msg}");
    }
    if e.code() == ErrorCode::Locked {
        return format!("fatal: Unable to create 'index.lock': File exists. {msg}");
    }
    if e.code() == ErrorCode::NotFastForward || msg.contains("non-fastforward") || msg.contains("not present locally") {
        return format!("! [rejected] (non-fast-forward) {msg}");
    }
    match e.class() {
        ErrorClass::Net | ErrorClass::Http | ErrorClass::Ssl | ErrorClass::Ssh => {
            format!("fatal: unable to access remote: {msg}")
        }
        ErrorClass::Os | ErrorClass::Filesystem => format!("error: {msg}"),
        _ => format!("fatal: {msg}"),
    }
}

/// Leading `-c key=value` pairs (the identity of a commit) and the command after them.
fn split_config<'a>(args: &[&'a str]) -> (Vec<(&'a str, &'a str)>, Vec<&'a str>) {
    let mut config = vec![];
    let mut i = 0;
    while i + 1 < args.len() && args[i] == "-c" {
        if let Some((k, v)) = args[i + 1].split_once('=') {
            config.push((k, v));
        }
        i += 2;
    }
    (config, args[i..].to_vec())
}

fn err(msg: impl AsRef<str>) -> git2::Error {
    git2::Error::from_str(msg.as_ref())
}

fn open(cwd: Option<&Path>) -> Result<Repository, git2::Error> {
    let dir = cwd.ok_or_else(|| err("not a git repository"))?;
    Repository::open(dir)
}

/// The options of a command (`-q`, `-z`, …) and its other arguments, split at `--`.
struct Parsed<'a> {
    flags: Vec<&'a str>,
    words: Vec<&'a str>,
    paths: Vec<&'a str>,
}

impl Parsed<'_> {
    fn has(&self, f: &str) -> bool {
        self.flags.contains(&f)
    }
}

fn parse<'a>(args: &[&'a str]) -> Parsed<'a> {
    let mut p = Parsed { flags: vec![], words: vec![], paths: vec![] };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match *a {
            "--" => {
                p.paths.extend(it.by_ref());
                break;
            }
            "-m" | "-s" | "--branch" | "--depth" => {
                p.flags.push(a);
                if let Some(v) = it.next() {
                    p.flags.push(v);
                }
            }
            a if a.starts_with('-') && a.len() > 1 => p.flags.push(a),
            a => p.words.push(a),
        }
    }
    p
}

/// The value after the option `name` (`-m <msg>`).
fn value<'a>(p: &Parsed<'a>, name: &str) -> Option<&'a str> {
    p.flags.iter().position(|f| *f == name).and_then(|i| p.flags.get(i + 1)).copied()
}

fn dispatch(
    git: &Git,
    cwd: Option<&Path>,
    config: &[(&str, &str)],
    args: &[&str],
    out: &mut String,
) -> Result<bool, git2::Error> {
    let Some((&cmd, rest)) = args.split_first() else { return Err(err("no command")) };
    let p = parse(rest);
    match cmd {
        "--version" => {
            let v = git2::Version::get();
            let (a, b, c) = v.libgit2_version();
            let _ = writeln!(out, "git version {a}.{b}.{c} (libgit2)");
            Ok(true)
        }
        "init" => {
            let dir = cwd.ok_or_else(|| err("no folder"))?;
            Repository::init(dir)?;
            Ok(true)
        }
        "rev-parse" => rev_parse(&open(cwd)?, &p, out),
        "symbolic-ref" => {
            let repo = open(cwd)?;
            match p.words.as_slice() {
                ["HEAD"] => {
                    let head = repo.find_reference("HEAD")?;
                    match head.symbolic_target()? {
                        Some(t) => {
                            let _ = writeln!(out, "{t}");
                            Ok(true)
                        }
                        None => Ok(false),
                    }
                }
                ["HEAD", target] => {
                    repo.set_head(target)?;
                    Ok(true)
                }
                _ => Err(err("symbolic-ref: unsupported arguments")),
            }
        }
        "reset" => {
            let repo = open(cwd)?;
            let target = p.words.first().copied().unwrap_or("HEAD");
            let obj = repo.revparse_single(target)?.peel(ObjectType::Commit)?;
            if p.has("--hard") {
                let mut co = CheckoutBuilder::new();
                co.force();
                repo.reset(&obj, ResetType::Hard, Some(&mut co))?;
            } else {
                repo.reset(&obj, ResetType::Mixed, None)?;
            }
            repo.cleanup_state()?;
            Ok(true)
        }
        "remote" => {
            let repo = open(cwd)?;
            match p.words.as_slice() {
                ["get-url", name] => match repo.find_remote(name) {
                    Ok(r) => {
                        let _ = writeln!(out, "{}", r.url().unwrap_or_default());
                        Ok(true)
                    }
                    Err(e) if e.code() == ErrorCode::NotFound => Ok(false),
                    Err(e) => Err(e),
                },
                ["add", name, url] => {
                    repo.remote(name, url)?;
                    Ok(true)
                }
                ["set-url", name, url] => {
                    repo.remote_set_url(name, url)?;
                    Ok(true)
                }
                _ => Err(err("remote: unsupported arguments")),
            }
        }
        "ls-remote" => ls_remote(git, cwd, &p, out),
        "fetch" => {
            let repo = open(cwd)?;
            let [name, spec] = p.words.as_slice() else { return Err(err("fetch: unsupported arguments")) };
            let mut remote = repo.find_remote(name)?;
            let url = remote.url().unwrap_or_default().to_owned();
            let attempts = Cell::new(0);
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(callbacks(git, &url, &attempts));
            fo.proxy_options(proxy(git));
            fo.download_tags(git2::AutotagOption::None);
            remote.fetch(&[*spec], Some(&mut fo), None)?;
            Ok(true)
        }
        "show" | "cat-file" => {
            let repo = open(cwd)?;
            let spec = p.words.last().copied().unwrap_or_default();
            match blob_of(&repo, spec)? {
                Some(id) => {
                    let blob = repo.find_blob(id)?;
                    out.push_str(&String::from_utf8_lossy(blob.content()));
                    Ok(true)
                }
                None if cmd == "show" => Ok(false),
                None => Err(err(format!("Not a valid object name {spec}"))),
            }
        }
        "add" => {
            let repo = open(cwd)?;
            let mut index = repo.index()?;
            if p.has("-A") {
                index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
                index.update_all(["*"], None)?;
            } else {
                for path in &p.paths {
                    let full = repo.workdir().ok_or_else(|| err("bare repository"))?.join(path);
                    if full.is_file() {
                        index.add_path(Path::new(path))?;
                    } else {
                        let _ = index.remove_path(Path::new(path));
                    }
                }
            }
            index.write()?;
            Ok(true)
        }
        "diff" => diff(&open(cwd)?, &p, out),
        "ls-tree" => {
            let repo = open(cwd)?;
            let rev = p.words.first().copied().unwrap_or("HEAD");
            let tree = repo.revparse_single(rev)?.peel_to_tree()?;
            tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
                if entry.kind() == Some(ObjectType::Blob) {
                    out.push_str(dir);
                    out.push_str(entry.name().unwrap_or_default());
                    out.push('\0');
                }
                git2::TreeWalkResult::Ok
            })?;
            Ok(true)
        }
        "commit" => commit(&open(cwd)?, config, &p, out),
        "push" => push(git, &open(cwd)?, &p),
        "merge-base" => {
            let repo = open(cwd)?;
            let [a, b] = p.words.as_slice() else { return Err(err("merge-base: unsupported arguments")) };
            let a = repo.revparse_single(a)?.peel(ObjectType::Commit)?.id();
            let b = repo.revparse_single(b)?.peel(ObjectType::Commit)?.id();
            if p.has("--is-ancestor") {
                return Ok(a == b || repo.graph_descendant_of(b, a)?);
            }
            match repo.merge_base(a, b) {
                Ok(id) => {
                    let _ = writeln!(out, "{id}");
                    Ok(true)
                }
                Err(e) if e.code() == ErrorCode::NotFound => Ok(false),
                Err(e) => Err(e),
            }
        }
        "checkout" => {
            let repo = open(cwd)?;
            let rev = p.words.first().copied().unwrap_or("HEAD");
            let obj = repo.revparse_single(rev)?.peel(ObjectType::Commit)?;
            let mut co = CheckoutBuilder::new();
            co.force().disable_pathspec_match(true);
            for path in &p.paths {
                co.path(*path);
            }
            repo.checkout_tree(&obj, Some(&mut co))?;
            Ok(true)
        }
        "rm" => {
            let repo = open(cwd)?;
            let mut index = repo.index()?;
            let work = repo.workdir().ok_or_else(|| err("bare repository"))?.to_path_buf();
            for path in &p.paths {
                let _ = index.remove_path(Path::new(path));
                let full = work.join(path);
                if full.is_file() {
                    fs::remove_file(&full).map_err(|e| err(e.to_string()))?;
                }
            }
            index.write()?;
            Ok(true)
        }
        "merge" => {
            // Only `merge --no-commit -s ours <commit>`: the next commit gets `<commit>` as its
            // second parent; index and working tree stay as they are.
            let repo = open(cwd)?;
            if value(&p, "-s") != Some("ours") || !p.has("--no-commit") {
                return Err(err("merge: only the strategy ours without commit is supported"));
            }
            let theirs = p.words.first().ok_or_else(|| err("merge: no commit"))?;
            let id = repo.revparse_single(theirs)?.peel(ObjectType::Commit)?.id();
            let git_dir = repo.path().to_path_buf();
            fs::write(git_dir.join("MERGE_HEAD"), format!("{id}\n")).map_err(|e| err(e.to_string()))?;
            fs::write(git_dir.join("MERGE_MODE"), "no-ff").map_err(|e| err(e.to_string()))?;
            Ok(true)
        }
        "log" => log_raw(&open(cwd)?, &p, out),
        "clone" => {
            let [url, dest] = p.paths.as_slice() else { return Err(err("clone: unsupported arguments")) };
            let attempts = Cell::new(0);
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(callbacks(git, url, &attempts));
            fo.proxy_options(proxy(git));
            // libgit2 fetches shallow over the network only (git ignores the depth for a local
            // repository as well).
            if let Some(d) = value(&p, "--depth").and_then(|d| d.parse().ok())
                && super::is_http(url)
            {
                fo.depth(d);
            }
            let mut b = git2::build::RepoBuilder::new();
            b.fetch_options(fo);
            if let Some(branch) = value(&p, "--branch") {
                b.branch(branch);
            }
            b.clone(url, Path::new(dest))?;
            Ok(true)
        }
        other => Err(err(format!("'{other}' is not supported by the built-in git"))),
    }
}

/// `<rev>:<path>` (`:<path>` = the index): the blob, `None` when there is no such file.
fn blob_of(repo: &Repository, spec: &str) -> Result<Option<Oid>, git2::Error> {
    let Some((rev, path)) = spec.split_once(':') else {
        return Ok(repo.revparse_single(spec).ok().map(|o| o.id()));
    };
    if rev.is_empty() {
        let index = repo.index()?;
        return Ok(index.get_path(Path::new(path), 0).map(|e| e.id));
    }
    let Ok(obj) = repo.revparse_single(rev) else { return Ok(None) };
    let tree = obj.peel_to_tree()?;
    match tree.get_path(Path::new(path)) {
        Ok(entry) => Ok(Some(entry.id())),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn rev_parse(repo: &Repository, p: &Parsed, out: &mut String) -> Result<bool, git2::Error> {
    let what = p.words.first().copied().unwrap_or("HEAD");
    let id = if what.contains(':') {
        blob_of(repo, what)?
    } else {
        match repo.revparse_single(what) {
            Ok(o) => Some(o.peel(ObjectType::Commit).map(|c| c.id()).unwrap_or(o.id())),
            Err(_) => None,
        }
    };
    let Some(id) = id else { return Ok(false) };
    if p.has("--short") {
        let _ = writeln!(out, "{}", &id.to_string()[..7]);
    } else {
        let _ = writeln!(out, "{id}");
    }
    Ok(true)
}

fn ls_remote(git: &Git, cwd: Option<&Path>, p: &Parsed, out: &mut String) -> Result<bool, git2::Error> {
    let target = p.words.first().copied().ok_or_else(|| err("ls-remote: no remote"))?;
    let pattern = p.words.get(1).copied();
    // `origin` of the working tree, or an address (the connection test of the settings).
    let repo = if target == "origin" { Some(open(cwd)?) } else { None };
    let mut remote = match &repo {
        Some(r) => r.find_remote(target)?,
        None => git2::Remote::create_detached(target)?,
    };
    let url = remote.url().unwrap_or_default().to_owned();
    let attempts = Cell::new(0);
    let conn = remote.connect_auth(Direction::Fetch, Some(callbacks(git, &url, &attempts)), Some(proxy(git)))?;
    for head in conn.list()? {
        let name = head.name();
        if !name.starts_with("refs/heads/") || pattern.is_some_and(|pat| pat != name) {
            continue;
        }
        let _ = writeln!(out, "{}\t{name}", head.oid());
    }
    Ok(true)
}

fn head_tree(repo: &Repository) -> Option<Tree<'_>> {
    repo.head().ok().and_then(|h| h.peel_to_tree().ok())
}

/// One line of `--name-only` / `--name-status`, `-z` separated.
fn delta_path(d: &git2::DiffDelta) -> String {
    let file = if d.status() == Delta::Deleted { d.old_file() } else { d.new_file() };
    file.path().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

fn status_letter(s: Delta) -> char {
    match s {
        Delta::Added => 'A',
        Delta::Deleted => 'D',
        Delta::Renamed => 'R',
        Delta::Copied => 'C',
        Delta::Typechange => 'T',
        _ => 'M',
    }
}

fn diff(repo: &Repository, p: &Parsed, out: &mut String) -> Result<bool, git2::Error> {
    let mut opts = DiffOptions::new();
    opts.include_typechange(true);
    let mut d = if p.has("--cached") {
        // Index against HEAD (or against nothing before the first commit).
        let base = match p.words.first() {
            Some(rev) => Some(repo.revparse_single(rev)?.peel_to_tree()?),
            None => head_tree(repo),
        };
        let index = repo.index()?;
        repo.diff_tree_to_index(base.as_ref(), Some(&index), Some(&mut opts))?
    } else {
        let [from, to] = p.words.as_slice() else { return Err(err("diff: unsupported arguments")) };
        let from = repo.revparse_single(from)?.peel_to_tree()?;
        let to = repo.revparse_single(to)?.peel_to_tree()?;
        repo.diff_tree_to_tree(Some(&from), Some(&to), Some(&mut opts))?
    };
    if p.has("-M") {
        let mut find = DiffFindOptions::new();
        find.renames(true);
        d.find_similar(Some(&mut find))?;
    }
    let only_deleted = p.has("--diff-filter=D");
    for delta in d.deltas() {
        if only_deleted && delta.status() != Delta::Deleted {
            continue;
        }
        if p.has("--name-status") {
            out.push(status_letter(delta.status()));
            out.push('\0');
            // Like git: a rename lists the old path before the new one.
            if delta.status() == Delta::Renamed {
                out.push_str(
                    &delta.old_file().path().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default(),
                );
                out.push('\0');
            }
        }
        out.push_str(&delta_path(&delta));
        out.push('\0');
    }
    Ok(true)
}

fn commit(repo: &Repository, config: &[(&str, &str)], p: &Parsed, out: &mut String) -> Result<bool, git2::Error> {
    let msg = value(p, "-m").unwrap_or("Arcalo");
    let get = |k: &str| config.iter().find(|(n, _)| *n == k).map(|(_, v)| *v);
    let sig = Signature::now(get("user.name").unwrap_or("Arcalo"), get("user.email").unwrap_or("arcalo@localhost"))?;
    let mut index = repo.index()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let mut parents = vec![];
    if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
        parents.push(head);
    }
    let merge_head = repo.path().join("MERGE_HEAD");
    if let Ok(text) = fs::read_to_string(&merge_head) {
        let id = Oid::from_str(text.trim())?;
        parents.push(repo.find_commit(id)?);
    }
    if parents.len() < 2 && parents.first().is_some_and(|h| h.tree_id() == tree.id()) {
        let _ = writeln!(out, "nothing to commit, working tree clean");
        return Ok(false);
    }
    let refs: Vec<&git2::Commit> = parents.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &refs)?;
    repo.cleanup_state()?;
    let _ = fs::remove_file(repo.path().join("MERGE_MODE"));
    Ok(true)
}

fn push(git: &Git, repo: &Repository, p: &Parsed) -> Result<bool, git2::Error> {
    let [name, spec] = p.words.as_slice() else { return Err(err("push: unsupported arguments")) };
    let force = p.has("--force");
    // `HEAD:refs/heads/x`: libgit2 wants a reference name as the source.
    let spec = match spec.split_once(':') {
        Some(("HEAD", dst)) => {
            let head = repo.head()?;
            let src = head.name()?.to_owned();
            format!("{}{src}:{dst}", if force { "+" } else { "" })
        }
        _ => format!("{}{spec}", if force { "+" } else { "" }),
    };
    let mut remote = repo.find_remote(name)?;
    let url = remote.url().unwrap_or_default().to_owned();
    let attempts = Cell::new(0);
    let rejected: Cell<Option<String>> = Cell::new(None);
    let mut cb = callbacks(git, &url, &attempts);
    cb.push_update_reference(|refname, status| {
        if let Some(s) = status {
            rejected.set(Some(format!("{refname}: {s}")));
        }
        Ok(())
    });
    let mut po = PushOptions::new();
    po.remote_callbacks(cb);
    po.proxy_options(proxy(git));
    remote.push(&[spec.as_str()], Some(&mut po))?;
    drop(po);
    if let Some(why) = rejected.take() {
        return Err(git2::Error::new(
            ErrorCode::NotFastForward,
            ErrorClass::Reference,
            format!("rejected (fetch first): {why}"),
        ));
    }
    // What `git push` does as well: the remote-tracking branch follows.
    if let Some(dst) = spec.split_once(':').map(|(_, d)| d)
        && let Some(branch) = dst.strip_prefix("refs/heads/")
        && let Ok(head) = repo.head().and_then(|h| h.peel_to_commit())
    {
        let _ = repo.reference(&format!("refs/remotes/{name}/{branch}"), head.id(), true, "push");
    }
    Ok(true)
}

/// `log --format= --raw --no-abbrev --no-renames -z <rev> --`: per commit (first parent, merges
/// left out like git does) `:<mode> <mode> <old> <new> <status>\0<path>\0`.
fn log_raw(repo: &Repository, p: &Parsed, out: &mut String) -> Result<bool, git2::Error> {
    let rev = p.words.first().copied().unwrap_or("HEAD");
    let start = repo.revparse_single(rev)?.peel(ObjectType::Commit)?.id();
    let mut walk = repo.revwalk()?;
    walk.push(start)?;
    for id in walk {
        let commit = repo.find_commit(id?)?;
        if commit.parent_count() > 1 {
            continue;
        }
        let tree = commit.tree()?;
        let parent = commit.parent(0).ok().map(|c| c.tree()).transpose()?;
        let d = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), None)?;
        for delta in d.deltas() {
            let (o, n) = (delta.old_file(), delta.new_file());
            let _ = write!(
                out,
                "\n:{:06o} {:06o} {} {} {}\0{}\0",
                u32::from(o.mode()),
                u32::from(n.mode()),
                o.id(),
                n.id(),
                status_letter(delta.status()),
                delta_path(&delta)
            );
        }
    }
    Ok(true)
}

/// Credentials (the token, once per operation: a refused token is not sent again and again)
/// and the certificate check of the network settings.
fn callbacks<'a>(git: &'a Git, url: &str, attempts: &'a Cell<u32>) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    let http = super::is_http(url);
    let token = git.token().filter(|_| git.send_token && http).map(str::to_owned);
    cb.credentials(move |_url, _user, allowed| {
        let n = attempts.get();
        attempts.set(n + 1);
        match &token {
            Some(t) if n == 0 && allowed.contains(CredentialType::USER_PASS_PLAINTEXT) => {
                Cred::userpass_plaintext("x-access-token", t)
            }
            _ => Err(git2::Error::new(ErrorCode::Auth, ErrorClass::Http, "authentication failed")),
        }
    });
    let insecure = config(git, "http.sslVerify").is_some_and(|v| v.eq_ignore_ascii_case("false"));
    let pinned = config(git, "http.pinnedPubkey").is_some();
    cb.certificate_check(move |_cert, _host| {
        if pinned {
            return Err(git2::Error::new(
                ErrorCode::Certificate,
                ErrorClass::Ssl,
                "a pinned server key is not supported by the built-in git",
            ));
        }
        Ok(if insecure {
            CertificateCheckStatus::CertificateOk
        } else {
            CertificateCheckStatus::CertificatePassthrough
        })
    });
    cb
}

fn config<'a>(git: &'a Git, key: &str) -> Option<&'a str> {
    git.network.config.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
}

/// The proxy of the network settings (`https_proxy`/`http_proxy`), else none.
fn proxy(git: &Git) -> ProxyOptions<'static> {
    let mut po = ProxyOptions::new();
    let env = |k: &str| git.network.env.iter().find(|(n, _)| n == k).and_then(|(_, v)| v.clone());
    if let Some(p) = env("https_proxy").or_else(|| env("http_proxy")).filter(|p| !p.is_empty()) {
        po.url(&p);
    }
    po
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("arcalo-gitlib-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn git() -> Git {
        let mut g = Git::new(None, "");
        g.embedded = true;
        g
    }

    fn ok(g: &Git, dir: &Path, args: &[&str]) -> String {
        let out = run(g, Some(dir), args);
        assert!(out.ok, "{args:?}: {}", out.stderr);
        out.stdout
    }

    #[test]
    fn commands_answer_like_git() {
        let base = tmp("basic");
        let (bare, work) = (base.join("remote.git"), base.join("work"));
        Repository::init_bare(&bare).unwrap();
        fs::create_dir_all(&work).unwrap();
        let g = git();
        assert!(ok(&g, &work, &["--version"]).contains("libgit2"));
        ok(&g, &work, &["init", "-q"]);
        ok(&g, &work, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        assert_eq!(ok(&g, &work, &["symbolic-ref", "-q", "HEAD"]).trim(), "refs/heads/main");
        assert!(!run(&g, Some(&work), &["rev-parse", "--verify", "-q", "HEAD"]).ok);
        assert!(!run(&g, Some(&work), &["remote", "get-url", "origin"]).ok);
        ok(&g, &work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        assert_eq!(ok(&g, &work, &["remote", "get-url", "origin"]).trim(), bare.to_str().unwrap());

        fs::write(work.join("Notiz.md"), "Hallo\r\nWelt\r\n").unwrap();
        fs::write(work.join(".gitattributes"), "* text=auto\n").unwrap();
        ok(&g, &work, &["add", "-A"]);
        let staged = ok(&g, &work, &["diff", "--cached", "--name-only", "-z"]);
        assert_eq!(staged, ".gitattributes\0Notiz.md\0");
        ok(&g, &work, &["-c", "user.name=Tester", "-c", "user.email=t@example.com", "commit", "-q", "-m", "Eins"]);
        let head = ok(&g, &work, &["rev-parse", "--verify", "-q", "HEAD"]).trim().to_owned();
        assert_eq!(head.len(), 40);
        assert_eq!(ok(&g, &work, &["rev-parse", "--short", "HEAD"]).trim(), &head[..7]);
        // `text=auto` stores line ends as LF, like git.
        assert_eq!(ok(&g, &work, &["cat-file", "blob", "HEAD:Notiz.md"]), "Hallo\nWelt\n");
        assert!(!run(&g, Some(&work), &["show", "HEAD:Fehlt.md"]).ok);
        assert_eq!(ok(&g, &work, &["ls-tree", "-r", "--name-only", "-z", "HEAD"]), ".gitattributes\0Notiz.md\0");

        assert!(ok(&g, &work, &["ls-remote", "--heads", "origin", "refs/heads/main"]).is_empty());
        ok(&g, &work, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
        let remote = ok(&g, &work, &["ls-remote", "--heads", "origin", "refs/heads/main"]);
        assert_eq!(remote, format!("{head}\trefs/heads/main\n"));
        let listed = ok(&g, &work, &["ls-remote", "--heads", bare.to_str().unwrap()]);
        assert!(listed.contains("refs/heads/main"));

        // Deleted and renamed notes, as the mass-deletion guard counts them.
        fs::create_dir_all(work.join("Ordner")).unwrap();
        fs::rename(work.join("Notiz.md"), work.join("Ordner/Notiz.md")).unwrap();
        ok(&g, &work, &["add", "-A"]);
        let deleted = ok(&g, &work, &["diff", "--cached", "-M", "--name-only", "--diff-filter=D", "-z"]);
        assert_eq!(deleted, "", "a move is no deletion");
        let status = ok(&g, &work, &["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"]);
        assert_eq!(status, "D\0Notiz.md\0A\0Ordner/Notiz.md\0");
        // With rename detection the move is one entry, old path first (git writes `R100`).
        let status = ok(&g, &work, &["diff", "--cached", "--name-status", "-M", "-z", "HEAD"]);
        assert_eq!(status, "R\0Notiz.md\0Ordner/Notiz.md\0");
        assert_eq!(ok(&g, &work, &["rev-parse", "-q", "--verify", ":Ordner/Notiz.md"]).trim().len(), 40);
        ok(&g, &work, &["reset", "-q"]);
        assert_eq!(ok(&g, &work, &["diff", "--cached", "--name-only", "-z"]), "");

        // A path back to its committed state, and away.
        ok(&g, &work, &["checkout", "-q", "HEAD", "--", "Notiz.md"]);
        assert_eq!(fs::read_to_string(work.join("Notiz.md")).unwrap(), "Hallo\nWelt\n");
        ok(&g, &work, &["rm", "-q", "-f", "--ignore-unmatch", "--", "Notiz.md"]);
        assert!(!work.join("Notiz.md").exists());
        ok(&g, &work, &["reset", "-q", "--hard", "HEAD"]);
        assert!(work.join("Notiz.md").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn unknown_commands_and_missing_repositories_fail() {
        let base = tmp("fail");
        let g = git();
        let out = run(&g, Some(&base), &["gc"]);
        assert!(!out.ok && out.stderr.contains("not supported"), "{}", out.stderr);
        let out = run(&g, Some(&base), &["add", "-A"]);
        assert!(!out.ok && out.stderr.starts_with("fatal:") || out.stderr.starts_with("error:"), "{}", out.stderr);
        let _ = fs::remove_dir_all(&base);
    }
}
