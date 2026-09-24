//! Drawings (Excalidraw): the scene is `<name>.excalidraw` (Excalidraw's JSON) in the
//! attachments folder, its rendered preview `<name>.excalidraw.svg` sits next to it.
//! Notes embed them as `![[name.excalidraw]]`, the same way the Obsidian Excalidraw
//! plugin references drawings, so vault import/export keeps them.

use std::fs;
use std::path::Path;

use crate::attachments::{self, SavedAttachment};
use crate::error::{Error, Result};

/// File suffix of a drawing scene.
pub const SUFFIX: &str = ".excalidraw";

/// Longest accepted file name (bytes), well below every file system's limit.
const MAX_NAME: usize = 180;

/// A new, empty scene (Excalidraw's file format, version 2).
pub const EMPTY_SCENE: &str = r##"{"type":"excalidraw","version":2,"source":"annalo","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}"##;

/// `name.excalidraw.svg`, the preview shown in the note.
pub fn preview_name(name: &str) -> String {
    format!("{name}.svg")
}

/// A plain file name ending in `.excalidraw`: no folders, no `..`, no hidden or control characters.
pub fn validate_name(name: &str) -> Result<()> {
    let bad = |why: &str| Err(Error::State(format!("Ungültiger Zeichnungsname „{name}“: {why}")));
    if !name.to_ascii_lowercase().ends_with(SUFFIX) || name.len() <= SUFFIX.len() {
        return bad("muss auf .excalidraw enden");
    }
    if name.contains(['/', '\\', ':', '\0']) || name.chars().any(char::is_control) {
        return bad("keine Ordner oder Sonderzeichen");
    }
    if name.starts_with('.') || name.starts_with(' ') || name.len() > MAX_NAME {
        return bad("nicht erlaubt");
    }
    Ok(())
}

/// Writes `bytes` to a temp file in the same folder and renames it over `path`, so a crash
/// never leaves a half-written scene under the final name.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| Error::State("Kein Zielordner".into()))?;
    let file = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| Error::State("Ungültiger Dateiname".into()))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{file}.tmp"));
    let written = fs::File::create(&tmp).and_then(|mut f| {
        std::io::Write::write_all(&mut f, bytes)?;
        f.sync_all()
    });
    if let Err(e) = written.and_then(|()| fs::rename(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Turns a title into a file stem: separators and reserved characters become `-`.
fn stem(title: &str) -> String {
    let title = title.trim();
    let title = title.strip_suffix(SUFFIX).unwrap_or(title);
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_control()
                || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | '#' | '^')
            {
                '-'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim().trim_start_matches('.').trim();
    let s: String = s.chars().take(120).collect();
    if s.is_empty() { "Zeichnung".into() } else { s }
}

/// Creates an empty drawing named after `title` (`Zeichnung 2`, `Zeichnung 3`, … when taken).
pub fn create(attachments_dir: &Path, title: &str) -> Result<SavedAttachment> {
    let base = stem(title);
    let mut name = format!("{base}{SUFFIX}");
    let mut n = 2;
    while attachments_dir.join(&name).exists() || attachments_dir.join(preview_name(&name)).exists() {
        name = format!("{base} {n}{SUFFIX}");
        n += 1;
    }
    validate_name(&name)?;
    let path = attachments_dir.join(&name);
    write_atomic(&path, EMPTY_SCENE.as_bytes())?;
    Ok(SavedAttachment {
        markdown: format!("![[{name}]]"),
        path: path.display().to_string(),
        size: EMPTY_SCENE.len() as u64,
        name,
    })
}

/// The scene JSON of a drawing.
pub fn read(attachments_dir: &Path, name: &str) -> Result<String> {
    validate_name(name)?;
    let path = attachments::resolve(attachments_dir, name).ok_or_else(|| Error::not_found("Zeichnung", name))?;
    Ok(fs::read_to_string(path)?)
}

/// Stores the scene and its SVG preview. Without a preview (empty drawing) an old one is
/// removed, so the note shows the placeholder again.
pub fn save(attachments_dir: &Path, name: &str, scene: &str, svg: Option<&str>) -> Result<()> {
    validate_name(name)?;
    if scene.len() > attachments::MAX_BYTES || svg.is_some_and(|s| s.len() > attachments::MAX_BYTES) {
        return Err(Error::State(format!("Zeichnung ist größer als {} MB", attachments::MAX_BYTES / 1024 / 1024)));
    }
    let value: serde_json::Value = serde_json::from_str(scene)?;
    if !value.get("elements").is_some_and(serde_json::Value::is_array) {
        return Err(Error::Parse("Keine Excalidraw-Zeichnung (elements fehlt)".into()));
    }
    let svg = svg.map(str::trim).filter(|s| !s.is_empty());
    if svg.is_some_and(|s| !s.starts_with("<svg")) {
        return Err(Error::Parse("Vorschau ist kein SVG".into()));
    }
    write_atomic(&attachments_dir.join(name), scene.as_bytes())?;
    let preview = attachments_dir.join(preview_name(name));
    match svg {
        Some(s) => write_atomic(&preview, s.as_bytes())?,
        None if preview.exists() => fs::remove_file(&preview)?,
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("annalo-draw-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn validates_names() {
        for ok in
            ["Zeichnung 2026-09-24 14.05.excalidraw", "a.excalidraw", "Skizze.Excalidraw", "Ablauf (v2).excalidraw"]
        {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            ".excalidraw",
            "a.png",
            "a.excalidraw.svg",
            "../a.excalidraw",
            "ordner/a.excalidraw",
            "ordner\\a.excalidraw",
            "C:a.excalidraw",
            ".versteckt.excalidraw",
            "zeile\nzwei.excalidraw",
            &format!("{}.excalidraw", "x".repeat(200)),
        ] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn creates_unique_empty_drawings() {
        let dir = tmp("create");
        let a = create(&dir, "Zeichnung 2026-09-24 14.05").unwrap();
        assert_eq!(a.name, "Zeichnung 2026-09-24 14.05.excalidraw");
        assert_eq!(a.markdown, "![[Zeichnung 2026-09-24 14.05.excalidraw]]");
        assert_eq!(read(&dir, &a.name).unwrap(), EMPTY_SCENE);
        let b = create(&dir, "Zeichnung 2026-09-24 14.05").unwrap();
        assert_eq!(b.name, "Zeichnung 2026-09-24 14.05 2.excalidraw");
        // Separators never reach the file system.
        assert_eq!(create(&dir, "../a/b: c").unwrap().name, "-a-b- c.excalidraw");
        assert_eq!(create(&dir, "  ").unwrap().name, "Zeichnung.excalidraw");
        assert!(serde_json::from_str::<serde_json::Value>(EMPTY_SCENE).is_ok());
    }

    #[test]
    fn saves_scene_and_preview_atomically() {
        let dir = tmp("save");
        let name = create(&dir, "Plan").unwrap().name;
        let scene = r#"{"type":"excalidraw","elements":[{"type":"rectangle"}]}"#;
        save(&dir, &name, scene, Some("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")).unwrap();
        assert_eq!(read(&dir, &name).unwrap(), scene);
        assert!(dir.join("Plan.excalidraw.svg").is_file());
        // No temp files left behind.
        let names: Vec<String> =
            fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
        // An empty drawing drops the preview.
        save(&dir, &name, r#"{"elements":[]}"#, None).unwrap();
        assert!(!dir.join("Plan.excalidraw.svg").exists());
        // Invalid input leaves the stored scene untouched.
        assert!(save(&dir, &name, "kein json", None).is_err());
        assert!(save(&dir, &name, r#"{"a":1}"#, None).is_err());
        assert!(save(&dir, &name, scene, Some("<script>")).is_err());
        assert!(save(&dir, "../x.excalidraw", scene, None).is_err());
        assert_eq!(read(&dir, &name).unwrap(), r#"{"elements":[]}"#);
        assert!(matches!(read(&dir, "fehlt.excalidraw"), Err(Error::NotFound { .. })));
    }

    #[test]
    fn write_atomic_replaces_whole_file() {
        let dir = tmp("atomic");
        let path = dir.join("a.excalidraw");
        write_atomic(&path, b"lang und alt").unwrap();
        write_atomic(&path, b"neu").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"neu");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }
}
