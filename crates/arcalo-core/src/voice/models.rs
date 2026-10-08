//! The Whisper models Arcalo offers (whisper.cpp `ggml` files), their fixed size and SHA-256,
//! and where they are downloaded from, in this order:
//!
//! 1. the admin source of Settings → Sprachnotizen (an address or a network folder),
//! 2. the release `whisper-models-v1` of the Arcalo repository on GitHub
//!    (published by `scripts/publish-whisper-models.sh`),
//! 3. Hugging Face (`ggerganov/whisper.cpp`), the original source.
//!
//! „Modelldatei wählen …“ imports a file the user has; every source is checked against the same
//! checksum. Models live in `<data folder>/models/whisper/`, outside of backups and Git sync.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One downloadable model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ModelInfo {
    pub id: &'static str,
    /// File name, the same at every source.
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// base (fast, rough), small (default) and large-v3-turbo quantized to q5_0 (best, slower).
/// Sizes and SHA-256 as published by whisper.cpp on Hugging Face.
pub const MODELS: [ModelInfo; 3] = [
    ModelInfo {
        id: "base",
        file: "ggml-base.bin",
        size: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelInfo {
        id: "small",
        file: "ggml-small.bin",
        size: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
    ModelInfo {
        id: "large-v3-turbo-q5",
        file: "ggml-large-v3-turbo-q5_0.bin",
        size: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
];

pub const DEFAULT_MODEL: &str = "small";

/// Release tag of the model files in the Arcalo repository.
pub const RELEASE_TAG: &str = "whisper-models-v1";
/// Release assets of the Arcalo repository (source 2).
pub const GITHUB_BASE: &str = "https://github.com/MouseWerk/Arcalo/releases/download/whisper-models-v1";
/// whisper.cpp's own files (source 3).
pub const HUGGINGFACE_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Folder of the models below the data folder.
pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models").join("whisper")
}

pub fn find(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

/// The model `id`, or the default one for an unknown id (e.g. from a newer version).
pub fn get(id: &str) -> &'static ModelInfo {
    find(id).or_else(|| find(DEFAULT_MODEL)).unwrap_or(&MODELS[1])
}

/// Where a model file is fetched from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Url(String),
    /// A file on a share or drive.
    File(PathBuf),
}

impl Source {
    /// For messages and the progress display.
    pub fn label(&self) -> String {
        match self {
            Source::Url(u) => u.split('?').next().unwrap_or(u).to_owned(),
            Source::File(p) => p.display().to_string(),
        }
    }
}

/// The sources of `model` in the order they are tried: the admin source `custom` (address or
/// folder; empty = none), then `github`, then `huggingface` (the bases; overridable for tests).
pub fn sources(model: &ModelInfo, custom: &str, github: &str, huggingface: &str) -> Vec<Source> {
    let mut out = Vec::new();
    let custom = custom.trim();
    if !custom.is_empty() {
        out.push(custom_source(custom, model.file));
    }
    for base in [github, huggingface] {
        let base = base.trim().trim_end_matches('/');
        if !base.is_empty() {
            out.push(Source::Url(format!("{base}/{}", model.file)));
        }
    }
    out.dedup();
    out
}

/// The admin source: an address (`https://…`, the file name appended unless it already ends in
/// `.bin`) or a folder (`\\server\share\models`, `/Volumes/…`, `file:///…`).
fn custom_source(custom: &str, file: &str) -> Source {
    let lower = custom.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        if lower.ends_with(".bin") {
            return Source::Url(custom.to_owned());
        }
        return Source::Url(format!("{}/{file}", custom.trim_end_matches('/')));
    }
    let path = custom.strip_prefix("file://").unwrap_or(custom);
    // `file:///C:/…` on Windows.
    let path = path.strip_prefix('/').filter(|p| p.chars().nth(1) == Some(':')).unwrap_or(path);
    let path = PathBuf::from(path);
    if lower.ends_with(".bin") { Source::File(path) } else { Source::File(path.join(file)) }
}

/// What the settings show for one model.
#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    pub info: ModelInfo,
    pub installed: bool,
    /// Bytes of an interrupted download (resumed next time).
    pub partial: u64,
}

pub fn status(models_dir: &Path) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|m| {
            let path = models_dir.join(m.file);
            let installed = std::fs::metadata(&path).is_ok_and(|md| md.len() == m.size);
            let partial = std::fs::metadata(super::download::part_path(&path)).map(|md| md.len()).unwrap_or(0);
            ModelStatus { info: *m, installed, partial }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_three_models_with_valid_checksums() {
        let ids: Vec<_> = MODELS.iter().map(|m| m.id).collect();
        assert_eq!(ids, ["base", "small", "large-v3-turbo-q5"]);
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{}", m.id);
            assert!(m.file.starts_with("ggml-") && m.file.ends_with(".bin"));
            assert!(m.size > 100_000_000);
        }
        // Distinct files and checksums.
        assert_ne!(MODELS[0].sha256, MODELS[1].sha256);
        assert_ne!(MODELS[1].file, MODELS[2].file);
        assert_eq!(get("small").file, "ggml-small.bin");
        assert_eq!(get("unknown").id, DEFAULT_MODEL);
        assert!(find("tiny").is_none());
    }

    #[test]
    fn sources_in_order_admin_github_huggingface() {
        let m = get("base");
        let s = sources(m, "", GITHUB_BASE, HUGGINGFACE_BASE);
        assert_eq!(
            s,
            [
                Source::Url(
                    "https://github.com/MouseWerk/Arcalo/releases/download/whisper-models-v1/ggml-base.bin".into()
                ),
                Source::Url("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin".into()),
            ]
        );
        let s = sources(m, "https://models.example.com/whisper/", GITHUB_BASE, HUGGINGFACE_BASE);
        assert_eq!(s[0], Source::Url("https://models.example.com/whisper/ggml-base.bin".into()));
        assert_eq!(s.len(), 3);
        let s = sources(m, "https://cdn.example.com/x/base.bin", GITHUB_BASE, HUGGINGFACE_BASE);
        assert_eq!(s[0], Source::Url("https://cdn.example.com/x/base.bin".into()));
        let s = sources(m, r"\\server\share\models", GITHUB_BASE, HUGGINGFACE_BASE);
        assert_eq!(s[0], Source::File(PathBuf::from(r"\\server\share\models").join("ggml-base.bin")));
        let s = sources(m, "file:///srv/models", "", HUGGINGFACE_BASE);
        assert_eq!(
            s,
            [
                Source::File(PathBuf::from("/srv/models/ggml-base.bin")),
                Source::Url(format!("{HUGGINGFACE_BASE}/ggml-base.bin"))
            ]
        );
        assert!(GITHUB_BASE.ends_with(RELEASE_TAG));
    }

    #[test]
    fn status_reports_installed_and_partial_files() {
        let dir = std::env::temp_dir().join(format!("arcalo-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(super::super::download::part_path(&dir.join("ggml-base.bin")), b"12345").unwrap();
        let st = status(&dir);
        assert!(!st[0].installed);
        assert_eq!(st[0].partial, 5);
        assert_eq!(st[1].partial, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
