use thiserror::Error;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Every message is German and complete: it reaches the UI as it is (errors cross the IPC
/// boundary as their `Display` text), so re-wrapping one in [`Error::State`] adds no prefix.
#[derive(Debug, Error)]
pub enum Error {
    #[error("Datenbankfehler: {}", db_text(.0))]
    Db(#[from] rusqlite::Error),
    #[error("Ungültige Daten: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Verbindungsfehler: {}", http_text(.0))]
    Http(#[from] reqwest::Error),
    #[error("Dateifehler: {}", io_text(.0))]
    Io(#[from] std::io::Error),
    #[error("Eingabe nicht verstanden: {0}")]
    Parse(String),
    #[error("{} „{key}“ nicht gefunden", kind_name(kind))]
    NotFound { kind: &'static str, key: String },
    #[error("{0}")]
    State(String),
    #[error("KI-Server meldet Fehler {status}: {body}")]
    Provider { status: u16, body: String },
}

impl Error {
    pub fn not_found(kind: &'static str, key: impl Into<String>) -> Self {
        Error::NotFound { kind, key: key.into() }
    }

    /// Whether the storage is the problem (read-only, full, cannot be opened), not the data.
    pub fn is_storage(&self) -> bool {
        use rusqlite::ErrorCode as C;
        match self {
            Error::Io(_) => true,
            Error::Db(rusqlite::Error::SqliteFailure(f, _)) => {
                matches!(f.code, C::ReadOnly | C::CannotOpen | C::DiskFull | C::PermissionDenied)
            }
            _ => false,
        }
    }
}

/// The German noun for a [`Error::NotFound`] kind.
fn kind_name(kind: &str) -> &str {
    match kind {
        "netzplan" => "Netzplan",
        "vorgang" => "Vorgang",
        "leistungsart" => "Leistungsart",
        "page" => "Seite",
        "project" => "Projekt",
        "task" => "Aufgabe",
        "tool" => "Werkzeug",
        "entry" => "Eintrag",
        "backup" => "Sicherung",
        "version" => "Version",
        "attachment" => "Anhang",
        "link" => "Link",
        other => other,
    }
}

/// An I/O error in plain German (the OS text names no cause a user can act on).
pub fn io_text(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let what = match e.kind() {
        K::NotFound => "Datei oder Ordner nicht gefunden",
        K::PermissionDenied => "Zugriff verweigert (fehlende Berechtigung oder schreibgeschützt)",
        K::AlreadyExists => "Die Datei existiert bereits",
        K::StorageFull | K::QuotaExceeded => "Der Datenträger ist voll",
        K::ReadOnlyFilesystem => "Der Datenträger ist schreibgeschützt",
        K::IsADirectory => "Ein Ordner wurde erwartet, eine Datei gefunden",
        K::NotADirectory => "Ein Ordner wurde erwartet, aber es ist eine Datei",
        K::DirectoryNotEmpty => "Der Ordner ist nicht leer",
        K::ResourceBusy => "Die Datei wird von einem anderen Programm verwendet",
        K::FileTooLarge => "Die Datei ist zu groß",
        K::InvalidFilename => "Ungültiger Dateiname",
        K::TimedOut => "Zeitüberschreitung",
        K::Interrupted => "Vorgang unterbrochen",
        K::UnexpectedEof => "Die Datei endet unerwartet (unvollständig?)",
        K::InvalidData => "Die Datei hat ein unerwartetes Format",
        K::CrossesDevices => "Verschieben zwischen Laufwerken nicht möglich",
        _ => return e.to_string(),
    };
    format!("{what} ({e})")
}

/// A SQLite error with the causes a user can do something about named in German.
fn db_text(e: &rusqlite::Error) -> String {
    use rusqlite::ErrorCode as C;
    if let rusqlite::Error::SqliteFailure(f, _) = e {
        let what = match f.code {
            C::DiskFull => Some("Der Datenträger ist voll – die Änderung wurde nicht gespeichert"),
            C::ReadOnly => Some("Die Datenbank ist schreibgeschützt"),
            C::DatabaseBusy | C::DatabaseLocked => Some("Die Datenbank ist gerade gesperrt"),
            C::DatabaseCorrupt | C::NotADatabase => Some("Die Datenbank ist beschädigt"),
            C::CannotOpen => Some("Die Datenbank lässt sich nicht öffnen"),
            C::SystemIoFailure => Some("Lese- oder Schreibfehler auf dem Datenträger"),
            _ => None,
        };
        if let Some(what) = what {
            return format!("{what} ({e})");
        }
    }
    e.to_string()
}

/// A request error with its whole cause chain (reqwest's own text is only „error sending
/// request“) and the likely cause in German.
pub fn http_text(e: &reqwest::Error) -> String {
    let mut chain = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let text = s.to_string();
        if !chain.contains(&text) {
            chain.push_str(": ");
            chain.push_str(&text);
        }
        source = s.source();
    }
    let lower = chain.to_lowercase();
    let cause = if e.is_timeout() || lower.contains("timed out") || lower.contains("deadline") {
        "Zeitüberschreitung – der Server hat nicht rechtzeitig geantwortet"
    } else if lower.contains("proxy") || lower.contains("tunnel") {
        "Proxy nicht erreichbar oder er lehnt die Verbindung ab"
    } else if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("tls") {
        "Das Zertifikat des Servers wird nicht anerkannt (Netzwerkeinstellungen: Zertifikate)"
    } else if lower.contains("dns") || lower.contains("lookup") || lower.contains("resolve") {
        "Servername nicht gefunden"
    } else if lower.contains("connection refused") {
        "Verbindung abgelehnt – läuft der Dienst unter dieser Adresse?"
    } else if e.is_body() || e.is_decode() || lower.contains("connection closed") || lower.contains("eof") {
        "Die Verbindung brach während der Antwort ab"
    } else if e.is_connect() {
        "Keine Verbindung zum Server"
    } else {
        return chain;
    };
    format!("{cause} ({chain})")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_german_and_wrap_without_prefixes() {
        let inner = Error::State("Kein Netz".into());
        assert_eq!(Error::State(inner.to_string()).to_string(), "Kein Netz");
        let io = Error::from(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(io.to_string().starts_with("Dateifehler: Datei oder Ordner nicht gefunden"), "{io}");
        let full = Error::from(std::io::Error::from(std::io::ErrorKind::StorageFull));
        assert!(full.to_string().contains("Datenträger ist voll"));
        assert_eq!(Error::Parse("x".into()).to_string(), "Eingabe nicht verstanden: x");
        assert_eq!(Error::Provider { status: 500, body: "b".into() }.to_string(), "KI-Server meldet Fehler 500: b");
    }

    #[tokio::test]
    async fn http_errors_keep_their_cause() {
        // Nothing listens on port 9 of localhost: the connection is refused.
        let e = reqwest::Client::new().get("http://127.0.0.1:9/").send().await.unwrap_err();
        let text = Error::from(e).to_string();
        assert!(text.starts_with("Verbindungsfehler: "), "{text}");
        assert!(text.contains("abgelehnt") || text.contains("Keine Verbindung"), "{text}");
        assert!(text.len() > "Verbindungsfehler: error sending request".len(), "{text}");
    }
}
