//! Auto-update decisions that do not need the updater itself.
//!
//! The desktop shell only switches the updater on when the release build compiled in the
//! public key of the signing keypair (`ANNALO_UPDATER_PUBKEY`). Development and test builds
//! have no key: they never contact the update server.

/// GitHub repository the releases are published to.
pub const REPOSITORY: &str = "mauricekleindienst/aetheros";

/// Shown when a build has no update key.
pub const NOT_CONFIGURED: &str = "Automatische Updates sind in diesem Build nicht eingerichtet";

/// The compiled-in public key, if it is usable: blank values count as "not configured".
pub fn configured_pubkey(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|k| !k.is_empty())
}

/// Release page with the changelog of `version` (`1.2.0` or `v1.2.0`).
pub fn release_url(version: &str) -> String {
    let v = version.trim().trim_start_matches('v');
    format!("https://github.com/{REPOSITORY}/releases/tag/v{v}")
}

/// Whole download percentage, `None` while the size is unknown.
pub fn progress_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    Some((downloaded.min(total) * 100 / total) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_needs_a_non_blank_key() {
        assert_eq!(configured_pubkey(None), None);
        assert_eq!(configured_pubkey(Some("")), None);
        assert_eq!(configured_pubkey(Some("  \n")), None);
        assert_eq!(configured_pubkey(Some(" dW50cnVzdGVk\n")), Some("dW50cnVzdGVk"));
    }

    #[test]
    fn release_links_use_the_tag() {
        let url = "https://github.com/mauricekleindienst/aetheros/releases/tag/v1.2.0";
        assert_eq!(release_url("1.2.0"), url);
        assert_eq!(release_url("v1.2.0"), url);
    }

    #[test]
    fn progress_is_clamped_and_unknown_without_size() {
        assert_eq!(progress_percent(10, None), None);
        assert_eq!(progress_percent(10, Some(0)), None);
        assert_eq!(progress_percent(0, Some(200)), Some(0));
        assert_eq!(progress_percent(101, Some(200)), Some(50));
        assert_eq!(progress_percent(300, Some(200)), Some(100));
    }
}
