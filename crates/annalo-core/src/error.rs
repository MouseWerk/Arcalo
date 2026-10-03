use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{tr, trf};

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Every message is complete and in the display language ([`crate::i18n`]): it reaches the UI
/// as it is (errors cross the IPC boundary as their `Display` text), so re-wrapping one in
/// [`Error::State`] adds no prefix.
#[derive(Debug, Error)]
pub enum Error {
    #[error("{}: {}", tr!("Datenbankfehler", "Database error"), db_text(.0))]
    Db(#[from] rusqlite::Error),
    #[error("{}: {}", tr!("Ungültige Daten", "Invalid data"), .0)]
    Json(#[from] serde_json::Error),
    #[error("{}: {}", tr!("Verbindungsfehler", "Connection error"), http_text(.0))]
    Http(#[from] reqwest::Error),
    #[error("{}: {}", tr!("Dateifehler", "File error"), io_text(.0))]
    Io(#[from] std::io::Error),
    /// An I/O error of one file or folder: the message names it (see [`IoAt::at`]).
    #[error("{}", file_text(path, *dir, source))]
    File {
        path: PathBuf,
        /// The path is (or would be) a folder: „Ordner“ instead of „Datei“ in the message.
        dir: bool,
        source: std::io::Error,
    },
    #[error("{}: {}", tr!("Eingabe nicht verstanden", "Input not understood"), .0)]
    Parse(String),
    #[error("{}", not_found_text(kind, key))]
    NotFound { kind: &'static str, key: String },
    #[error("{0}")]
    State(String),
    #[error("{}", trf!("KI-Server meldet Fehler {status}: {body}", "The AI server reports error {status}: {body}"))]
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

/// „Seite „X“ nicht gefunden“ / “Page “X” not found” for a [`Error::NotFound`] kind.
fn not_found_text(kind: &str, key: &str) -> String {
    let (de, en) = match kind {
        "netzplan" => ("Netzplan", "Network"),
        "vorgang" => ("Vorgang", "Activity"),
        "leistungsart" => ("Leistungsart", "Activity type"),
        "page" => ("Seite", "Page"),
        "project" => ("Projekt", "Project"),
        "task" => ("Aufgabe", "Task"),
        "tool" => ("Werkzeug", "Tool"),
        "entry" => ("Eintrag", "Entry"),
        "backup" => ("Sicherung", "Backup"),
        "version" => ("Version", "Version"),
        "attachment" => ("Anhang", "Attachment"),
        "calendar" => ("Kalender", "Calendar"),
        "drawing" => ("Zeichnung", "Drawing"),
        "trashed_file" => ("Datei im Papierkorb", "File in the trash"),
        "link" => ("Link", "Link"),
        other => (other, other),
    };
    trf!("{de} „{key}“ nicht gefunden", "{en} “{key}” not found")
}

/// An I/O error in plain words (the OS text names no cause a user can act on).
pub fn io_text(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let what = match e.kind() {
        K::NotFound => tr!("Datei oder Ordner nicht gefunden", "File or folder not found"),
        K::PermissionDenied => tr!(
            "Zugriff verweigert (fehlende Berechtigung oder schreibgeschützt)",
            "Access denied (missing permission or read-only)"
        ),
        K::AlreadyExists => tr!("Die Datei existiert bereits", "The file already exists"),
        K::StorageFull | K::QuotaExceeded => tr!("Der Datenträger ist voll", "The disk is full"),
        K::ReadOnlyFilesystem => tr!("Der Datenträger ist schreibgeschützt", "The disk is read-only"),
        K::IsADirectory => {
            tr!("Eine Datei wurde erwartet, aber es ist ein Ordner", "A file was expected, a folder was found")
        }
        K::NotADirectory => {
            tr!("Ein Ordner wurde erwartet, aber es ist eine Datei", "A folder was expected, but it is a file")
        }
        K::DirectoryNotEmpty => tr!("Der Ordner ist nicht leer", "The folder is not empty"),
        K::ResourceBusy => {
            tr!("Die Datei wird von einem anderen Programm verwendet", "The file is in use by another program")
        }
        K::FileTooLarge => tr!("Die Datei ist zu groß", "The file is too large"),
        K::InvalidFilename => tr!("Ungültiger Dateiname", "Invalid file name"),
        K::TimedOut => tr!("Zeitüberschreitung", "Timed out"),
        K::Interrupted => tr!("Vorgang unterbrochen", "Operation interrupted"),
        K::UnexpectedEof => {
            tr!("Die Datei endet unerwartet (unvollständig?)", "The file ends unexpectedly (incomplete?)")
        }
        K::InvalidData => tr!("Die Datei hat ein unerwartetes Format", "The file has an unexpected format"),
        K::CrossesDevices => tr!("Verschieben zwischen Laufwerken nicht möglich", "Cannot move between drives"),
        _ => return e.to_string(),
    };
    format!("{what} ({e})")
}

/// An I/O error of one file or folder, short and with its path: „Datei nicht gefunden: C:\…\a.pdf“.
fn file_text(path: &Path, dir: bool, e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let p = path.display();
    let (noun, the) = match (dir, crate::i18n::is_en()) {
        (true, false) => ("Ordner", "den Ordner"),
        (false, false) => ("Datei", "die Datei"),
        (true, true) => ("Folder", "the folder"),
        (false, true) => ("File", "the file"),
    };
    // Windows reports a file open in another program as a sharing or lock violation.
    if cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 33)) {
        return trf!(
            "Die Datei ist in einem anderen Programm geöffnet: {p}",
            "The file is open in another program: {p}"
        );
    }
    match e.kind() {
        K::NotFound => trf!("{noun} nicht gefunden: {p}", "{noun} not found: {p}"),
        K::PermissionDenied => trf!("Keine Berechtigung für {the} {p}", "No permission for {the} {p}"),
        K::AlreadyExists => trf!("{noun} existiert bereits: {p}", "{noun} already exists: {p}"),
        K::StorageFull | K::QuotaExceeded => trf!("Der Datenträger ist voll: {p}", "The disk is full: {p}"),
        K::ReadOnlyFilesystem => trf!("Der Datenträger ist schreibgeschützt: {p}", "The disk is read-only: {p}"),
        K::IsADirectory => trf!("Ein Ordner, keine Datei: {p}", "A folder, not a file: {p}"),
        K::NotADirectory => trf!("Kein Ordner, sondern eine Datei: {p}", "Not a folder but a file: {p}"),
        K::DirectoryNotEmpty => trf!("Der Ordner ist nicht leer: {p}", "The folder is not empty: {p}"),
        K::ResourceBusy => {
            trf!("{noun} wird von einem anderen Programm verwendet: {p}", "{noun} is in use by another program: {p}")
        }
        K::FileTooLarge => trf!("Die Datei ist zu groß: {p}", "The file is too large: {p}"),
        K::InvalidFilename => trf!("Ungültiger Name: {p}", "Invalid name: {p}"),
        K::CrossesDevices => {
            trf!("Verschieben auf ein anderes Laufwerk nicht möglich: {p}", "Cannot move to another drive: {p}")
        }
        K::UnexpectedEof => trf!("Die Datei ist unvollständig: {p}", "The file is incomplete: {p}"),
        K::InvalidData => trf!("Die Datei hat ein unerwartetes Format: {p}", "The file has an unexpected format: {p}"),
        K::TimedOut => trf!("Zeitüberschreitung bei {p}", "Timed out at {p}"),
        _ => trf!("Dateifehler bei {p}: {e}", "File error at {p}: {e}"),
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
            C::DiskFull => Some(tr!(
                "Der Datenträger ist voll – die Änderung wurde nicht gespeichert",
                "The disk is full – the change was not saved"
            )),
            C::ReadOnly => Some(tr!("Die Datenbank ist schreibgeschützt", "The database is read-only")),
            C::DatabaseBusy | C::DatabaseLocked => {
                Some(tr!("Die Datenbank ist gerade gesperrt", "The database is locked right now"))
            }
            C::DatabaseCorrupt | C::NotADatabase => {
                Some(tr!("Die Datenbank ist beschädigt", "The database is damaged"))
            }
            C::CannotOpen => Some(tr!("Die Datenbank lässt sich nicht öffnen", "The database cannot be opened")),
            C::SystemIoFailure => {
                Some(tr!("Lese- oder Schreibfehler auf dem Datenträger", "Read or write error on the disk"))
            }
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
        tr!(
            "Zeitüberschreitung – der Server hat nicht rechtzeitig geantwortet",
            "Timed out – the server did not answer in time"
        )
    } else if lower.contains("proxy") || lower.contains("tunnel") {
        tr!(
            "Proxy nicht erreichbar oder er lehnt die Verbindung ab",
            "Proxy not reachable, or it refuses the connection"
        )
    } else if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("tls") {
        tr!(
            "Das Zertifikat des Servers wird nicht anerkannt (Netzwerkeinstellungen: Zertifikate)",
            "The server's certificate is not trusted (network settings: certificates)"
        )
    } else if lower.contains("dns") || lower.contains("lookup") || lower.contains("resolve") {
        tr!("Servername nicht gefunden", "Server name not found")
    } else if lower.contains("connection refused") {
        tr!(
            "Verbindung abgelehnt – läuft der Dienst unter dieser Adresse?",
            "Connection refused – is the service running at this address?"
        )
    } else if e.is_body() || e.is_decode() || lower.contains("connection closed") || lower.contains("eof") {
        tr!("Die Verbindung brach während der Antwort ab", "The connection broke off during the answer")
    } else if e.is_connect() {
        tr!("Keine Verbindung zum Server", "No connection to the server")
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
    fn messages_follow_the_display_language() {
        use crate::i18n::with_lang;
        use crate::prefs::Language::En;
        use std::io::ErrorKind as K;
        with_lang(En, || {
            assert_eq!(Error::Parse("x".into()).to_string(), "Input not understood: x");
            assert_eq!(Error::not_found("page", "Plan").to_string(), "Page “Plan” not found");
            assert_eq!(
                Error::Provider { status: 500, body: "b".into() }.to_string(),
                "The AI server reports error 500: b"
            );
            let io = Error::from(std::io::Error::from(K::StorageFull));
            assert!(io.to_string().starts_with("File error: The disk is full"), "{io}");
            let p = std::path::Path::new("/nowhere/a.pdf");
            let e = Error::File { path: p.to_path_buf(), dir: false, source: std::io::Error::from(K::NotFound) };
            assert_eq!(e.to_string(), format!("File not found: {}", p.display()));
            let e = Error::File { path: p.to_path_buf(), dir: true, source: std::io::Error::from(K::PermissionDenied) };
            assert_eq!(e.to_string(), format!("No permission for the folder {}", p.display()));
        });
        assert_eq!(Error::not_found("page", "Plan").to_string(), "Seite „Plan“ nicht gefunden");
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
