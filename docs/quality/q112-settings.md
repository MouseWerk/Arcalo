# q112 A6: Settings, security, updates, network, onboarding

Method: code read of SettingsView, settings/* sections, LockScreen, security lib, keymap, admin
import/export, updates group, about; real app under Xvfb :435 with a tour of all 22 sections in
de-light/de-dark/en-contrast at 1280x800, de-light at 900x800 and 1920x1080 (layout audit +
screenshots, q112-shots/settings/before-*, after-*), keyboard probes, flow probes.

## Findings

| # | Sev | Finding | Root cause | Fix | Test |
|---|-----|---------|-----------|-----|------|
| 1 | Medium | App lock PIN dialog: when saving the lock failed (credential store not writable), the error toast AND "App-Sperre eingerichtet" showed and the dialog closed, losing the input | `apply()` swallowed the rejection and resolved, `.then` always ran the success path | `apply` returns success; dialog stays open on failure | e2e 190 (store blocked by a folder) |
| 2 | Medium | Mod+F in Settings did nothing in a narrow pane (window < ~1100 px or with the right panel open, the common case at 1280) | focus went to the first `.settings-search input`, the hidden menu's | focus the visible search field | e2e 190 |
| 3 | Medium | Settings menu was 27 Tab stops before the content; no arrow keys | every nav button tabbable | roving tabindex: one stop (open section), Up/Down/Home/End inside | e2e 190 |
| 4 | Medium | About page had no license information (app license, third-party libraries) | missing | new "Lizenzen" group: MIT license text dialog, searchable list of 86 libraries (UI deps + direct Rust deps) with version and license, generated at build time (ui/scripts/licenses.mjs, gitignored output) | vitest licenses.test.ts, e2e 190 |
| 5 | Medium | Forgotten PIN on Linux without encryption: lock screen pointed at a repo path (docs/security/encryption.md); setting the PIN gave no warning that it cannot be reset | text only | lock screen shows the exact sqlite3 command (selectable); PIN dialog warns beforehand when no reset path exists | e2e 190 |
| 6 | Low | "Sprache der Oberfläche" description said dialogs and AI prompts stay German (outdated, everything follows the language); no hint of the system language | stale string | new description incl. "Sprache des Systems: …" (OS locale) | e2e 190 |
| 7 | Low | Key recorder trapped Tab while recording (keyboard users had to know Esc) | preventDefault on every key | Tab ends recording and moves on | e2e 190 |
| 8 | Low | Verwaltung → "Abschnitt zurücksetzen" lacked Ordner & Ablage, Jira, Briefing, Sprachnotizen although each section has its own reset | list out of sync | added | e2e 190 (all listed ids reset in the backend) |
| 9 | Low | Settings export default file name "annalo-einstellungen-…" (old product name, German in EN) | hardcoded | i18n "arcalo-einstellungen-{date}.json" / "arcalo-settings-{date}.json" | - |
| 10 | Low | Notizen → Vorlage für Tagesnotizen cut to "Standard (Fokus und Notiz…" even at 1920 px | `.set-row-control > .select` 224 px rule overrode the intended `.w-360` | rule excludes `.w-360` | layout audit (before 4 lines, after 0) |
| 11 | Low | Password dialog (portable copy) did not submit with Enter | no form | form with submit | - |
| 12 | Low | Lock screen: Windows Hello / Touch ID call that throws left no message | no catch | shows the "not confirmed" note | - |

## Checked, no change needed
Instant apply + undo toasts, section reset, scopes, search (rows, Enter, Esc), deep links into
sections, policy-locked update fields with badge and origin, Store build update group, network
profiles/routes/PAC/CA (e2e 23/139/140), wrong-PIN back-off persisted in the DB, lock on sleep,
themes incl. contrast and reduced motion (data attribute + media query), shortcut conflicts,
settings import validation with preview, 0 layout-audit problems in all 5 variants after fixes,
no German leftovers in English (e2e 82).

## Left (larger, described only)
- No "follow system language" mode: the OS language is picked at first start and then stored;
  a third mode needs a Language enum variant across backend tr! and the shell (risky in 1.12).
- Right panel tab strip (not settings) is 4 Tab stops instead of a roving tablist.
- Rust licenses come from cargo's unpacked sources; a build machine whose UI build runs before
  any cargo fetch lists those crates with "Siehe Bibliothek" (CI builds the app after cargo fetch).
