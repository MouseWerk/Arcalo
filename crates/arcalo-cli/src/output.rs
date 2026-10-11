//! What the command line prints: text for people, or with `--json` one JSON value per command on
//! stdout (shapes in docs/cli.md); errors on stderr with a stable exit code ([`Failure`]).

use std::process::ExitCode;

use arcalo_core::{Error, tr};
use serde::Serialize;

use crate::model::PageOut;

/// Why a command failed, with its exit code and the `code` of the JSON error object.
#[derive(Debug)]
pub enum Failure {
    /// A wrong command line or input (exit 1).
    Usage(String),
    /// A page reference that fits several pages (exit 1): the matches are listed.
    Ambiguous { message: String, matches: Vec<PageOut> },
    /// What was named does not exist (exit 2).
    NotFound(String),
    /// The workspace refused the change in its current state: a title taken, a task changed
    /// meanwhile, a running or exported booking (exit 3).
    Conflict(String),
    /// The database is busy beyond the wait (the app holds a long write) (exit 3).
    Locked(String),
    /// Anything else: storage, an encrypted workspace without its key, … (exit 4).
    Other(String),
}

pub type Outcome<T> = std::result::Result<T, Failure>;

impl Failure {
    pub fn exit_code(&self) -> u8 {
        match self {
            Failure::Usage(_) | Failure::Ambiguous { .. } => 1,
            Failure::NotFound(_) => 2,
            Failure::Conflict(_) | Failure::Locked(_) => 3,
            Failure::Other(_) => 4,
        }
    }

    /// The stable `code` of the JSON error object.
    pub fn code(&self) -> &'static str {
        match self {
            Failure::Usage(_) => "usage",
            Failure::Ambiguous { .. } => "ambiguous",
            Failure::NotFound(_) => "not_found",
            Failure::Conflict(_) => "conflict",
            Failure::Locked(_) => "locked",
            Failure::Other(_) => "error",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Failure::Usage(m)
            | Failure::NotFound(m)
            | Failure::Conflict(m)
            | Failure::Locked(m)
            | Failure::Other(m)
            | Failure::Ambiguous { message: m, .. } => m,
        }
    }
}

impl From<Error> for Failure {
    fn from(e: Error) -> Self {
        let text = e.to_string();
        match &e {
            Error::NotFound { .. } => Failure::NotFound(text),
            Error::Parse(_) => Failure::Usage(text),
            Error::State(_) => Failure::Conflict(text),
            _ if e.is_busy() => Failure::Locked(text),
            _ => Failure::Other(text),
        }
    }
}

impl From<serde_json::Error> for Failure {
    fn from(e: serde_json::Error) -> Self {
        Failure::from(Error::from(e))
    }
}

impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        Failure::from(Error::from(e))
    }
}

/// Text or JSON.
#[derive(Debug, Clone, Copy)]
pub struct Out {
    pub json: bool,
}

impl Out {
    /// Prints `value` as JSON (with `--json`), else the text `text` makes of it.
    pub fn show<T: Serialize>(&self, value: &T, text: impl FnOnce(&T) -> String) -> Outcome<()> {
        if self.json {
            println!("{}", serde_json::to_string_pretty(value)?);
        } else {
            let t = text(value);
            if !t.is_empty() {
                println!("{}", t.trim_end_matches('\n'));
            }
        }
        Ok(())
    }

    /// A failure on stderr: `Fehler: …` in the display language, or the JSON error object.
    pub fn fail(&self, f: &Failure) -> ExitCode {
        if self.json {
            let mut err = serde_json::json!({ "code": f.code(), "message": f.message(), "exit_code": f.exit_code() });
            if let Failure::Ambiguous { matches, .. } = f {
                err["matches"] = serde_json::to_value(matches).unwrap_or_default();
            }
            eprintln!("{}", serde_json::json!({ "error": err }));
        } else {
            eprintln!("{}: {}", tr!("Fehler", "Error"), f.message());
            if let Failure::Ambiguous { matches, .. } = f {
                for p in matches {
                    eprintln!("  id:{}  {}", p.id, p.path);
                }
            }
        }
        ExitCode::from(f.exit_code())
    }
}
