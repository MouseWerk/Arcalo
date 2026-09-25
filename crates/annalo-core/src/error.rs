use std::path::{Path, PathBuf};

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
    /// An I/O error of one file or folder: the message names it (see [`IoAt::at`]).
    #[error("{}", file_text(path, *dir, source))]
    File {
        path: PathBuf,
        /// The path is (or would be) a folder: „Ordner“ instead of „Datei“ in the message.
        dir: bool,
        source: std::io::Error,
    },
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

    /// An I/O error of `path`. Whether it is a folder is taken from the disk, or, for a path that
    /// does not exist, from the name (no extension: a folder). A file that is missing because its
    /// folder is names the folder.
    pub fn file(path: impl AsRef<Path>, source: std::io::Error) -> Self {
        let mut path = path.as_ref();
        if source.kind() == std::io::ErrorKind::NotFound {
            while let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty() && !p.exists()) {
                path = parent;
            }
        }
        let dir = path.is_dir() || (!path.exists() && path.extension().is_none());
        Error::File { path: path.to_path_buf(), dir, source }
    }

    /// The error with `path` attached when it is a bare I/O error (other errors stay as they are).
    pub fn with_path(self, path: impl AsRef<Path>) -> Self {
        match self {
            Error::Io(e) => Error::file(path, e),
            other => other,
        }
    }

    /// The text for the developer log: the message plus the operating system's own words.
    pub fn detail(&self) -> String {
        match self {
            Error::File { source, .. } => format!("{self} ({source})"),
            _ => self.to_string(),
        }
    }

    /// Whether the storage is the problem (read-only, full, cannot be opened), not the data.
    pub fn is_storage(&self) -> bool {
        use rusqlite::ErrorCode as C;
        match self {
            Error::Io(_) | Error::File { .. } => true,
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

/// An I/O error of one file or folder, short and with its path: „Datei nicht gefunden: C:\…\a.pdf“.
fn file_text(path: &Path, dir: bool, e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let p = path.display();
    let (noun, the) = if dir { ("Ordner", "den Ordner") } else { ("Datei", "die Datei") };
    // Windows reports a file open in another program as a sharing or lock violation.
    if cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 33)) {
        return format!("Die Datei ist in einem anderen Programm geöffnet: {p}");
    }
    match e.kind() {
        K::NotFound => format!("{noun} nicht gefunden: {p}"),
        K::PermissionDenied => format!("Keine Berechtigung für {the} {p}"),
        K::AlreadyExists => format!("{noun} existiert bereits: {p}"),
        K::StorageFull | K::QuotaExceeded => format!("Der Datenträger ist voll: {p}"),
        K::ReadOnlyFilesystem => format!("Der Datenträger ist schreibgeschützt: {p}"),
        K::IsADirectory => format!("Ein Ordner, keine Datei: {p}"),
        K::NotADirectory => format!("Kein Ordner, sondern eine Datei: {p}"),
        K::DirectoryNotEmpty => format!("Der Ordner ist nicht leer: {p}"),
        K::ResourceBusy => format!("{noun} wird von einem anderen Programm verwendet: {p}"),
        K::FileTooLarge => format!("Die Datei ist zu groß: {p}"),
        K::InvalidFilename => format!("Ungültiger Name: {p}"),
        K::CrossesDevices => format!("Verschieben auf ein anderes Laufwerk nicht möglich: {p}"),
        K::UnexpectedEof => format!("Die Datei ist unvollständig: {p}"),
        K::InvalidData => format!("Die Datei hat ein unerwartetes Format: {p}"),
        K::TimedOut => format!("Zeitüberschreitung bei {p}"),
        _ => format!("Dateifehler bei {p}: {e}"),
    }
}

/// Attaches the path to an I/O result: `fs::read(&p).at(&p)?`.
pub trait IoAt<T> {
    fn at(self, path: impl AsRef<Path>) -> Result<T>;
}

impl<T> IoAt<T> for std::io::Result<T> {
    fn at(self, path: impl AsRef<Path>) -> Result<T> {
        self.map_err(|e| Error::file(path, e))
    }
}

impl<T> IoAt<T> for Result<T> {
    fn at(self, path: impl AsRef<Path>) -> Result<T> {
        self.map_err(|e| e.with_path(path))
    }
}

/// Copies a file; an error names the side that failed (the source when it cannot be read,
/// else the target).
pub fn copy_file(from: &Path, to: &Path) -> Result<u64> {
    std::fs::copy(from, to).map_err(|e| Error::file(if std::fs::File::open(from).is_ok() { to } else { from }, e))
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

    #[test]
    fn file_errors_name_the_file_and_folder() {
        use std::io::ErrorKind as K;
        let root = std::env::temp_dir().join(format!("annalo-error-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("Angebot.pdf");
        let e = std::fs::read(&missing).at(&missing).unwrap_err();
        assert_eq!(e.to_string(), format!("Datei nicht gefunden: {}", missing.display()));
        assert!(e.is_storage());
        // The log keeps the operating system's text too.
        assert!(e.detail().starts_with(&e.to_string()) && e.detail().len() > e.to_string().len(), "{}", e.detail());
        let e = Error::file(&root, std::io::Error::from(K::PermissionDenied));
        assert_eq!(e.to_string(), format!("Keine Berechtigung für den Ordner {}", root.display()));
        let e = Error::file(root.join("neu"), std::io::Error::from(K::NotFound));
        assert!(e.to_string().starts_with("Ordner nicht gefunden: "), "{e}");
        // A file in a folder that is not there: the first missing folder is named.
        let e = Error::file(root.join("fehlt/tiefer/Seite.html"), std::io::Error::from(K::NotFound));
        assert_eq!(e.to_string(), format!("Ordner nicht gefunden: {}", root.join("fehlt").display()));
        let e = Error::from(std::io::Error::from(K::StorageFull)).with_path(&missing);
        assert_eq!(e.to_string(), format!("Der Datenträger ist voll: {}", missing.display()));
        // Other errors keep their text.
        assert_eq!(Error::State("x".into()).with_path(&missing).to_string(), "x");
        let r: Result<()> = Err(Error::from(std::io::Error::from(K::AlreadyExists)));
        assert!(r.at(&missing).unwrap_err().to_string().starts_with("Datei existiert bereits: "));
        let _ = std::fs::remove_dir_all(&root);
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
