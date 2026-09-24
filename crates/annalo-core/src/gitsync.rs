//! Git remote sync: pushes the Markdown mirror (and optionally the latest database
//! backup) to a Git remote, one commit per sync.
//!
//! The mirror folder itself is swapped atomically on every refresh, so it cannot hold a
//! `.git` folder. The sync keeps its own working tree (`<data dir>/git-sync`) and brings
//! it up to date with the mirror like rsync (add, update, remove; `.git` and the files
//! the sync writes itself are kept). Then `git add -A`, a commit when anything changed,
//! and `git push origin <branch>`.
//!
//! The system `git` is used (no shell, no console window on Windows). An HTTPS access
//! token is passed through `GIT_CONFIG_*` environment variables as an
//! `http.extraHeader`, never on the command line and never written to `.git/config`;
//! every message that leaves this module is redacted. SSH remotes use the user's SSH
//! agent and keys as they are.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Working tree of the sync, inside the data folder.
pub const REPO_DIR: &str = "git-sync";
/// Name of the database copy in the repository.
pub const DB_FILE: &str = "annalo-workspace.db";
pub const README_FILE: &str = "README.md";
pub const ATTRIBUTES_FILE: &str = ".gitattributes";
/// First line of [`ATTRIBUTES_FILE`]; marks a repository written by this sync.
const MARKER: &str = "# Annalo Git-Synchronisierung";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
pub const NOT_INSTALLED: &str = "Git ist nicht installiert (git-scm.com)";
/// Prefix of the branch used when the configured branch has diverged.
pub const FALLBACK_PREFIX: &str = "annalo-sync-";

const ATTRIBUTES: &str = "# Annalo Git-Synchronisierung\n\
* text=auto\n\
*.db binary\n\
*.png binary\n\
*.jpg binary\n\
*.jpeg binary\n\
*.gif binary\n\
*.webp binary\n";

const README: &str = "# Annalo – Git-Sicherung

Dieses Repository wird von Annalo automatisch geschrieben: bei jeder Synchronisierung
wird es auf den Stand des Arbeitsbereichs gebracht. Änderungen hier werden dabei
überschrieben.

- Jede Seite ist eine Markdown-Datei (`.md`), Unterseiten liegen im gleichnamigen Ordner.
- Eingebettete Bilder liegen in `attachments/`.
- `Zeiterfassung/JJJJ-MM.csv` enthält die abgeschlossenen Buchungen je Monat.
- `annalo-workspace.db` (falls aktiviert) ist die letzte Sicherung der Datenbank.

Wiederherstellen: in Annalo unter Einstellungen → Sicherung → „Aus Git wiederherstellen…“,
oder das Repository klonen und als Obsidian-Vault importieren.
";

// ------------------------------------------------------------------ settings

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    /// After every backup (daily, and „Jetzt sichern“).
    #[default]
    WithBackup,
    /// Every hour (the mirror is refreshed first).
    Hourly,
}

/// Settings of the Git sync. The access token is not part of it; the desktop shell keeps
/// it in the OS credential store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GitSyncSettings {
    pub enabled: bool,
    /// `https://…`, `git@host:…`, `ssh://…`, `file://…` or a local path.
    pub remote_url: String,
    pub branch: String,
    pub author_name: String,
    pub author_email: String,
    /// Also commit the latest database backup as `annalo-workspace.db`.
    pub include_database: bool,
    pub mode: SyncMode,
}

impl Default for GitSyncSettings {
    fn default() -> Self {
        GitSyncSettings {
            enabled: false,
            remote_url: String::new(),
            branch: "main".into(),
            author_name: "Annalo".into(),
            author_email: "annalo@localhost".into(),
            include_database: false,
            mode: SyncMode::WithBackup,
        }
    }
}

/// Trims the fields and fills empty ones with defaults; rejects unusable values.
pub fn normalize(s: &GitSyncSettings) -> Result<GitSyncSettings> {
    let d = GitSyncSettings::default();
    let pick = |v: &str, def: &str| if v.trim().is_empty() { def.to_owned() } else { v.trim().to_owned() };
    let out = GitSyncSettings {
        enabled: s.enabled,
        remote_url: s.remote_url.trim().to_owned(),
        branch: pick(&s.branch, &d.branch),
        author_name: pick(&s.author_name, &d.author_name),
        author_email: pick(&s.author_email, &d.author_email),
        include_database: s.include_database,
        mode: s.mode,
    };
    check_branch(&out.branch)?;
    if !out.remote_url.is_empty() {
        check_url(&out.remote_url)?;
    }
    Ok(out)
}

/// Branch names git accepts (a practical subset of `git check-ref-format`).
pub fn check_branch(b: &str) -> Result<()> {
    let bad = b.is_empty()
        || b.starts_with(['-', '/', '.'])
        || b.ends_with(['/', '.'])
        || b.ends_with(".lock")
        || b.contains("..")
        || b.contains("//")
        || b.contains("@{")
        || b.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c));
    if bad {
        return Err(Error::State(format!("Ungültiger Branch-Name „{b}“")));
    }
    Ok(())
}

/// A remote URL or path that cannot be mistaken for an option.
pub fn check_url(url: &str) -> Result<()> {
    if url.is_empty() || url.starts_with('-') || url.chars().any(|c| c.is_control()) {
        return Err(Error::State("Ungültige Remote-URL".into()));
    }
    Ok(())
}

fn is_http(url: &str) -> bool {
    let l = url.trim().to_ascii_lowercase();
    l.starts_with("https://") || l.starts_with("http://")
}

// ------------------------------------------------------------ pure helpers

/// `Authorization` header for a personal access token (GitHub, GitLab, Azure DevOps
/// accept any user name with the token as password).
pub fn auth_header(token: &str) -> String {
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    format!("Authorization: Basic {basic}")
}

/// Removes credentials from `text`: the given secrets (and the base64 form of the token
/// header), any line mentioning `extraHeader`/`Authorization`, and `user:pass@` in URLs.
pub fn redact(text: &str, token: Option<&str>) -> String {
    let mut secrets: Vec<String> = Vec::new();
    if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
        let header = auth_header(t);
        secrets.push(header.trim_start_matches("Authorization: Basic ").to_owned());
        secrets.push(t.to_owned());
    }
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("extraheader") || lower.contains("authorization") {
            out.push("[Zeile mit Zugangsdaten entfernt]".into());
            continue;
        }
        let mut l = line.to_owned();
        for s in &secrets {
            l = l.replace(s.as_str(), "***");
        }
        out.push(redact_userinfo(&l));
    }
    out.join("\n")
}

/// `https://user:secret@host/x` → `https://***@host/x`.
fn redact_userinfo(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest.find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"').unwrap_or(rest.len());
        let authority = &rest[..end];
        if let Some(at) = authority.rfind('@') {
            out.push_str("***");
            out.push_str(&authority[at..]);
        } else {
            out.push_str(authority);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// „Sicherung 24.09.2026 14:05 – 3 Dateien geändert“.
pub fn commit_message<Tz: TimeZone>(at: &DateTime<Tz>, changed: usize) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let noun = if changed == 1 { "Datei" } else { "Dateien" };
    format!("Sicherung {} – {changed} {noun} geändert", at.format("%d.%m.%Y %H:%M"))
}

/// Computer name for the fallback branch, reduced to characters valid in a branch name.
pub fn hostname() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| fs::read_to_string("/etc/hostname").ok())
        .unwrap_or_default();
    sanitize_host(&raw)
}

pub fn sanitize_host(raw: &str) -> String {
    let s: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_owned();
    if s.is_empty() { "rechner".into() } else { s }
}

pub fn fallback_branch(host: &str) -> String {
    format!("{FALLBACK_PREFIX}{}", sanitize_host(host))
}

// --------------------------------------------------------------- tree sync

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeChanges {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
}

impl TreeChanges {
    pub fn total(&self) -> usize {
        self.added + self.updated + self.removed
    }
}

fn is_git_dir(name: &str) -> bool {
    name.eq_ignore_ascii_case(".git")
}

/// Root entries of the working tree the tree sync never removes: `.git` and the files
/// written by the sync itself (`README.md` only while the source has none).
fn protected(src: &Path) -> Vec<String> {
    let mut p = vec![".git".to_owned(), ATTRIBUTES_FILE.to_owned(), DB_FILE.to_owned()];
    if !src.join(README_FILE).exists() {
        p.push(README_FILE.to_owned());
    }
    p
}

/// Makes `dst` a copy of `src` (files added, changed or removed; symlinks and `.git`
/// folders in `src` are skipped). With `apply = false` only counts what would change.
pub fn sync_tree(src: &Path, dst: &Path, apply: bool) -> Result<TreeChanges> {
    let mut ch = TreeChanges::default();
    let keep = protected(src);
    sync_dir(src, dst, Some(&keep), apply, &mut ch)?;
    Ok(ch)
}

fn same_file(a: &Path, b: &Path) -> Result<bool> {
    let (ma, mb) = (fs::metadata(a)?, fs::metadata(b)?);
    if !mb.is_file() || ma.len() != mb.len() {
        return Ok(false);
    }
    Ok(fs::read(a)? == fs::read(b)?)
}

fn count_files(dir: &Path) -> usize {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    rd.flatten().map(|e| if e.file_type().is_ok_and(|t| t.is_dir()) { count_files(&e.path()) } else { 1 }).sum()
}

fn remove_path(p: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(p)?;
    if meta.is_dir() {
        fs::remove_dir_all(p)?
    } else {
        fs::remove_file(p)?
    }
    Ok(())
}

fn sync_dir(src: &Path, dst: &Path, keep: Option<&[String]>, apply: bool, ch: &mut TreeChanges) -> Result<()> {
    // Source entries: plain files and folders, no symlinks, never a `.git`.
    let mut entries: Vec<(OsString, bool)> = Vec::new();
    if src.is_dir() {
        for e in fs::read_dir(src)? {
            let e = e?;
            let ft = e.file_type()?;
            let name = e.file_name();
            if ft.is_symlink() || name.to_str().is_some_and(is_git_dir) {
                continue;
            }
            if ft.is_dir() || ft.is_file() {
                entries.push((name, ft.is_dir()));
            }
        }
    }
    entries.sort();
    let names: BTreeSet<&OsString> = entries.iter().map(|(n, _)| n).collect();

    // Removals first: on a case-insensitive file system a page renamed from `Notiz` to
    // `notiz` must lose the old file before the new one is written.
    if dst.is_dir() {
        for e in fs::read_dir(dst)? {
            let e = e?;
            let name = e.file_name();
            let kept = keep.is_some_and(|k| name.to_str().is_some_and(|n| k.iter().any(|x| x == n)));
            if kept || names.contains(&name) {
                continue;
            }
            let path = e.path();
            ch.removed += if e.file_type()?.is_dir() { count_files(&path) } else { 1 };
            if apply {
                remove_path(&path)?;
            }
        }
    } else if apply {
        if dst.exists() {
            remove_path(dst)?;
        }
        fs::create_dir_all(dst)?;
    }

    for (name, is_dir) in &entries {
        let (from, to) = (src.join(name), dst.join(name));
        if *is_dir {
            if to.exists() && !to.is_dir() {
                ch.removed += 1;
                if apply {
                    remove_path(&to)?;
                }
            }
            sync_dir(&from, &to, None, apply, ch)?;
            continue;
        }
        if to.is_dir() {
            ch.removed += count_files(&to);
            if apply {
                remove_path(&to)?;
            }
        }
        if !to.exists() {
            ch.added += 1;
        } else if !same_file(&from, &to)? {
            ch.updated += 1;
        } else {
            continue;
        }
        if apply {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Brings the working tree to the state of `source` and writes the sync's own files.
/// `database`: backup file to include as [`DB_FILE`]; `None` removes an earlier copy.
pub fn prepare_tree(source: &Path, repo: &Path, database: Option<&Path>) -> Result<TreeChanges> {
    let ch = sync_tree(source, repo, true)?;
    fs::write(repo.join(ATTRIBUTES_FILE), ATTRIBUTES)?;
    if !source.join(README_FILE).exists() {
        fs::write(repo.join(README_FILE), README)?;
    }
    let db = repo.join(DB_FILE);
    match database {
        Some(from) => {
            if !db.exists() || !same_file(from, &db)? {
                fs::copy(from, &db)?;
            }
        }
        None if db.exists() => fs::remove_file(&db)?,
        None => {}
    }
    Ok(ch)
}

// ------------------------------------------------------------------ runner

/// Result of one git invocation (already redacted).
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs the system `git` with a fixed, non-interactive environment.
#[derive(Clone)]
pub struct Git {
    program: PathBuf,
    token: Option<String>,
    /// Send the token only to HTTP(S) remotes.
    send_token: bool,
    timeout: Duration,
    /// Proxy and CA settings (Settings → Netzwerk).
    network: crate::network::GitNetwork,
}

impl std::fmt::Debug for Git {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the token.
        f.debug_struct("Git").field("program", &self.program).field("has_token", &self.token.is_some()).finish()
    }
}

impl Git {
    /// `remote_url` decides whether the token is sent (HTTP(S) only).
    pub fn new(token: Option<String>, remote_url: &str) -> Self {
        Git {
            program: PathBuf::from("git"),
            token: token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()),
            send_token: is_http(remote_url),
            timeout: DEFAULT_TIMEOUT,
            network: crate::network::GitNetwork::default(),
        }
    }

    /// Proxy environment and TLS configuration for the remote ([`crate::network::git_network`]).
    pub fn with_network(mut self, network: crate::network::GitNetwork) -> Self {
        self.network = network;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_program(mut self, program: impl Into<PathBuf>) -> Self {
        self.program = program.into();
        self
    }

    fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// The command for `args`; the token only ever travels in the environment.
    pub fn command(&self, cwd: Option<&Path>, args: &[&str]) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args([
            "-c",
            "core.quotepath=false",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "advice.detachedHead=false",
        ]);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        let mut config: Vec<(&str, String)> = vec![("protocol.ext.allow", "never".into())];
        if let (true, Some(t)) = (self.send_token, self.token()) {
            config.push(("http.extraHeader", auth_header(t)));
        }
        for (k, v) in &self.network.config {
            config.push((k.as_str(), v.clone()));
        }
        for (k, v) in &self.network.env {
            match v {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
        cmd.env("GIT_CONFIG_COUNT", config.len().to_string());
        for (i, (k, v)) in config.iter().enumerate() {
            cmd.env(format!("GIT_CONFIG_KEY_{i}"), k).env(format!("GIT_CONFIG_VALUE_{i}"), v);
        }
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("LANGUAGE", "C")
            .env("GIT_SSH_VARIANT", "auto")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    /// Runs git; `Err` only when it cannot be started or times out.
    pub fn run(&self, cwd: Option<&Path>, args: &[&str]) -> Result<GitOutput> {
        let mut child = self.command(cwd, args).spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::State(NOT_INSTALLED.into())
            } else {
                Error::State(format!("Git konnte nicht gestartet werden: {e}"))
            }
        })?;
        let reader = |r: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut r) = r {
                    let _ = r.read_to_end(&mut buf);
                }
                buf
            })
        };
        let out_t = reader(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
        let err_t = reader(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
        let start = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait()? {
                break s;
            }
            if start.elapsed() >= self.timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::State(format!(
                    "git {} hat nicht innerhalb von {} s geantwortet und wurde abgebrochen",
                    args.first().copied().unwrap_or(""),
                    self.timeout.as_secs().max(1)
                )));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).into_owned();
        let stderr = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).into_owned();
        let mut stderr = redact(&stderr, self.token());
        if let Some(p) = &self.network.secret {
            stderr = stderr.replace(p.as_str(), "***");
        }
        Ok(GitOutput { ok: status.success(), stdout, stderr })
    }

    /// Runs git and turns a non-zero exit into a German, redacted error.
    pub fn check(&self, cwd: Option<&Path>, args: &[&str]) -> Result<String> {
        let out = self.run(cwd, args)?;
        if out.ok { Ok(out.stdout) } else { Err(self.failure(args, &out)) }
    }

    fn failure(&self, args: &[&str], out: &GitOutput) -> Error {
        let raw = if out.stderr.trim().is_empty() { out.stdout.as_str() } else { out.stderr.as_str() };
        let lines: Vec<&str> =
            raw.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("hint:")).collect();
        let mut detail = lines[lines.len().saturating_sub(4)..].join(" · ");
        if detail.chars().count() > 500 {
            detail = detail.chars().take(500).collect::<String>() + "…";
        }
        let detail = redact(&detail, self.token());
        let lower = detail.to_ascii_lowercase();
        let sub = args.iter().find(|a| !a.starts_with('-')).copied().unwrap_or("");
        let msg = if [
            "authentication failed",
            "could not read username",
            "could not read password",
            "terminal prompts disabled",
            "permission denied",
            "access denied",
            "403",
            "401",
            "invalid username or password",
        ]
        .iter()
        .any(|p| lower.contains(p))
        {
            format!("Anmeldung am Git-Server fehlgeschlagen – Zugangstoken bzw. SSH-Schlüssel prüfen ({detail})")
        } else if [
            "could not resolve host",
            "repository not found",
            "does not appear to be a git repository",
            "not found",
        ]
        .iter()
        .any(|p| lower.contains(p))
        {
            format!("Git-Repository nicht erreichbar ({detail})")
        } else {
            format!("git {sub} fehlgeschlagen: {detail}")
        };
        Error::State(msg)
    }

    /// `git --version`, or [`NOT_INSTALLED`].
    pub fn version(&self) -> Result<String> {
        Ok(self.check(None, &["--version"])?.trim().to_owned())
    }

    /// Branch names on the remote (checks URL and credentials).
    pub fn ls_remote(&self, url: &str) -> Result<Vec<String>> {
        check_url(url)?;
        let out = self.check(Some(&std::env::temp_dir()), &["ls-remote", "--heads", url])?;
        Ok(out
            .lines()
            .filter_map(|l| l.split('\t').nth(1))
            .filter_map(|r| r.strip_prefix("refs/heads/"))
            .map(str::to_owned)
            .collect())
    }

    /// Shallow clone of `url` (optionally one branch) into `dest`, which must not exist.
    pub fn clone_shallow(&self, url: &str, branch: Option<&str>, dest: &Path) -> Result<()> {
        check_url(url)?;
        let dest_s = dest.to_str().ok_or_else(|| Error::State(format!("Ungültiger Pfad: {}", dest.display())))?;
        let mut args = vec!["clone", "-q", "--depth", "1"];
        if let Some(b) = branch {
            check_branch(b)?;
            args.extend(["--branch", b]);
        }
        args.extend(["--", url, dest_s]);
        self.check(Some(&std::env::temp_dir()), &args)?;
        Ok(())
    }
}

// -------------------------------------------------------------------- sync

pub struct SyncRequest<'a> {
    /// Working tree of the sync ([`REPO_DIR`] in the data folder).
    pub repo: &'a Path,
    /// The refreshed Markdown mirror.
    pub source: &'a Path,
    /// Database backup to include, if enabled.
    pub database: Option<&'a Path>,
    pub settings: &'a GitSyncSettings,
    /// Computer name for the fallback branch.
    pub host: &'a str,
    pub now: DateTime<Local>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncOutcome {
    /// Short hash of the pushed commit (`None` while the repository is empty).
    pub commit: Option<String>,
    /// A new commit was created in this run.
    pub committed: bool,
    pub changed_files: usize,
    /// Branch on the remote that holds the commit.
    pub branch: String,
    /// The configured branch had other history: pushed to [`fallback_branch`] instead.
    pub fallback: bool,
    pub message: String,
}

/// Last run, as shown in the settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GitSyncStatus {
    pub enabled: bool,
    pub repo_path: String,
    pub last_at: Option<DateTime<Local>>,
    pub last_commit: Option<String>,
    /// Branch of the last push (differs from the setting after a fallback).
    pub last_branch: Option<String>,
    pub last_error: Option<String>,
    /// Files in the mirror that differ from the last synced state.
    pub pending_changes: usize,
    pub token_set: bool,
}

fn has_head(git: &Git, repo: &Path) -> Result<bool> {
    Ok(git.run(Some(repo), &["rev-parse", "--verify", "-q", "HEAD"])?.ok)
}

fn rev(git: &Git, repo: &Path, what: &str) -> Result<Option<String>> {
    let out = git.run(Some(repo), &["rev-parse", "--verify", "-q", what])?;
    Ok(out.ok.then(|| out.stdout.trim().to_owned()).filter(|s| !s.is_empty()))
}

/// Initializes the working tree, points `origin` at `url` and HEAD at `branch`.
fn ensure_repo(git: &Git, repo: &Path, url: &str, branch: &str) -> Result<()> {
    fs::create_dir_all(repo)?;
    if !repo.join(".git").exists() {
        git.check(Some(repo), &["init", "-q"])?;
    }
    let head_ref = format!("refs/heads/{branch}");
    let current = git.run(Some(repo), &["symbolic-ref", "-q", "HEAD"])?;
    if current.stdout.trim() != head_ref {
        git.check(Some(repo), &["symbolic-ref", "HEAD", &head_ref])?;
        if has_head(git, repo)? {
            // Existing branch: the index follows it; the working tree is rewritten anyway.
            git.check(Some(repo), &["reset", "-q"])?;
        }
    }
    let remote = git.run(Some(repo), &["remote", "get-url", "origin"])?;
    if !remote.ok {
        git.check(Some(repo), &["remote", "add", "origin", url])?;
    } else if remote.stdout.trim() != url {
        git.check(Some(repo), &["remote", "set-url", "origin", url])?;
    }
    Ok(())
}

/// Hash of `branch` on the remote, `None` when it does not exist (yet).
fn remote_tip(git: &Git, repo: &Path, branch: &str) -> Result<Option<String>> {
    let out = git.check(Some(repo), &["ls-remote", "--heads", "origin", &format!("refs/heads/{branch}")])?;
    Ok(out.lines().find_map(|l| l.split('\t').next()).map(str::to_owned).filter(|s| !s.is_empty()))
}

fn fetch(git: &Git, repo: &Path, branch: &str) -> Result<()> {
    git.check(Some(repo), &["fetch", "-q", "origin", &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}")])?;
    Ok(())
}

fn rejected(out: &GitOutput) -> bool {
    let l = out.stderr.to_ascii_lowercase();
    l.contains("rejected") || l.contains("non-fast-forward") || l.contains("fetch first")
}

/// One full sync: tree, commit (if anything changed), push.
pub fn sync(git: &Git, req: &SyncRequest) -> Result<SyncOutcome> {
    let s = normalize(req.settings)?;
    if s.remote_url.is_empty() {
        return Err(Error::State("Für die Git-Synchronisierung fehlt die Remote-URL".into()));
    }
    git.version()?;
    let repo = req.repo;
    let branch = s.branch.as_str();
    ensure_repo(git, repo, &s.remote_url, branch)?;

    // A fresh working tree continues the remote's history when it was written by this
    // sync (new computer, reinstall); foreign history is never adopted.
    let mut tip = remote_tip(git, repo, branch)?;
    if tip.is_some() && !has_head(git, repo)? {
        fetch(git, repo, branch)?;
        let remote_ref = format!("origin/{branch}");
        let attrs = git.run(Some(repo), &["show", &format!("{remote_ref}:{ATTRIBUTES_FILE}")])?;
        if attrs.ok && attrs.stdout.starts_with(MARKER) {
            git.check(Some(repo), &["reset", "-q", &remote_ref])?;
        }
    }

    prepare_tree(req.source, repo, req.database)?;
    git.check(Some(repo), &["add", "-A"])?;
    let staged = git.check(Some(repo), &["diff", "--cached", "--name-only", "-z"])?;
    let changed = staged.split('\0').filter(|n| !n.is_empty()).count();
    let identity = [format!("user.name={}", s.author_name), format!("user.email={}", s.author_email)];
    let with_identity = |rest: &[&str]| -> Vec<String> {
        let mut v = vec!["-c".to_owned(), identity[0].clone(), "-c".to_owned(), identity[1].clone()];
        v.extend(rest.iter().map(|x| (*x).to_owned()));
        v
    };
    let committed = changed > 0;
    if committed {
        let msg = commit_message(&req.now, changed);
        let args = with_identity(&["commit", "-q", "--no-verify", "-m", &msg]);
        git.check(Some(repo), &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    }
    let Some(head) = rev(git, repo, "HEAD")? else {
        return Ok(SyncOutcome {
            commit: None,
            committed: false,
            changed_files: 0,
            branch: branch.to_owned(),
            fallback: false,
            message: "Nichts zu synchronisieren".into(),
        });
    };
    let short = |git: &Git| -> Result<Option<String>> {
        Ok(Some(git.check(Some(repo), &["rev-parse", "--short", "HEAD"])?.trim().to_owned()))
    };
    let done = |commit, target: &str, fallback: bool| {
        let message = match (committed, fallback) {
            (_, true) => {
                format!("Der Branch „{branch}“ auf dem Server enthält einen anderen Stand – gesichert in „{target}“")
            }
            (true, false) => commit_message(&req.now, changed),
            (false, false) => "Keine Änderungen seit der letzten Synchronisierung".into(),
        };
        SyncOutcome { commit, committed, changed_files: changed, branch: target.to_owned(), fallback, message }
    };

    if tip.as_deref() == Some(head.as_str()) {
        return Ok(done(short(git)?, branch, false));
    }
    let target = format!("HEAD:refs/heads/{branch}");
    let push = git.run(Some(repo), &["push", "-q", "origin", &target])?;
    if push.ok {
        return Ok(done(short(git)?, branch, false));
    }
    if !rejected(&push) {
        return Err(git.failure(&["push"], &push));
    }

    // The remote moved on: rebase onto it when the histories are related, else (or on a
    // conflict) keep the remote untouched and push to a branch of this computer.
    fetch(git, repo, branch)?;
    tip = rev(git, repo, &format!("refs/remotes/origin/{branch}"))?;
    let related = match &tip {
        Some(t) => git.run(Some(repo), &["merge-base", "HEAD", t])?.ok,
        None => false,
    };
    if related {
        let onto = format!("origin/{branch}");
        let args = with_identity(&["rebase", "-q", &onto]);
        let rebased = git.run(Some(repo), &args.iter().map(String::as_str).collect::<Vec<_>>())?;
        if rebased.ok {
            let again = git.run(Some(repo), &["push", "-q", "origin", &target])?;
            if again.ok {
                return Ok(done(short(git)?, branch, false));
            }
        } else {
            let _ = git.run(Some(repo), &["rebase", "--abort"]);
        }
    }
    let fb = fallback_branch(req.host);
    git.check(Some(repo), &["push", "-q", "--force", "origin", &format!("HEAD:refs/heads/{fb}")])?;
    Ok(done(short(git)?, &fb, true))
}

/// Files that would change with the next sync (mirror vs. working tree), without git.
pub fn pending_changes(source: &Path, repo: &Path) -> usize {
    if !source.is_dir() {
        return 0;
    }
    sync_tree(source, repo, false).map(|c| c.total()).unwrap_or(0)
}

/// Removes this sync's own README from a cloned repository before it is imported as a vault.
pub fn strip_sync_files(dir: &Path) -> Result<()> {
    let readme = dir.join(README_FILE);
    if fs::read_to_string(&readme).is_ok_and(|s| s.starts_with("# Annalo – Git-Sicherung")) {
        fs::remove_file(readme)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("annalo-gitsync-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(p: &Path, content: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn files(dir: &Path) -> Vec<String> {
        fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
            for e in fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                if rel == ".git" {
                    continue;
                }
                if p.is_dir() { walk(base, &p, out) } else { out.push(rel) }
            }
        }
        let mut v = Vec::new();
        walk(dir, dir, &mut v);
        v.sort();
        v
    }

    #[test]
    fn tree_sync_adds_updates_removes_and_keeps_git() {
        let base = tmp("tree");
        let (src, dst) = (base.join("src"), base.join("dst"));
        write(&src.join("a.md"), "A");
        write(&src.join("Ordner/b.md"), "B");
        write(&src.join("attachments/bild.png"), "PNG");
        write(&dst.join(".git/HEAD"), "ref: refs/heads/main");
        write(&dst.join("alt.md"), "weg");
        write(&dst.join("a.md"), "alt");
        write(&dst.join("Leer/x.md"), "x");
        write(&dst.join(DB_FILE), "db");
        write(&dst.join(README_FILE), "readme");

        let dry = sync_tree(&src, &dst, false).unwrap();
        assert_eq!(dry, TreeChanges { added: 2, updated: 1, removed: 2 });
        assert!(dst.join("alt.md").exists(), "dry run changes nothing");

        let ch = sync_tree(&src, &dst, true).unwrap();
        assert_eq!(ch, dry);
        assert_eq!(files(&dst), ["Ordner/b.md", README_FILE, "a.md", DB_FILE, "attachments/bild.png"]);
        assert_eq!(fs::read_to_string(dst.join("a.md")).unwrap(), "A");
        assert!(dst.join(".git/HEAD").exists(), ".git is kept");
        assert_eq!(sync_tree(&src, &dst, true).unwrap().total(), 0, "second run: nothing to do");

        // A file that became a folder and a `.git` folder in the source (never copied).
        fs::remove_file(src.join("a.md")).unwrap();
        write(&src.join("a.md/c.md"), "C");
        write(&src.join("Ordner/.git/config"), "evil");
        let ch = sync_tree(&src, &dst, true).unwrap();
        assert_eq!((ch.added, ch.removed), (1, 1));
        assert!(dst.join("a.md/c.md").is_file());
        assert!(!dst.join("Ordner/.git").exists());

        // The source's own README.md replaces the sync's README (and is not protected).
        write(&src.join(README_FILE), "Seite README");
        prepare_tree(&src, &dst, None).unwrap();
        assert_eq!(fs::read_to_string(dst.join(README_FILE)).unwrap(), "Seite README");
        assert!(!dst.join(DB_FILE).exists(), "database copy removed when not included");
        assert!(fs::read_to_string(dst.join(ATTRIBUTES_FILE)).unwrap().contains("*.db binary"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn messages_and_redaction() {
        let at = FixedOffset::east_opt(7200).unwrap().with_ymd_and_hms(2026, 9, 4, 8, 5, 0).unwrap();
        assert_eq!(commit_message(&at, 3), "Sicherung 04.09.2026 08:05 – 3 Dateien geändert");
        assert_eq!(commit_message(&at, 1), "Sicherung 04.09.2026 08:05 – 1 Datei geändert");

        let token = "ghp_S3cr3tT0ken";
        let header = auth_header(token);
        assert_eq!(header, "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX1MzY3IzdFQwa2Vu");
        let b64 = header.rsplit(' ').next().unwrap();
        let noisy = format!(
            "fatal: unable to access 'https://bob:{token}@github.com/x.git/': 403\n\
             trace: http.extraHeader={header}\nsomething {b64} and {token}\nhttps://github.com/ok"
        );
        let clean = redact(&noisy, Some(token));
        assert!(!clean.contains(token) && !clean.contains(b64) && !clean.contains("bob"), "{clean}");
        assert!(clean.contains("https://***@github.com/x.git/"), "{clean}");
        assert!(clean.contains("https://github.com/ok"));
        assert!(clean.contains("[Zeile mit Zugangsdaten entfernt]"));

        assert_eq!(sanitize_host("DESKTOP-4711.firma.local\n"), "desktop-4711-firma-local");
        assert_eq!(fallback_branch(""), "annalo-sync-rechner");
        assert!(check_branch("main").is_ok() && check_branch("team/backup").is_ok());
        for bad in ["", "-x", "a..b", "a b", "x.lock", "a:b", "/a"] {
            assert!(check_branch(bad).is_err(), "{bad}");
        }
        assert!(check_url("--upload-pack=evil").is_err());
        let s = GitSyncSettings {
            remote_url: " https://x/y.git ".into(),
            branch: " ".into(),
            author_name: "".into(),
            ..Default::default()
        };
        let n = normalize(&s).unwrap();
        assert_eq!(
            (n.remote_url.as_str(), n.branch.as_str(), n.author_name.as_str()),
            ("https://x/y.git", "main", "Annalo")
        );
        assert!(normalize(&GitSyncSettings { remote_url: "-oProxyCommand=x".into(), ..s }).is_err());
    }

    #[test]
    fn token_travels_only_in_the_environment() {
        let git = Git::new(Some("tok123".into()), "https://github.com/me/notes.git");
        let cmd = git.command(None, &["ls-remote", "origin"]);
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.iter().all(|a| !a.contains("tok123") && !a.contains("Authorization")), "{args:?}");
        let envs: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        let get = |k: &str| envs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(get("GIT_CONFIG_COUNT").as_deref(), Some("2"));
        assert_eq!(get("GIT_CONFIG_KEY_1").as_deref(), Some("http.extraHeader"));
        assert_eq!(get("GIT_CONFIG_VALUE_1"), Some(auth_header("tok123")));
        assert!(!format!("{git:?}").contains("tok123"));

        // SSH and local remotes never get the header.
        let ssh = Git::new(Some("tok123".into()), "git@github.com:me/notes.git");
        let cmd = ssh.command(None, &["push"]);
        assert!(cmd.get_envs().all(|(_, v)| !v.is_some_and(|v| v.to_string_lossy().contains("Authorization"))));
    }

    #[test]
    fn missing_git_and_timeouts_are_reported() {
        let git = Git::new(None, "").with_program("annalo-kein-git-hier");
        assert_eq!(git.version().unwrap_err().to_string(), format!("invalid state: {NOT_INSTALLED}"));
        #[cfg(unix)]
        if git_available() {
            // A git alias that runs far longer than the timeout.
            let slow = Git::new(None, "").with_timeout(Duration::from_millis(300));
            let start = Instant::now();
            let err = slow.run(None, &["-c", "alias.warte=!sleep 5", "warte"]).unwrap_err().to_string();
            assert!(err.contains("abgebrochen"), "{err}");
            assert!(start.elapsed() < Duration::from_secs(3));
        }
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn syncs_to_a_bare_remote() {
        if !git_available() {
            eprintln!("git not available, skipped");
            return;
        }
        let base = tmp("remote");
        let (src, repo, bare) = (base.join("mirror"), base.join("git-sync"), base.join("remote.git"));
        sh(&base, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        write(&src.join("Notiz.md"), "Hallo Welt");
        write(&src.join("attachments/bild.png"), "PNG");
        let backup = base.join("annalo-1.db");
        fs::write(&backup, b"SQLite format 3\0").unwrap();
        let settings = GitSyncSettings {
            enabled: true,
            remote_url: bare.to_str().unwrap().to_owned(),
            include_database: true,
            ..Default::default()
        };
        let git = Git::new(Some("geheim".into()), &settings.remote_url);
        let req = |repo: &Path, db: Option<PathBuf>| {
            let settings = settings.clone();
            let repo = repo.to_owned();
            let src = src.clone();
            move |git: &Git| {
                sync(
                    git,
                    &SyncRequest {
                        repo: &repo,
                        source: &src,
                        database: db.as_deref(),
                        settings: &settings,
                        host: "pc1",
                        now: Local::now(),
                    },
                )
            }
        };

        let first = req(&repo, Some(backup.clone()))(&git).unwrap();
        assert!(first.committed && !first.fallback, "{first:?}");
        assert_eq!(first.changed_files, 5, "note, image, db, README, .gitattributes");
        let log = sh(&bare, &["log", "--format=%s", "main"]);
        assert!(log.starts_with("Sicherung ") && log.contains("5 Dateien geändert"), "{log}");
        assert_eq!(sh(&bare, &["show", "main:Notiz.md"]), "Hallo Welt");
        assert_eq!(first.commit.as_deref(), Some(sh(&bare, &["rev-parse", "--short", "main"]).trim()));
        assert!(!fs::read_to_string(repo.join(".git/config")).unwrap().contains("geheim"));

        // Nothing changed: no new commit.
        let again = req(&repo, Some(backup.clone()))(&git).unwrap();
        assert!(!again.committed);
        assert_eq!(sh(&bare, &["rev-list", "--count", "main"]).trim(), "1");

        // Changes: one commit with the count; the database copy is removed when switched off.
        write(&src.join("Notiz.md"), "Hallo Welt, geändert");
        fs::remove_file(src.join("attachments/bild.png")).unwrap();
        assert_eq!(pending_changes(&src, &repo), 2);
        let second = req(&repo, None)(&git).unwrap();
        assert_eq!(second.changed_files, 3);
        assert!(sh(&bare, &["log", "-1", "--format=%s", "main"]).contains("3 Dateien geändert"));
        assert_eq!(pending_changes(&src, &repo), 0);

        // A second computer with a fresh working tree continues the same history.
        let repo2 = base.join("git-sync-2");
        write(&src.join("Neu.md"), "vom zweiten Rechner");
        let other = req(&repo2, None)(&git).unwrap();
        assert!(other.committed && !other.fallback, "{other:?}");
        assert_eq!(other.changed_files, 1);
        assert_eq!(sh(&bare, &["rev-list", "--count", "main"]).trim(), "3");

        // The first computer is now behind: it rebases onto the remote and pushes.
        write(&src.join("Notiz.md"), "dritte Fassung");
        let behind = req(&repo, None)(&git).unwrap();
        assert!(!behind.fallback, "{behind:?}");
        assert_eq!(sh(&bare, &["rev-list", "--count", "main"]).trim(), "4");

        // Restore: a shallow clone has the notes.
        let restore = base.join("restore");
        git.clone_shallow(&settings.remote_url, Some("main"), &restore).unwrap();
        assert_eq!(fs::read_to_string(restore.join("Notiz.md")).unwrap(), "dritte Fassung");
        strip_sync_files(&restore).unwrap();
        assert!(!restore.join(README_FILE).exists());
        assert!(git.ls_remote(&settings.remote_url).unwrap().contains(&"main".to_owned()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn foreign_history_goes_to_a_fallback_branch() {
        if !git_available() {
            eprintln!("git not available, skipped");
            return;
        }
        let base = tmp("foreign");
        let (src, repo, bare, other) =
            (base.join("mirror"), base.join("git-sync"), base.join("remote.git"), base.join("other"));
        sh(&base, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        fs::create_dir_all(&other).unwrap();
        sh(&other, &["init", "-q", "-b", "main"]);
        write(&other.join("README.md"), "Fremdes Projekt");
        sh(&other, &["add", "-A"]);
        sh(&other, &["commit", "-q", "-m", "fremd"]);
        sh(&other, &["push", "-q", bare.to_str().unwrap(), "main"]);

        write(&src.join("Notiz.md"), "meins");
        let settings =
            GitSyncSettings { enabled: true, remote_url: bare.to_str().unwrap().to_owned(), ..Default::default() };
        let git = Git::new(None, &settings.remote_url);
        let out = sync(
            &git,
            &SyncRequest {
                repo: &repo,
                source: &src,
                database: None,
                settings: &settings,
                host: "Büro-PC",
                now: Local::now(),
            },
        )
        .unwrap();
        assert!(out.fallback, "{out:?}");
        assert_eq!(out.branch, "annalo-sync-b-ro-pc");
        assert!(out.message.contains("annalo-sync-b-ro-pc"));
        assert_eq!(sh(&bare, &["log", "-1", "--format=%s", "main"]).trim(), "fremd", "foreign branch untouched");
        assert_eq!(sh(&bare, &["show", "annalo-sync-b-ro-pc:Notiz.md"]), "meins");

        // An unreachable remote is a clear error.
        let broken = GitSyncSettings { remote_url: base.join("fehlt.git").display().to_string(), ..settings };
        let err = sync(
            &git,
            &SyncRequest {
                repo: &repo,
                source: &src,
                database: None,
                settings: &broken,
                host: "pc",
                now: Local::now(),
            },
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("nicht erreichbar") || err.contains("fehlgeschlagen"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }
}
