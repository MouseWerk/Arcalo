//! Reads the organization's update policy once at start (see `arcalo_core::update_policy` and
//! docs/admin/updates.md): Windows registry (HKLM over HKCU), macOS managed preferences, and
//! `policy.json` next to the executable or in the system folder. Higher sources win per value.
//! `ARCALO_EXE_DIR` stands in for the executable's folder (tests), as for portable mode.

use std::path::PathBuf;
use std::sync::OnceLock;

use arcalo_core::update_policy::{self as core, Policy};

static POLICY: OnceLock<Policy> = OnceLock::new();

/// The policy in force (read on first use).
pub fn get() -> &'static Policy {
    POLICY.get_or_init(load)
}

fn load() -> Policy {
    let exe = arcalo_core::datadir::exe_dir(std::env::var_os("ARCALO_EXE_DIR").map(PathBuf::from));
    // Test runs point the executable's folder elsewhere and must not pick up a machine's policy.
    let system = if std::env::var_os("ARCALO_EXE_DIR").is_some() { None } else { core::system_policy_dir() };
    let mut layers = registry();
    layers.extend(managed_preferences());
    layers.extend(core::read_files(&core::policy_files(exe.as_deref(), system.as_deref())));
    let policy = Policy::merge(layers);
    if !policy.origins.is_empty() {
        crate::devlog::info(
            "update",
            format!("update policy from {}: {:?}", policy.origins.join(", "), policy.managed()),
        );
    }
    for w in &policy.warnings {
        crate::devlog::warn("update", format!("policy value ignored: {w}"));
    }
    policy
}

/// `HKLM\Software\Policies\MouseWerk\Arcalo`, then the same key under HKCU.
#[cfg(windows)]
fn registry() -> Vec<Policy> {
    use arcalo_core::update_policy::Value;
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RegType};
    const KEY: &str = r"Software\Policies\MouseWerk\Arcalo";
    [(HKEY_LOCAL_MACHINE, "HKLM"), (HKEY_CURRENT_USER, "HKCU")]
        .into_iter()
        .filter_map(|(hive, name)| {
            let key = RegKey::predef(hive).open_subkey_with_flags(KEY, KEY_READ).ok()?;
            let values = key.enum_values().filter_map(|v| v.ok()).filter_map(|(n, raw)| {
                let value = match raw.vtype {
                    RegType::REG_DWORD => Value::Number(key.get_value::<u32, _>(&n).ok()? as i64),
                    RegType::REG_QWORD => Value::Number(key.get_value::<u64, _>(&n).ok()? as i64),
                    RegType::REG_SZ | RegType::REG_EXPAND_SZ => Value::Text(key.get_value::<String, _>(&n).ok()?),
                    _ => return None,
                };
                Some((n, value))
            });
            Some(Policy::from_values(&format!(r"{name}\{KEY}"), values))
        })
        .collect()
}

#[cfg(not(windows))]
fn registry() -> Vec<Policy> {
    Vec::new()
}

/// Managed preferences of a configuration profile for the app's bundle identifier
/// (`/Library/Managed Preferences/<user>/…` over the computer-wide file). Profiles for the
/// identifier of 1.14 and earlier still count, after those for the current one (admins re-issue
/// them for the new domain).
#[cfg(target_os = "macos")]
fn managed_preferences() -> Vec<Policy> {
    use arcalo_core::identity::{IDENTIFIER, LEGACY_IDENTIFIER};
    let base = PathBuf::from("/Library/Managed Preferences");
    let user = std::env::var("USER").ok();
    [IDENTIFIER, LEGACY_IDENTIFIER]
        .into_iter()
        .flat_map(|id| {
            let file = format!("{id}.plist");
            user.iter().map(|u| base.join(u).join(&file)).chain([base.join(&file)]).collect::<Vec<_>>()
        })
        .filter_map(|p| {
            let bytes = std::fs::read(&p).ok()?;
            let origin = p.display().to_string();
            Some(
                Policy::from_plist(&origin, &bytes)
                    .unwrap_or_else(|e| Policy { warnings: vec![e], ..Default::default() }),
            )
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn managed_preferences() -> Vec<Policy> {
    Vec::new()
}
