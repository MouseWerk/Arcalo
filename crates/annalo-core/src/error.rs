use thiserror::Error;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not parse command: {0}")]
    Parse(String),
    #[error("{kind} '{key}' not found")]
    NotFound { kind: &'static str, key: String },
    #[error("invalid state: {0}")]
    State(String),
    #[error("AI provider error ({status}): {body}")]
    Provider { status: u16, body: String },
}

impl Error {
    pub fn not_found(kind: &'static str, key: impl Into<String>) -> Self {
        Error::NotFound { kind, key: key.into() }
    }
}

/// Called for every error serialized for the UI (the desktop shell writes it to its log).
static UI_HOOK: std::sync::OnceLock<fn(&Error)> = std::sync::OnceLock::new();

/// Installs [`UI_HOOK`]; only the first call counts.
pub fn set_ui_hook(hook: fn(&Error)) {
    let _ = UI_HOOK.set(hook);
}

/// Errors cross the Tauri IPC boundary as plain strings.
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        if let Some(hook) = UI_HOOK.get() {
            hook(self);
        }
        s.serialize_str(&self.to_string())
    }
}
