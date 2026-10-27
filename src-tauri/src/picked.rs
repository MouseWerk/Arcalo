//! Files chosen in the file dialog. On the desktop they are paths. On Android (1.20, the full app)
//! the dialog is Android's document picker, which answers with a `content://` address that only
//! Android can read or write: a file to read is copied into the app's cache first (under its own
//! name, so the checks of its extension work), a file to write is written there and then copied
//! to the address (`ShellPlugin.kt`: `copyFromUri`, `copyToUri`). On iOS the picker answers with
//! `file://` addresses, outside the app's sandbox when the file stays where it is (a save, a file
//! in iCloud Drive): they are copied the same way, inside the address's security scope
//! (`mobile/ios.rs`, `with_scope`).

use std::path::{Path, PathBuf};

use crate::Result;

/// A content address of Android's document picker (or, on iOS, a `file://` address of its).
pub fn is_content(path: &str) -> bool {
    let p = path.trim_start();
    p.starts_with("content://") || (cfg!(target_os = "ios") && p.starts_with("file://"))
}

/// A file to read: the path itself, or a copy in the cache that is removed with this value.
pub struct Input {
    path: PathBuf,
    temporary: bool,
}

impl Input {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Input {
    fn drop(&mut self) {
        if self.temporary {
            let _ = std::fs::remove_file(&self.path);
            if let Some(dir) = self.path.parent() {
                let _ = std::fs::remove_dir(dir);
            }
        }
    }
}

/// The file at `path` (a path, or on Android a content address) as a local file.
pub fn input(path: &str) -> Result<Input> {
    if !is_content(path) {
        return Ok(Input { path: PathBuf::from(path.trim()), temporary: false });
    }
    #[cfg(target_os = "android")]
    {
        let dir = scratch("in")?;
        let name = crate::mobile::android::uri_name(path.trim()).map_err(arcalo_core::Error::State)?;
        let local = dir.join(safe_name(&name));
        crate::mobile::android::copy_from_uri(path.trim(), &local.to_string_lossy())
            .map_err(arcalo_core::Error::State)?;
        Ok(Input { path: local, temporary: true })
    }
    #[cfg(target_os = "ios")]
    {
        let dir = scratch("in")?;
        let copied = crate::mobile::ios::with_scope(path, |src| {
            let local = dir.join(safe_name(&src.file_name().unwrap_or_default().to_string_lossy()));
            std::fs::copy(src, &local).map(|_| local).map_err(|e| arcalo_core::Error::file(src, e))
        })
        .map_err(arcalo_core::Error::State)??;
        Ok(Input { path: copied, temporary: true })
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Err(unsupported())
}

/// Writes the file at `path` (a path, or on Android a content address) with `write`, which gets
/// the local file to write.
pub fn output<T>(path: &str, write: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    if !is_content(path) {
        return write(Path::new(path.trim()));
    }
    #[cfg(target_os = "android")]
    {
        let dir = scratch("out")?;
        let name = crate::mobile::android::uri_name(path.trim()).map_err(arcalo_core::Error::State)?;
        let local = dir.join(safe_name(&name));
        let res = write(&local).and_then(|v| {
            crate::mobile::android::copy_to_uri(&local.to_string_lossy(), path.trim())
                .map_err(arcalo_core::Error::State)
                .map(|_| v)
        });
        let _ = std::fs::remove_file(&local);
        let _ = std::fs::remove_dir(&dir);
        res
    }
    #[cfg(target_os = "ios")]
    {
        let dir = scratch("out")?;
        let res = crate::mobile::ios::with_scope(path, |dest| {
            let local = dir.join(safe_name(&dest.file_name().unwrap_or_default().to_string_lossy()));
            let res = write(&local)
                .and_then(|v| std::fs::copy(&local, dest).map(|_| v).map_err(|e| arcalo_core::Error::file(dest, e)));
            let _ = std::fs::remove_file(&local);
            res
        })
        .map_err(arcalo_core::Error::State)?;
        let _ = std::fs::remove_dir(&dir);
        res
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = write;
        Err(unsupported())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn unsupported() -> arcalo_core::Error {
    arcalo_core::Error::State(
        arcalo_core::tr!("Diese Datei kann hier nicht geöffnet werden", "This file cannot be opened here").into(),
    )
}

/// A fresh folder in the app's cache for one file (two files of one name never meet).
#[cfg(mobile)]
fn scratch(kind: &str) -> Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let base = CACHE.get().cloned().unwrap_or_else(std::env::temp_dir);
    let dir =
        base.join("picked").join(format!("{kind}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).map_err(|e| arcalo_core::Error::file(&dir, e))?;
    Ok(dir)
}

#[cfg(mobile)]
static CACHE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// The app's cache folder (the system clears it when space runs low); copies of picked files go
/// there.
#[cfg(mobile)]
pub fn init(cache: PathBuf) {
    let _ = std::fs::remove_dir_all(cache.join("picked"));
    let _ = CACHE.set(cache);
}

/// The name the system shows for a picked file, usable as a file name (no folders, no control
/// characters); `file` when nothing is left.
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String =
        base.chars().filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let clean = clean.trim().trim_start_matches('.').to_owned();
    if clean.is_empty() { "file".into() } else { clean }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_paths_and_content_addresses_are_recognized() {
        assert!(is_content("content://com.android.providers.downloads.documents/document/42"));
        assert!(!is_content("/home/mia/Zeiten.csv"));
        assert!(!is_content(r"C:\Users\mia\Zeiten.csv"));
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let i = input(&file.to_string_lossy()).unwrap();
        assert_eq!(i.path(), file);
        drop(i);
        assert!(file.exists(), "a picked path is never removed");
        let out = dir.path().join("b.json");
        let n = output(&out.to_string_lossy(), |p| {
            std::fs::write(p, "{}").unwrap();
            Ok(2)
        })
        .unwrap();
        assert_eq!((n, std::fs::read_to_string(&out).unwrap().as_str()), (2, "{}"));
    }

    #[test]
    fn picked_names_become_plain_file_names() {
        assert_eq!(safe_name("Zeiten 2026-10.csv"), "Zeiten 2026-10.csv");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name(r"a\b:c?.pdf"), "bc.pdf");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name(""), "file");
        assert_eq!(safe_name("\u{7}"), "file");
    }
}
