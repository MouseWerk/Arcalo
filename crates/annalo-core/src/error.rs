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

/// Errors cross the Tauri IPC boundary as plain strings.
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
