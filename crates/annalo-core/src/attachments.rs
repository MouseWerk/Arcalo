//! Attachments (pasted screenshots, imported vault images): plain files in
//! `<data_dir>/attachments/`, referenced from Markdown as `![[name.png]]`
//! (Obsidian embed syntax). New files get content-hash names, so pasting the
//! same image twice stores it once.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// Folder below the data directory (and in exported vaults).
pub const DIR_NAME: &str = "attachments";

/// Image types embedded as `![[…]]`; other files are not attachments here.
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Upper bound for one attachment.
pub const MAX_BYTES: usize = 50 * 1024 * 1024;

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

/// MIME type served for an attachment file name.
pub fn mime_for(name: &str) -> &'static str {
    match image_extension(name).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
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
    fs::create_dir_all(attachments_dir)?;
    let path = attachments_dir.join(&file);
    if !path.is_file() {
        // Write-then-rename so a crash never leaves a truncated file under the final name.
        let tmp = attachments_dir.join(format!(".{file}.tmp"));
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
    }
    Ok(SavedAttachment {
        markdown: format!("![[{file}]]"),
        path: path.display().to_string(),
        size: bytes.len() as u64,
        name: file,
    })
}

/// Resolves a requested file name to a file inside `attachments_dir`.
/// Only plain names are accepted: no separators, no `..`, no hidden files.
pub fn resolve(attachments_dir: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty()
        || name.starts_with('.')
        || name.contains(['/', '\\', ':', '\0'])
        || image_extension(name).is_none()
    {
        return None;
    }
    let path = attachments_dir.join(name);
    // Belt and braces: the canonical path must still be inside the folder (symlinks).
    let root = attachments_dir.canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    (real.starts_with(&root) && real.is_file()).then_some(real)
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

/// Image names embedded as `![[name]]` (the part before `|`, without folders).
pub fn embeds(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut rest = markdown;
    while let Some(start) = rest.find("![[") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("]]") else { break };
        let target = after[..end].split('|').next().unwrap_or("").trim();
        let base = target.rsplit(['/', '\\']).next().unwrap_or(target);
        if image_extension(base).is_some() && !out.iter().any(|n| n == base) {
            out.push(base.to_owned());
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
        assert!(resolve(&dir, &a.name).is_some());
        for bad in [
            "../secret.png",
            "..\\secret.png",
            "/etc/passwd",
            ".hidden.png",
            "",
            "x.txt",
            "C:secret.png",
            "missing.png",
        ] {
            assert!(resolve(&dir, bad).is_none(), "{bad}");
        }
        assert_eq!(percent_decode("Bild%201.png").as_deref(), Some("Bild 1.png"));
        assert_eq!(percent_decode("%2E%2E%2Fx").as_deref(), Some("../x"));
        assert!(percent_decode("%zz").is_none());
    }

    #[test]
    fn finds_image_embeds() {
        let md = "![[a.png]] ![[Ordner/b.JPG|300]] ![[Notiz]] [[c.png]] ![[a.png]]";
        assert_eq!(embeds(md), ["a.png", "b.JPG"]);
    }
}
