//! Function calling: tool definitions offered to the model and a guarded executor.
//!
//! Workspace tools (logging time, searching, budget lookups, time summaries) run directly.
//! System tools (PowerShell, Git, REST) never run on the model's say-so alone:
//! [`classify`] marks them [`Risk::RequiresApproval`] and the shell must show
//! the exact command to the user before calling [`execute_system_tool`].

use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{Error, Result};

/// HTTP client used by [`execute_system_tool`] (re-exported so shells need no reqwest dependency).
pub type HttpClient = reqwest::Client;

/// Output longer than this is truncated before it is sent back to the model.
const MAX_OUTPUT: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    /// Reads or writes only the local workspace; runs without confirmation.
    Workspace,
    /// Touches the system or network; needs explicit user approval.
    RequiresApproval,
}

/// Read-only git subcommands the model may request.
const GIT_ALLOWED: &[&str] = &["status", "log", "diff", "show", "branch", "blame", "shortlog", "rev-parse"];

pub fn definitions() -> Vec<Value> {
    let f = |name: &str, description: &str, parameters: Value| json!({ "type": "function", "function": { "name": name, "description": description, "parameters": parameters } });
    vec![
        f(
            "log_time",
            "Bucht Zeit auf ein Netzplan-Element. Nutzt die /zeit-Syntax, z. B. \"/zeit NP-8801/1020 2.5h #DEV 'Systemintegration'\".",
            json!({ "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] }),
        ),
        f(
            "search_workspace",
            "Volltextsuche über Notizen und Zeiteinträge.",
            json!({ "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }),
        ),
        f(
            "budget_status",
            "Budget, gebuchte Stunden und ETC eines Netzplans.",
            json!({ "type": "object", "properties": { "netzplan": { "type": "string" } }, "required": ["netzplan"] }),
        ),
        f(
            "list_tasks",
            "Listet Aufgaben (- [ ] …) aus allen Notizen mit Seite, Fälligkeit (YYYY-MM-DD) und Priorität (2 hoch, 1 mittel).",
            json!({ "type": "object", "properties": {
                "status": { "type": "string", "enum": ["open", "done", "all"], "description": "Standard: open" },
                "due_before": { "type": "string", "description": "Nur fällig bis einschließlich YYYY-MM-DD" },
                "tag": { "type": "string", "description": "Tag der Aufgabe oder ihrer Seite, ohne #" },
                "changed_since": { "type": "string", "description": "Nur Aufgaben auf Seiten, die seit diesem Tag (YYYY-MM-DD) geändert wurden, z. B. für „diese Woche erledigt“" } } }),
        ),
        f(
            "time_summary",
            "Gebuchte Stunden je Netzplan/Vorgang mit den Beschreibungen der Einträge und Summen je Tag, für Statusberichte.",
            json!({ "type": "object", "properties": {
                "from": { "type": "string", "description": "Erster Tag, YYYY-MM-DD" },
                "to": { "type": "string", "description": "Letzter Tag einschließlich, YYYY-MM-DD" } }, "required": ["from", "to"] }),
        ),
        f(
            "activity_log",
            "Was im Arbeitsbereich an einem Tag oder in einem Zeitraum passiert ist (nur lesend): angelegte und bearbeitete Seiten, neue und erledigte Aufgaben, Buchungen, Freigaben, Dateien und Fokussitzungen, mit Uhrzeit. Für Fragen wie „Was habe ich am Dienstag gemacht?“.",
            json!({ "type": "object", "properties": {
                "from": { "type": "string", "description": "Erster Tag, YYYY-MM-DD" },
                "to": { "type": "string", "description": "Letzter Tag einschließlich, YYYY-MM-DD (Standard: wie from)" } }, "required": ["from"] }),
        ),
        f(
            "run_powershell",
            "Führt ein PowerShell-Skript aus. Der Nutzer muss jede Ausführung bestätigen.",
            json!({ "type": "object", "properties": { "script": { "type": "string" }, "cwd": { "type": "string" } }, "required": ["script"] }),
        ),
        f(
            "git",
            &format!("Führt einen lesenden git-Befehl aus ({}).", GIT_ALLOWED.join(", ")),
            json!({ "type": "object", "properties": {
                "args": { "type": "array", "items": { "type": "string" } },
                "repo": { "type": "string" } }, "required": ["args", "repo"] }),
        ),
        f(
            "http_request",
            "Ruft eine REST-API auf.",
            json!({ "type": "object", "properties": {
                "method": { "type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                "url": { "type": "string" },
                "body": {} }, "required": ["method", "url"] }),
        ),
    ]
}

/// The definitions of the tools in `allowed` (Settings → KI → Werkzeuge).
pub fn definitions_allowed(allowed: &[String]) -> Vec<Value> {
    definitions().into_iter().filter(|d| allowed.iter().any(|a| d["function"]["name"] == a.as_str())).collect()
}

/// Rejects a tool the user has not allowed (the model may name tools it was not offered).
pub fn check_allowed(tool: &str, allowed: &[String]) -> Result<()> {
    if allowed.iter().any(|a| a == tool) {
        Ok(())
    } else {
        Err(Error::State(format!("Das Werkzeug „{tool}“ ist in den Einstellungen (KI → Werkzeuge) nicht erlaubt")))
    }
}

pub fn classify(tool: &str) -> Risk {
    match tool {
        "log_time" | "search_workspace" | "budget_status" | "list_tasks" | "time_summary" | "activity_log" => {
            Risk::Workspace
        }
        _ => Risk::RequiresApproval,
    }
}

/// A system tool call, validated and ready to show to the user for approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "tool")]
pub enum SystemCall {
    RunPowershell { script: String, cwd: Option<String> },
    Git { args: Vec<String>, repo: String },
    HttpRequest { method: String, url: String, body: Option<Value> },
}

impl SystemCall {
    /// Parses and validates a model tool call. Rejects anything outside policy.
    pub fn from_tool_call(name: &str, arguments: &str) -> Result<Self> {
        let args: Value = serde_json::from_str(arguments)
            .map_err(|e| Error::Parse(format!("Ungültige Werkzeug-Argumente vom Modell ({e})")))?;
        let s = |k: &str| args[k].as_str().map(str::to_owned);
        let call = match name {
            "run_powershell" => SystemCall::RunPowershell {
                script: s("script").ok_or_else(|| Error::Parse("Skript fehlt".into()))?,
                cwd: s("cwd"),
            },
            "git" => {
                let list: Vec<String> = args["args"]
                    .as_array()
                    .ok_or_else(|| Error::Parse("git-Argumente fehlen".into()))?
                    .iter()
                    .map(|a| {
                        a.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| Error::Parse("git-Argumente müssen Texte sein".into()))
                    })
                    .collect::<Result<_>>()?;
                let sub = list.first().map(String::as_str).unwrap_or("");
                if !GIT_ALLOWED.contains(&sub) {
                    return Err(Error::State(format!(
                        "Der git-Befehl „{sub}“ ist nicht erlaubt (nur lesende Befehle)"
                    )));
                }
                // Options that can execute programs or write files.
                if list.iter().any(|a| {
                    a.starts_with("--output")
                        || a.starts_with("--ext-diff")
                        || a.starts_with("--textconv")
                        || a.starts_with("-c")
                        || a.starts_with("--exec")
                }) {
                    return Err(Error::State("Diese git-Option ist nicht erlaubt".into()));
                }
                SystemCall::Git { args: list, repo: s("repo").ok_or_else(|| Error::Parse("Repository fehlt".into()))? }
            }
            "http_request" => {
                let method = s("method").unwrap_or_else(|| "GET".into()).to_uppercase();
                if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method.as_str()) {
                    return Err(Error::State(format!("Die HTTP-Methode {method} ist nicht erlaubt")));
                }
                let url = s("url").ok_or_else(|| Error::Parse("URL fehlt".into()))?;
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(Error::State("Nur http- und https-Adressen sind erlaubt".into()));
                }
                SystemCall::HttpRequest { method, url, body: args.get("body").filter(|b| !b.is_null()).cloned() }
            }
            other => return Err(Error::not_found("tool", other)),
        };
        Ok(call)
    }

    /// Re-applies the policy of [`from_tool_call`](Self::from_tool_call) to a call that
    /// arrived from elsewhere (e.g. deserialized from the UI).
    pub fn validate(&self) -> Result<()> {
        let (name, args) = match self {
            SystemCall::RunPowershell { script, cwd } => ("run_powershell", json!({ "script": script, "cwd": cwd })),
            SystemCall::Git { args, repo } => ("git", json!({ "args": args, "repo": repo })),
            SystemCall::HttpRequest { method, url, body } => {
                ("http_request", json!({ "method": method, "url": url, "body": body }))
            }
        };
        Self::from_tool_call(name, &args.to_string()).map(|_| ())
    }

    /// Human-readable summary for the approval dialog.
    pub fn describe(&self) -> String {
        match self {
            SystemCall::RunPowershell { script, cwd } => {
                format!("PowerShell{}:\n{script}", cwd.as_ref().map(|c| format!(" in {c}")).unwrap_or_default())
            }
            SystemCall::Git { args, repo } => format!("git {} (in {repo})", args.join(" ")),
            SystemCall::HttpRequest { method, url, .. } => format!("{method} {url}"),
        }
    }
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… [gekürzt]");
    }
    s
}

/// A system tool that runs longer than this is stopped.
const SYSTEM_TIMEOUT: Duration = Duration::from_secs(120);

/// Runs `cmd` (no stdin, no console window) and waits at most `timeout`.
fn output_within(mut cmd: Command, timeout: Duration) -> Result<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
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
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::State(format!(
                "Der Befehl hat nicht innerhalb von {} s geantwortet und wurde abgebrochen",
                timeout.as_secs().max(1)
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(std::process::Output {
        status,
        stdout: out_t.join().unwrap_or_default(),
        stderr: err_t.join().unwrap_or_default(),
    })
}

/// Runs `cmd` off the async runtime, with [`SYSTEM_TIMEOUT`].
async fn run(cmd: Command) -> Result<String> {
    let out = tokio::task::spawn_blocking(move || output_within(cmd, SYSTEM_TIMEOUT))
        .await
        .map_err(|e| Error::State(e.to_string()))??;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.stderr.is_empty() {
        s.push_str("\n[stderr]\n");
        s.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    s.push_str(&format!("\n[exit code: {}]", out.status.code().map_or("signal".into(), |c| c.to_string())));
    Ok(truncate(s))
}

/// The null device, for config and attribute files git must not read.
const NULL_FILE: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// `git` in `repo` with a neutral configuration: no system or global config, no pager,
/// no hooks, no fsmonitor, no external diff, no global attributes.
fn git_command(repo: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).arg("--no-pager");
    for c in [
        "core.fsmonitor=false".to_owned(),
        format!("core.hooksPath={NULL_FILE}"),
        format!("core.attributesFile={NULL_FILE}"),
        "core.pager=cat".to_owned(),
        "diff.external=".to_owned(),
        "core.sshCommand=".to_owned(),
        "protocol.allow=never".to_owned(),
    ] {
        cmd.arg("-c").arg(c);
    }
    cmd.env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", NULL_FILE)
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .env_remove("GIT_EXTERNAL_DIFF")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE");
    cmd
}

/// Repository settings that make git run programs (textconv and diff drivers, clean and
/// smudge filters, fsmonitor, aliases, includes that could add any of them).
pub fn dangerous_git_config(config_list: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in config_list.lines() {
        let key = line.split('=').next().unwrap_or("").trim().to_ascii_lowercase();
        let bad = (key.starts_with("diff.") && (key.ends_with(".textconv") || key.ends_with(".command")))
            || key.starts_with("filter.")
            || key.starts_with("include.")
            || key.starts_with("includeif.")
            || key.starts_with("alias.")
            || key.starts_with("pager.")
            || key.starts_with("gpg.")
            || matches!(
                key.as_str(),
                "core.fsmonitor"
                    | "core.hookspath"
                    | "core.pager"
                    | "core.sshcommand"
                    | "core.gitproxy"
                    | "diff.external"
            );
        // The neutral values this module sets itself are fine.
        let own =
            matches!(line.trim(), "core.fsmonitor=false" | "core.pager=cat" | "diff.external=" | "core.sshcommand=")
                || line.trim().eq_ignore_ascii_case(&format!("core.hookspath={NULL_FILE}"));
        if bad && !own && !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// Flags that keep diff-producing subcommands from running textconv or external diff programs.
fn safe_flags(sub: &str) -> &'static [&'static str] {
    match sub {
        "log" | "show" | "diff" => &["--no-textconv", "--no-ext-diff"],
        "blame" => &["--no-textconv"],
        _ => &[],
    }
}

/// Runs an allowed, read-only git command; refused when the repository's own settings could
/// start programs.
async fn run_git(args: &[String], repo: &str) -> Result<String> {
    let mut check = git_command(repo);
    check.args(["config", "--list", "--includes"]);
    let list = tokio::task::spawn_blocking(move || output_within(check, SYSTEM_TIMEOUT))
        .await
        .map_err(|e| Error::State(e.to_string()))??;
    let bad = dangerous_git_config(&String::from_utf8_lossy(&list.stdout));
    if !bad.is_empty() {
        return Err(Error::State(format!(
            "Das Repository enthält Git-Einstellungen, die Programme starten können ({}) – der Befehl wird nicht ausgeführt",
            bad.join(", ")
        )));
    }
    let mut cmd = git_command(repo);
    let (sub, rest) = args.split_first().ok_or_else(|| Error::Parse("git-Argumente fehlen".into()))?;
    cmd.arg(sub).args(safe_flags(sub)).args(rest);
    run(cmd).await
}

/// Runs an approved system call. Only call this after the user confirmed
/// exactly the call returned by [`SystemCall::describe`].
pub async fn execute_system_tool(call: &SystemCall, http: &reqwest::Client, timeout: Duration) -> Result<String> {
    call.validate()?;
    match call {
        SystemCall::RunPowershell { script, cwd } => {
            let exe = if cfg!(windows) { "powershell.exe" } else { "pwsh" };
            let mut cmd = Command::new(exe);
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            run(cmd).await
        }
        SystemCall::Git { args, repo } => run_git(args, repo).await,
        SystemCall::HttpRequest { method, url, body } => {
            let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| Error::Parse(e.to_string()))?;
            let mut req = http.request(method, url).timeout(timeout);
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send().await?;
            let status = resp.status();
            let text = resp.text().await?;
            Ok(truncate(format!("HTTP {status}\n{text}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_definition_is_classified() {
        for d in definitions() {
            let name = d["function"]["name"].as_str().unwrap();
            match classify(name) {
                Risk::Workspace => assert!(SystemCall::from_tool_call(name, "{}").is_err()),
                Risk::RequiresApproval => {}
            }
        }
    }

    #[test]
    fn allowed_tools_filter_definitions() {
        let allowed: Vec<String> = crate::prefs::WORKSPACE_TOOLS.iter().map(|s| (*s).to_owned()).collect();
        let names: Vec<String> =
            definitions_allowed(&allowed).iter().map(|d| d["function"]["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names.len(), allowed.len());
        assert!(!names.contains(&"git".to_owned()));
        assert!(check_allowed("git", &allowed).is_err());
        assert!(check_allowed("log_time", &allowed).is_ok());
    }

    #[test]
    fn activity_log_is_a_read_only_workspace_tool() {
        assert!(definitions().iter().any(|d| d["function"]["name"] == "activity_log"));
        assert_eq!(classify("activity_log"), Risk::Workspace);
    }

    #[test]
    fn time_summary_is_offered_as_workspace_tool() {
        assert!(definitions().iter().any(|d| d["function"]["name"] == "time_summary"));
        assert_eq!(classify("time_summary"), Risk::Workspace);
    }

    #[test]
    fn git_policy() {
        let ok = SystemCall::from_tool_call("git", r#"{"args":["log","--oneline","-5"],"repo":"C:/src/app"}"#).unwrap();
        assert_eq!(ok.describe(), "git log --oneline -5 (in C:/src/app)");
        assert!(SystemCall::from_tool_call("git", r#"{"args":["push","--force"],"repo":"."}"#).is_err());
        assert!(SystemCall::from_tool_call("git", r#"{"args":["diff","--ext-diff"],"repo":"."}"#).is_err());
        assert!(SystemCall::from_tool_call("git", r#"{"args":["log","-c","core.pager=evil"],"repo":"."}"#).is_err());
    }

    #[test]
    fn http_policy() {
        assert!(
            SystemCall::from_tool_call("http_request", r#"{"method":"get","url":"https://api.example.com"}"#).is_ok()
        );
        assert!(SystemCall::from_tool_call("http_request", r#"{"method":"GET","url":"file:///etc/passwd"}"#).is_err());
        assert!(SystemCall::from_tool_call("http_request", r#"{"method":"TRACE","url":"https://x"}"#).is_err());
        assert!(SystemCall::from_tool_call("rm_rf", "{}").is_err());
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        let s = truncate("ä".repeat(MAX_OUTPUT));
        assert!(s.ends_with("[gekürzt]"));
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn sh(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(["-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(ok.success(), "{args:?}");
    }

    /// A repository whose own config runs a program as textconv driver for every file.
    #[cfg(unix)]
    #[tokio::test]
    async fn git_tool_never_runs_repository_programs() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("annalo-evilrepo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        std::fs::write(dir.join(".gitattributes"), "* diff=pwn\n").unwrap();
        std::fs::write(dir.join("f.txt"), "a\n").unwrap();
        sh(&dir, &["add", "-A"]);
        sh(&dir, &["commit", "-q", "-m", "eins"]);
        let pwned = dir.join("PWNED");
        let textconv = format!("sh -c 'touch {}; cat \"$0\"'", pwned.display());
        sh(&dir, &["config", "diff.pwn.textconv", &textconv]);
        let repo = dir.display().to_string();
        let http = HttpClient::new();
        for args in [vec!["show", "HEAD"], vec!["log", "-p"], vec!["blame", "f.txt"], vec!["status"]] {
            let call = SystemCall::Git { args: args.iter().map(|s| s.to_string()).collect(), repo: repo.clone() };
            let err = execute_system_tool(&call, &http, Duration::from_secs(5)).await.unwrap_err().to_string();
            assert!(err.contains("diff.pwn.textconv"), "{err}");
        }
        assert!(!pwned.exists(), "textconv program ran");

        // Without the repository setting, the diff runs with textconv switched off.
        sh(&dir, &["config", "--unset", "diff.pwn.textconv"]);
        let call = SystemCall::Git { args: vec!["show".into(), "HEAD".into()], repo: repo.clone() };
        let out = execute_system_tool(&call, &http, Duration::from_secs(5)).await.unwrap();
        assert!(out.contains("+a") && out.contains("[exit code: 0]"), "{out}");
        sh(&dir, &["config", "core.fsmonitor", "touch /tmp/x"]);
        let call = SystemCall::Git { args: vec!["status".into()], repo };
        assert!(execute_system_tool(&call, &http, Duration::from_secs(5)).await.is_err());
        assert!(SystemCall::from_tool_call("git", r#"{"args":["diff","--textconv"],"repo":"."}"#).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn system_tools_time_out() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 5"]);
        let start = std::time::Instant::now();
        let err = output_within(cmd, Duration::from_millis(300)).unwrap_err().to_string();
        assert!(err.contains("abgebrochen"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn executor_rejects_calls_outside_policy() {
        let push = SystemCall::Git { args: vec!["push".into(), "--force".into()], repo: ".".into() };
        assert!(execute_system_tool(&push, &HttpClient::new(), Duration::from_secs(5)).await.is_err());
        let file = SystemCall::HttpRequest { method: "GET".into(), url: "file:///etc/passwd".into(), body: None };
        assert!(execute_system_tool(&file, &HttpClient::new(), Duration::from_secs(5)).await.is_err());
    }
}
