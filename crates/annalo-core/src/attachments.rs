//! Attachments (pasted screenshots, imported vault images, drawings, dropped files): plain
//! files in `<data_dir>/attachments/`, referenced from Markdown as `![[name.png]]`
//! (Obsidian embed syntax). New images get content-hash names, so pasting the
//! same image twice stores it once. Drawings are `name.excalidraw` scenes with a
//! `name.excalidraw.svg` preview next to them (see [`crate::drawings`]). Other files
//! (PDF, Office documents, archives, …) keep their sanitized name; `Angebot 2.pdf` when an
//! `Angebot.pdf` with other content exists.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, IoAt, Result};

/// Folder below the data directory (and in exported vaults).
pub const DIR_NAME: &str = "attachments";

/// Image types embedded as `![[…]]` and shown as images.
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Excalidraw scenes, embedded as `![[name.excalidraw]]` (Obsidian Excalidraw plugin).
pub const DRAWING_EXTENSION: &str = "excalidraw";

/// Upper bound for one image (sent base64 through IPC) or drawing.
pub const MAX_BYTES: usize = 50 * 1024 * 1024;

/// Upper bound for other files (copied by path or sent as raw bytes).
pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Longest stored file name (bytes), well below every file system's limit.
const MAX_NAME: usize = 150;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedAttachment {
    /// File name inside the attachments folder.
    pub name: String,
    pub path: String,
    pub size: u64,
    /// `![[name]]`, ready to insert into a note.
    pub markdown: String,
}

/// `<data_dir>/attachments`.
pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME)
}

/// Lower-case extension if it is a supported image type.
pub fn image_extension(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// A drawing scene (`.excalidraw`, any case).
pub fn is_drawing(name: &str) -> bool {
    Path::new(name).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(DRAWING_EXTENSION))
}

/// Lower-case extension of a name that `![[…]]` embeds as a file: 1 to 10 ASCII letters or
/// digits with at least one letter, not `md`. So `![[Notiz]]`, `![[Version 1.2]]` and
/// `![[x.md]]` stay notes. The UI uses the same rule (`ui/src/editor/fileEmbed.ts`).
pub fn file_extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    let ok = !stem.is_empty()
        && (1..=10).contains(&ext.len())
        && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        && ext.bytes().any(|b| b.is_ascii_alphabetic())
        && !ext.eq_ignore_ascii_case("md");
    ok.then(|| ext.to_ascii_lowercase())
}

/// Files that `![[name]]` embeds instead of linking a page: images, drawings, PDFs and any
/// other file with an extension (see [`file_extension`]).
pub fn embeddable(name: &str) -> bool {
    file_extension(name).is_some()
}

/// Programs and scripts the system would run instead of showing (`Öffnen` shows them in the
/// file manager instead, so a click on an attachment never starts a program).
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "msi",
    "msp",
    "scr",
    "pif",
    "cpl",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "hta",
    "lnk",
    "reg",
    "jar",
    "sh",
    "bash",
    "command",
    "app",
    "appimage",
    "run",
    "desktop",
    "url",
    "scf",
    "application",
    "gadget",
    "msc",
    "inf",
    "dll",
    "sys",
    "py",
    "pyw",
    "pl",
    "rb",
];

/// Whether opening `name` with the default app could run code.
pub fn is_executable(name: &str) -> bool {
    file_extension(name).is_some_and(|e| EXECUTABLE_EXTENSIONS.contains(&e.as_str()))
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    Some(match mime.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => return None,
    })
}

/// MIME type served for an attachment file name. Only types the webview shows inline get
/// their own type; everything else (HTML included) is served as a download.
pub fn mime_for(name: &str) -> &'static str {
    if is_drawing(name) {
        return "application/json";
    }
    match file_extension(name).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Stores `bytes` as `<sha256 prefix>.<ext>`; the extension comes from `name`, else from `mime`.
pub fn save(attachments_dir: &Path, bytes: &[u8], name: &str, mime: &str) -> Result<SavedAttachment> {
    if bytes.is_empty() {
        return Err(Error::State("Leere Datei".into()));
    }
    if bytes.len() > MAX_BYTES {
        return Err(Error::State(format!("Datei ist größer als {} MB", MAX_BYTES / 1024 / 1024)));
    }
    let ext = image_extension(name)
        .or_else(|| ext_for_mime(mime).map(str::to_owned))
        .ok_or_else(|| Error::State(format!("„{name}“ ist kein unterstütztes Bildformat")))?;
    let file = format!("{}.{ext}", &sha256_hex(bytes)[..16]);
    fs::create_dir_all(attachments_dir).at(attachments_dir)?;
    let path = attachments_dir.join(&file);
    if !path.is_file() {
        // Write-then-rename so a crash never leaves a truncated file under the final name.
        let tmp = attachments_dir.join(format!(".{file}.tmp"));
        fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, &path)).at(&path)?;
    }
    Ok(SavedAttachment {
        markdown: format!("![[{file}]]"),
        path: path.display().to_string(),
        size: bytes.len() as u64,
        name: file,
    })
}

/// Turns a dropped file's name into a safe attachment name: the last path component, with
/// reserved and control characters replaced by `-`, no leading dots or spaces, no trailing
/// dots or spaces (Windows), device names (`CON.pdf`) suffixed with `_`, at most [`MAX_NAME`]
/// bytes with the extension kept. Names without a file extension are refused.
pub fn clean_name(name: &str) -> Result<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mapped: String = base
        .chars()
        .map(|c| {
            let reserved = matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | '#' | '^');
            if c.is_control() || reserved { '-' } else { c }
        })
        .collect();
    let trimmed = mapped.trim_start_matches(['.', ' ']).trim_end_matches(['.', ' ']);
    let ext_len = file_extension(trimmed)
        .ok_or_else(|| Error::State(format!("„{base}“ hat keine Dateiendung und lässt sich nicht anhängen")))?
        .len();
    // The extension keeps its spelling (`Bericht.PDF`).
    let (stem, ext) = trimmed.split_at(trimmed.len() - ext_len - 1);
    let mut stem = stem.trim_end_matches(['.', ' ']).to_owned();
    while stem.len() + ext.len() > MAX_NAME {
        stem.pop();
    }
    let stem = stem.trim_end_matches(['.', ' ']);
    let device = stem.split('.').next().unwrap_or("");
    let upper = device.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    Ok(match (stem.is_empty(), reserved) {
        (true, _) => format!("Datei{ext}"),
        (false, true) => format!("{device}_{}{ext}", &stem[device.len()..]),
        _ => format!("{stem}{ext}"),
    })
}

/// The name a new file `name` is stored under: `name` itself when free or when that file
/// already holds the same bytes (`same`, then nothing is written), else `stem 2.ext`, …
fn free_name(dir: &Path, name: &str, same: impl Fn(&Path) -> bool) -> Result<(String, bool)> {
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let mut candidate = name.to_owned();
    for n in 2..10_000 {
        let path = dir.join(&candidate);
        if !path.exists() {
            return Ok((candidate, false));
        }
        if path.is_file() && same(&path) {
            return Ok((candidate, true));
        }
        candidate = format!("{stem} {n}.{ext}");
    }
    Err(Error::State(format!("Kein freier Dateiname für „{name}“")))
}

fn file_hash(path: &Path) -> Option<[u8; 32]> {
    let mut hasher = Sha256::new();
    std::io::copy(&mut fs::File::open(path).ok()?, &mut hasher).ok()?;
    Some(hasher.finalize().into())
}

fn check_size(size: u64) -> Result<()> {
    if size == 0 {
        return Err(Error::State("Leere Datei".into()));
    }
    if size > MAX_FILE_BYTES {
        return Err(Error::State(format!("Datei ist größer als {} MB", MAX_FILE_BYTES / 1024 / 1024)));
    }
    Ok(())
}

fn saved(dir: &Path, name: String, size: u64) -> SavedAttachment {
    SavedAttachment { markdown: format!("![[{name}]]"), path: dir.join(&name).display().to_string(), size, name }
}

/// Stores a dropped or pasted file (its bytes) under its sanitized name.
pub fn store_file(attachments_dir: &Path, name: &str, bytes: &[u8]) -> Result<SavedAttachment> {
    check_size(bytes.len() as u64)?;
    let clean = clean_name(name)?;
    fs::create_dir_all(attachments_dir).at(attachments_dir)?;
    let hash: [u8; 32] = Sha256::digest(bytes).into();
    let len = bytes.len() as u64;
    let (file, exists) = free_name(attachments_dir, &clean, |p| {
        fs::metadata(p).is_ok_and(|m| m.len() == len) && file_hash(p) == Some(hash)
    })?;
    if !exists {
        crate::drawings::write_atomic(&attachments_dir.join(&file), bytes)?;
    }
    Ok(saved(attachments_dir, file, len))
}

/// Copies a file chosen in the file dialog into the attachments folder, streaming instead of
/// loading it into memory. Folders, empty and oversized files are refused.
pub fn import_file(attachments_dir: &Path, source: &Path) -> Result<SavedAttachment> {
    let meta = fs::metadata(source).at(source)?;
    let name = source.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !meta.is_file() {
        return Err(Error::State(format!("„{}“ ist keine Datei", source.display())));
    }
    check_size(meta.len())?;
    let clean = clean_name(name)?;
    fs::create_dir_all(attachments_dir).at(attachments_dir)?;
    // A file picked from the attachments folder itself is embedded as it is.
    if let (Ok(src), Some(found)) = (source.canonicalize(), resolve(attachments_dir, name))
        && src == found
    {
        return Ok(saved(attachments_dir, name.to_owned(), meta.len()));
    }
    let hash = file_hash(source).ok_or_else(|| Error::State(format!("„{name}“ ließ sich nicht lesen")))?;
    let len = meta.len();
    let (file, exists) = free_name(attachments_dir, &clean, |p| {
        fs::metadata(p).is_ok_and(|m| m.len() == len) && file_hash(p) == Some(hash)
    })?;
    if !exists {
        // Copy under a hidden name and rename, so an interrupted copy leaves no truncated file.
        let tmp = attachments_dir.join(format!(".{file}.part"));
        let target = attachments_dir.join(&file);
        if let Err(e) = crate::error::copy_file(source, &tmp).and_then(|_| fs::rename(&tmp, &target).at(&target)) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    Ok(saved(attachments_dir, file, len))
}

/// Resolves a requested file name to a file inside `attachments_dir`.
/// Only plain names are accepted: no separators, no `..`, no hidden files.
pub fn resolve(attachments_dir: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':', '\0']) || !embeddable(name) {
        return None;
    }
    let path = attachments_dir.join(name);
    // Belt and braces: the canonical path must still be inside the folder (symlinks).
    let root = attachments_dir.canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    (real.starts_with(&root) && real.is_file()).then_some(real)
}

/// [`resolve`], with an error that names the missing file and its folder
/// („Datei nicht gefunden: C:\…\attachments\Angebot.pdf“).
pub fn existing(attachments_dir: &Path, name: &str) -> Result<PathBuf> {
    resolve(attachments_dir, name).ok_or_else(|| {
        let plain = !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':', '\0']);
        if plain {
            let source = std::io::Error::from(std::io::ErrorKind::NotFound);
            Error::File { path: attachments_dir.join(name), dir: false, source }
        } else {
            Error::not_found("attachment", name)
        }
    })
}

/// Decodes `%XX` escapes of a URL path segment.
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Attachment names embedded as `![[name]]` (the part before `|` or `#`, without folders).
/// A drawing brings its SVG preview along.
pub fn embeds(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut rest = markdown;
    while let Some(start) = rest.find("![[") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("]]") else { break };
        let target = after[..end].split(['|', '#']).next().unwrap_or("").trim();
        let base = target.rsplit(['/', '\\']).next().unwrap_or(target);
        if embeddable(base) && !out.iter().any(|n| n == base) {
            out.push(base.to_owned());
            if is_drawing(base) {
                out.push(format!("{base}.svg"));
            }
        }
        rest = &after[end + 2..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("annalo-att-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn missing_files_are_named_with_their_folder() {
        let dir = tmp("missing");
        fs::create_dir_all(&dir).unwrap();
        let e = existing(&dir, "Angebot.pdf").unwrap_err();
        assert_eq!(e.to_string(), format!("Datei nicht gefunden: {}", dir.join("Angebot.pdf").display()));
        // Even before the attachments folder exists, the file is named.
        let e = existing(&dir.join("fehlt"), "Angebot.pdf").unwrap_err();
        assert!(e.to_string().ends_with("Angebot.pdf"), "{e}");
        assert!(matches!(existing(&dir, "../x.pdf"), Err(Error::NotFound { .. })));
        let e = import_file(&dir, &dir.join("Quelle.docx")).unwrap_err();
        assert_eq!(e.to_string(), format!("Datei nicht gefunden: {}", dir.join("Quelle.docx").display()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saves_by_content_hash_once() {
        let dir = tmp("save");
        let a = save(&dir, b"\x89PNG fake", "Bildschirmfoto.PNG", "").unwrap();
        assert_eq!(a.name.len(), 16 + 4);
        assert!(a.name.ends_with(".png"));
        assert_eq!(a.markdown, format!("![[{}]]", a.name));
        let b = save(&dir, b"\x89PNG fake", "anders.png", "image/png").unwrap();
        assert_eq!(a.name, b.name, "same bytes, same file");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        // Extension from the MIME type when the name has none.
        assert!(save(&dir, b"jpeg", "image", "image/jpeg").unwrap().name.ends_with(".jpg"));
        assert!(save(&dir, b"x", "doc.exe", "application/x-msdownload").is_err());
        assert!(save(&dir, b"", "a.png", "").is_err());
    }

    #[test]
    fn resolve_rejects_traversal() {
        let dir = tmp("resolve").join("attachments");
        let a = save(&dir, b"img", "a.png", "").unwrap();
        fs::write(dir.parent().unwrap().join("secret.png"), b"x").unwrap(); // outside the folder
        fs::write(dir.join("x.md"), b"x").unwrap();
        assert!(resolve(&dir, &a.name).is_some());
        for bad in [
            "../secret.png",
            "..\\secret.png",
            "/etc/passwd",
            ".hidden.png",
            "",
            "x.md",
            "x.excalidraw.md",
            "C:secret.png",
            "missing.png",
            "missing.txt",
        ] {
            assert!(resolve(&dir, bad).is_none(), "{bad}");
        }
        assert_eq!(percent_decode("Bild%201.png").as_deref(), Some("Bild 1.png"));
        assert_eq!(percent_decode("%2E%2E%2Fx").as_deref(), Some("../x"));
        assert!(percent_decode("%zz").is_none());
    }

    #[test]
    fn finds_embeds() {
        let md = "![[a.png]] ![[Ordner/b.JPG|300]] ![[Notiz]] [[c.png]] ![[a.png]] ![[Skizze 1.excalidraw]] \
                  ![[Handbuch.pdf#page=3]] ![[Angebot v2.docx]] ![[Version 1.2]] ![[x.md]]";
        assert_eq!(
            embeds(md),
            ["a.png", "b.JPG", "Skizze 1.excalidraw", "Skizze 1.excalidraw.svg", "Handbuch.pdf", "Angebot v2.docx"]
        );
        assert!(embeddable("x.Excalidraw") && embeddable("x.excalidraw.svg") && !embeddable("x.excalidraw.md"));
        assert_eq!(mime_for("x.excalidraw"), "application/json");
        assert_eq!(mime_for("Handbuch.PDF"), "application/pdf");
        assert_eq!(mime_for("seite.html"), "application/octet-stream");
    }

    #[test]
    fn file_extensions() {
        for ok in ["a.pdf", "Bericht.DOCX", "x.tar.gz", "daten.xlsx", "a.7z", "Skizze.excalidraw", "a.mp3"] {
            assert!(file_extension(ok).is_some(), "{ok}");
        }
        for no in
            ["Notiz", "Version 1.2", "Jour fixe 22.09.", "x.md", ".pdf", "a.toolongextension", "Dr. Müller", "a.b c"]
        {
            assert!(file_extension(no).is_none(), "{no}");
        }
        assert!(is_executable("setup.EXE") && is_executable("start.bat") && is_executable("x.lnk"));
        assert!(!is_executable("Angebot.pdf") && !is_executable("daten.xlsx") && !is_executable("Notiz"));
    }

    #[test]
    fn cleans_names() {
        assert_eq!(clean_name("Angebot.pdf").unwrap(), "Angebot.pdf");
        assert_eq!(clean_name("C:\\Users\\max\\Bericht Q3.PDF").unwrap(), "Bericht Q3.PDF");
        assert_eq!(clean_name("../../etc/passwd.txt").unwrap(), "passwd.txt");
        assert_eq!(clean_name("a:b*c?[1]#2^.docx").unwrap(), "a-b-c--1--2-.docx");
        assert_eq!(clean_name("..versteckt.zip").unwrap(), "versteckt.zip");
        assert_eq!(clean_name("name. .pdf").unwrap(), "name.pdf");
        assert_eq!(clean_name("CON.txt").unwrap(), "CON_.txt");
        assert_eq!(clean_name("lpt1.tar.gz").unwrap(), "lpt1_.tar.gz");
        assert!(clean_name("  .pdf").unwrap_err().to_string().contains("Dateiendung"));
        assert_eq!(clean_name("x\u{0}y\n.csv").unwrap(), "x-y-.csv");
        let long = clean_name(&format!("{}.pdf", "ä".repeat(200))).unwrap();
        assert!(long.len() <= MAX_NAME && long.ends_with(".pdf"), "{long}");
        for bad in ["Makefile", "notiz.md", "v1.2", ""] {
            assert!(clean_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn stores_files_by_name_with_unique_names() {
        let dir = tmp("store");
        let a = store_file(&dir, "Angebot.pdf", b"%PDF-1 eins").unwrap();
        assert_eq!((a.name.as_str(), a.markdown.as_str(), a.size), ("Angebot.pdf", "![[Angebot.pdf]]", 11));
        // Same name and bytes: the file is reused.
        assert_eq!(store_file(&dir, "Angebot.pdf", b"%PDF-1 eins").unwrap().name, "Angebot.pdf");
        // Same name, other bytes: a free name.
        assert_eq!(store_file(&dir, "Angebot.pdf", b"%PDF-1 zwei").unwrap().name, "Angebot 2.pdf");
        assert_eq!(store_file(&dir, "Angebot.pdf", b"%PDF-1 drei").unwrap().name, "Angebot 3.pdf");
        assert_eq!(store_file(&dir, "Angebot.pdf", b"%PDF-1 zwei").unwrap().name, "Angebot 2.pdf");
        assert_eq!(fs::read(dir.join("Angebot 3.pdf")).unwrap(), b"%PDF-1 drei");
        assert!(store_file(&dir, "leer.txt", b"").is_err());
        assert!(store_file(&dir, "../../boese.txt", b"x").unwrap().path.ends_with("boese.txt"));
        assert!(dir.join("boese.txt").is_file());
        // No temp files are left behind.
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with('.')));
    }

    #[test]
    fn imports_files_by_path() {
        let src = tmp("import-src");
        fs::create_dir_all(&src).unwrap();
        let dir = tmp("import").join("attachments");
        fs::write(src.join("Tabelle.xlsx"), b"PK xlsx").unwrap();
        let a = import_file(&dir, &src.join("Tabelle.xlsx")).unwrap();
        assert_eq!((a.name.as_str(), a.size), ("Tabelle.xlsx", 7));
        assert_eq!(fs::read(dir.join("Tabelle.xlsx")).unwrap(), b"PK xlsx");
        assert_eq!(import_file(&dir, &src.join("Tabelle.xlsx")).unwrap().name, "Tabelle.xlsx", "same file reused");
        fs::write(src.join("Tabelle.xlsx"), b"PK anders").unwrap();
        assert_eq!(import_file(&dir, &src.join("Tabelle.xlsx")).unwrap().name, "Tabelle 2.xlsx");
        // A file from the attachments folder itself is embedded as it is.
        assert_eq!(import_file(&dir, &dir.join("Tabelle 2.xlsx")).unwrap().name, "Tabelle 2.xlsx");
        assert!(!dir.join("Tabelle 3.xlsx").exists());
        // Folders, missing, empty and extension-less files are refused.
        assert!(import_file(&dir, &src).is_err());
        assert!(import_file(&dir, &src.join("fehlt.pdf")).is_err());
        fs::write(src.join("leer.pdf"), b"").unwrap();
        assert!(import_file(&dir, &src.join("leer.pdf")).is_err());
        fs::write(src.join("Makefile"), b"all:").unwrap();
        assert!(import_file(&dir, &src.join("Makefile")).is_err());
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with('.')));
    }

    #[test]
    fn oversized_files_are_refused() {
        let src = tmp("big-src");
        fs::create_dir_all(&src).unwrap();
        let big = src.join("gross.zip");
        // A sparse file: the size check comes before any byte is read.
        fs::File::create(&big).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        let err = import_file(&tmp("big"), &big).unwrap_err();
        assert!(err.to_string().contains("100 MB"), "{err}");
        let _ = fs::remove_dir_all(&src);
    }
}
