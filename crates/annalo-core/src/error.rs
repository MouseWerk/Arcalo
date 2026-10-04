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
    /// Another service (Jira, a calendar server) answered with an error; `message` is complete
    /// (what happened and how to fix it) and shown as it is.
    #[error("{message}")]
    Remote { status: u16, message: String },
}

impl Error {
    pub fn not_found(kind: &'static str, key: impl Into<String>) -> Self {
        Error::NotFound { kind, key: key.into() }
    }

    /// The database error of a write on a full disk (test hooks of the shell simulate it).
    pub fn disk_full() -> Self {
        let full = rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL);
        Error::Db(rusqlite::Error::SqliteFailure(full, None))
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
    with_details(what, e)
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
                "Der Datenträger ist voll – die Änderung wurde nicht gespeichert. Gib Speicherplatz frei \
                 (Papierkorb des Systems leeren, große Dateien löschen), dann versuche es noch einmal",
                "The disk is full – the change was not saved. Free some space (empty the system's trash, delete \
                 large files), then try again"
            )),
            C::ReadOnly => Some(tr!(
                "Die Datenbank ist schreibgeschützt. Prüfe, ob du im Datenordner schreiben darfst und der \
                 Datenträger nicht schreibgeschützt ist",
                "The database is read-only. Check that you may write to the data folder and that the disk \
                 is not write-protected"
            )),
            C::DatabaseBusy | C::DatabaseLocked => Some(tr!(
                "Die Datenbank ist gerade gesperrt, meist von einem Virenscanner oder einem Sync-Programm. \
                 Versuche es in einem Moment noch einmal",
                "The database is locked right now, usually by a virus scanner or a sync program. Try again \
                 in a moment"
            )),
            C::DatabaseCorrupt | C::NotADatabase => Some(tr!(
                "Die Datenbank ist beschädigt. Stelle unter Einstellungen → Sicherung eine Sicherung wieder her",
                "The database is damaged. Restore a backup under Settings → Backup"
            )),
            C::CannotOpen => Some(tr!(
                "Die Datenbank lässt sich nicht öffnen. Prüfe, ob der Datenordner erreichbar ist (Laufwerk \
                 verbunden, Rechte)",
                "The database cannot be opened. Check that the data folder can be reached (drive connected, \
                 permissions)"
            )),
            C::SystemIoFailure => Some(tr!(
                "Lese- oder Schreibfehler auf dem Datenträger. Prüfe das Laufwerk (Verbindung, Speicherplatz) \
                 und versuche es noch einmal",
                "Read or write error on the disk. Check the drive (connection, free space) and try again"
            )),
            _ => None,
        };
        if let Some(what) = what {
            return with_details(what, e);
        }
    }
    e.to_string()
}

/// Separates a message from its technical text (SQLite's or the operating system's English
/// words): the UI shows the message and keeps the rest behind „Details“ (see `errorParts` in
/// the UI), the log and the command line show both.
pub const DETAILS: &str = "\n\nDetails: ";

/// `what` with the technical text `tech` after [`DETAILS`].
pub fn with_details(what: &str, tech: impl std::fmt::Display) -> String {
    format!("{what}{DETAILS}{tech}")
}

/// Why a request failed, read from reqwest's error and its cause chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpCause {
    Timeout,
    /// The proxy cannot be reached or refuses the connection.
    Proxy,
    /// The server's certificate is not trusted (company CA missing, self-signed, pinned).
    Certificate,
    /// The server name cannot be resolved.
    Name,
    /// Nothing listens at the address.
    Refused,
    /// The connection broke off during the answer.
    Broken,
    /// No connection, cause unknown.
    Connect,
    Other,
}

/// reqwest's text with its whole cause chain (its own text is only „error sending request“).
pub fn http_chain(e: &reqwest::Error) -> String {
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
    chain
}

/// The likely cause of a failed request.
pub fn http_cause(e: &reqwest::Error) -> HttpCause {
    let lower = http_chain(e).to_lowercase();
    if e.is_timeout() || lower.contains("timed out") || lower.contains("deadline") {
        HttpCause::Timeout
    } else if lower.contains("proxy") || lower.contains("tunnel") {
        HttpCause::Proxy
    } else if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("tls") {
        HttpCause::Certificate
    } else if lower.contains("dns") || lower.contains("lookup") || lower.contains("resolve") {
        HttpCause::Name
    } else if lower.contains("connection refused") {
        HttpCause::Refused
    } else if e.is_body() || e.is_decode() || lower.contains("connection closed") || lower.contains("eof") {
        HttpCause::Broken
    } else if e.is_connect() {
        HttpCause::Connect
    } else {
        HttpCause::Other
    }
}

/// A request error with its whole cause chain and the likely cause in the display language.
pub fn http_text(e: &reqwest::Error) -> String {
    let chain = http_chain(e);
    let cause = match http_cause(e) {
        HttpCause::Timeout => tr!(
            "Zeitüberschreitung – der Server hat nicht rechtzeitig geantwortet",
            "Timed out – the server did not answer in time"
        ),
        HttpCause::Proxy => tr!(
            "Proxy nicht erreichbar oder er lehnt die Verbindung ab",
            "Proxy not reachable, or it refuses the connection"
        ),
        HttpCause::Certificate => tr!(
            "Das Zertifikat des Servers wird nicht anerkannt (Netzwerkeinstellungen: Zertifikate)",
            "The server's certificate is not trusted (network settings: certificates)"
        ),
        HttpCause::Name => tr!("Servername nicht gefunden", "Server name not found"),
        HttpCause::Refused => tr!(
            "Verbindung abgelehnt – läuft der Dienst unter dieser Adresse?",
            "Connection refused – is the service running at this address?"
        ),
        HttpCause::Broken => {
            tr!("Die Verbindung brach während der Antwort ab", "The connection broke off during the answer")
        }
        HttpCause::Connect => tr!("Keine Verbindung zum Server", "No connection to the server"),
        HttpCause::Other => return chain,
    };
    with_details(cause, chain)
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
        // Jira and calendar servers are not the AI server: their message stands alone.
        assert_eq!(Error::Remote { status: 401, message: "Jira lehnt ab".into() }.to_string(), "Jira lehnt ab");
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
            // Database errors say what to do as well.
            let full = Error::disk_full().to_string();
            assert!(full.contains("The disk is full – the change was not saved. Free some space"), "{full}");
            // SQLite's English text only after the separator the UI hides behind „Details“.
            let (text, tech) = full.split_once(DETAILS).unwrap();
            assert!(!text.contains("Error code") && tech.starts_with("Error code 13"), "{full}");
            assert!(Error::disk_full().is_storage());
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
