//! Outlook Classic through its COM object model: the bundled PowerShell scripts (calendar in
//! [`crate::calsync::outlook`], mail in [`crate::mail::outlook`]) are written to
//! `<data>/scripts` when they differ and run hidden, as the user, with a timeout. They print one
//! line of ASCII JSON (`{"ok":true,…}` or `{"ok":false,"error":"<code>","message":"…"}`); the
//! callers turn error codes into their own German messages.
//!
//! Blocking: run it off the async runtime.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::error::{Error, Result};

/// A bundled script: its file name in the data folder and its text (ASCII, see the scripts).
#[derive(Debug, Clone, Copy)]
pub struct Script {
    pub file: &'static str,
    pub source: &'static str,
}

/// `powershell.exe` of the system (never one found first on the PATH).
fn powershell() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

/// Writes `script` to `script_dir` when the file there differs, returns its path.
pub fn write_script(script_dir: &Path, script: Script) -> Result<PathBuf> {
    std::fs::create_dir_all(script_dir)?;
    let path = script_dir.join(script.file);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(script.source) {
        std::fs::write(&path, script.source)?;
    }
    Ok(path)
}

/// Runs `script` with `args` (hidden window, no profile, bypassing the execution policy for this
/// one file) and returns its standard output. `retry` ends the timeout message („Später erneut
/// synchronisieren.“).
pub fn run(script_dir: &Path, script: Script, args: &[OsString], timeout: Duration, retry: &str) -> Result<String> {
    if !cfg!(windows) {
        return Err(Error::State("Outlook (klassisch) gibt es nur unter Windows.".into()));
    }
    let path = write_script(script_dir, script)?;
    let mut cmd = std::process::Command::new(powershell());
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
        .arg(&path)
        .args(args);
    let started = Instant::now();
    let out = match crate::ai::tools::output_within(cmd, timeout) {
        Ok(o) => o,
        Err(_) if started.elapsed() >= timeout => {
            return Err(Error::State(format!(
                "Outlook hat nicht innerhalb von {} geantwortet. Vielleicht wartet Outlook auf eine Bestätigung \
                 („Ein Programm versucht, auf E-Mail-Adressinformationen zuzugreifen“ – dort den Zugriff erlauben) oder \
                 startet gerade noch. {retry}",
                minutes(timeout)
            )));
        }
        Err(e) => return Err(Error::State(format!("PowerShell ließ sich nicht starten: {e}"))),
    };
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if stdout.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err: String = err.trim().chars().take(300).collect();
        return Err(Error::State(format!(
            "Das Outlook-Skript lieferte kein Ergebnis{}",
            if err.is_empty() { String::new() } else { format!(": {err}") }
        )));
    }
    Ok(stdout)
}

fn minutes(d: Duration) -> String {
    match d.as_secs() {
        s if s >= 120 && s % 60 == 0 => format!("{} Minuten", s / 60),
        60 => "einer Minute".into(),
        s => format!("{s} Sekunden"),
    }
}

/// The JSON object of a script's output: from the first line that starts one (PowerShell may
/// print warnings before it), a byte order mark ignored.
pub fn json(text: &str) -> Result<Value> {
    let text = text.trim_start_matches('\u{feff}');
    let mut first_err = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.trim_start().starts_with('{') {
            match serde_json::from_str(text[offset..].trim()) {
                Ok(v) => return Ok(v),
                Err(e) => {
                    first_err.get_or_insert(e.to_string());
                }
            }
        }
        offset += line.len();
    }
    Err(Error::State(format!(
        "Die Antwort des Outlook-Skripts ist unlesbar ({})",
        first_err.unwrap_or_else(|| "kein JSON".into())
    )))
}

/// `(code, message)` of an output with `"ok": false`.
pub fn failure(v: &Value) -> Option<(String, String)> {
    (!truthy(&v["ok"])).then(|| (text(v, "error"), text(v, "message")))
}

/// A string field (numbers as text), trimmed; empty when missing.
pub fn text(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// `true`, a non-zero number or `"True"` (PowerShell writes some booleans as strings).
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        Value::String(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "wahr"),
        _ => false,
    }
}

/// An integer field (also from a string or a boolean); 0 when missing.
pub fn int(v: &Value, k: &str) -> i64 {
    match &v[k] {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Value::String(s) => s.trim().parse().unwrap_or(0),
        Value::Bool(b) => *b as i64,
        _ => 0,
    }
}

/// A list: a JSON array, or one string split at `seps` (a single value PowerShell unrolled).
pub fn list(v: &Value, k: &str, seps: &[char]) -> Vec<String> {
    let mut out: Vec<String> = match &v[k] {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_owned()).collect(),
        Value::String(s) => s.split(seps).map(|x| x.trim().to_owned()).collect(),
        _ => vec![],
    };
    out.retain(|x| !x.is_empty());
    out.dedup();
    out
}

/// The items of an output: an array, or one object PowerShell did not wrap.
pub fn items(v: &Value, k: &str) -> Vec<Value> {
    match &v[k] {
        Value::Array(a) => a.clone(),
        Value::Object(_) => vec![v[k].clone()],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_is_found_after_noise_and_fields_are_lenient() {
        let v = json("\u{feff}WARNING: x\r\n{\"ok\":\"True\",\"n\":\"4\",\"l\":\"a; b;a\",\"o\":{\"x\":1}}").unwrap();
        assert!(failure(&v).is_none());
        assert_eq!(int(&v, "n"), 4);
        assert_eq!(list(&v, "l", &[';']), ["a", "b", "a"]);
        assert_eq!(items(&v, "o").len(), 1);
        assert_eq!(items(&v, "missing").len(), 0);
        let v = json(r#"{"ok":false,"error":"com","message":" 0x80 "}"#).unwrap();
        assert_eq!(failure(&v), Some(("com".into(), "0x80".into())));
        assert!(json("nichts").unwrap_err().to_string().contains("unlesbar"));
    }

    #[test]
    fn timeouts_read_naturally() {
        assert_eq!(minutes(Duration::from_secs(120)), "2 Minuten");
        assert_eq!(minutes(Duration::from_secs(60)), "einer Minute");
        assert_eq!(minutes(Duration::from_secs(45)), "45 Sekunden");
    }
}
