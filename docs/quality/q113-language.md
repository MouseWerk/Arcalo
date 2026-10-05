# q113 B2: Language

Scope (plan113.md, B2): Settings → Sprache & Format gets „Wie das System“ besides Deutsch and English,
the default of new installs; the system language decides at every start, the first run and the splash
use it, and the shell and the UI agree. Method: code read of `i18n.rs`, `prefs.rs` (locale),
`settings_migrate.rs`, the shell's start (`lib.rs` setup, `os_locale`, `create_main_window`),
`lib/i18n.ts`, `lib/prefs.ts`, `lib/language.ts`, the first-run flow (`onboarding/`) and
`views/settings/PrefSections.tsx`; shots of the real app under Xvfb with `LANG=de_DE.UTF-8` and
`LANG=en_US.UTF-8` (scratchpad/q113-shots/language/).

## Built
1. „Wie das System“ / "Same as system". Stored as `locale.language: "system"` next to `"de"` and `"en"`
   (Rust `LanguageChoice`, resolved by `LocalePrefs::lang()`; the UI's `langOf`). It is the default of
   new installs. Settings → Sprache & Format shows three choices (Segmented, fits on one line at 900 px);
   the description names the system language as the shell read it. The first-run language step has it
   as a third card („Übernimmt bei jedem Start die Sprache des Betriebssystems. Jetzt: Deutsch.“), and
   the „Fertig“ summary says „Wie das System (Deutsch)“. Tests: prefs.rs, languageChoice.test.ts,
   flow.test.ts, e2e 300.
2. Existing users (settings step 13 `language-choice`). Decision: nobody's language changes with the
   update. A stored `de` or `en` stays, also where 1.12's first run had picked it from the system:
   that pick was shown on the language step and confirmed by going on, and 1.12 settings cannot tell
   an implicit pick from a choice. Only settings without a readable language (older settings without
   `locale`, a hand-edited value) get `de` written, which is what they read as before; without the
   step they would now follow the system. Tests: settings_migrate.rs (stored languages stay, missing
   ones become German, fixtures 1.6-1.9 stay German, new installs are „system“, idempotent).
3. Detection at every start. The shell reads the system locale once in `setup` (`i18n::set_system_lang`),
   before the settings, and resolves „Wie das System“ from it for the tray, menus, jump list,
   notifications, error messages, generated pages (inbox title, month folders, demo content) and the
   number format „as the language writes it“. The UI gets the same reading with every settings view
   (`system_language`), so both always agree; the locale tag parsers agree too (`de`, `de-AT`,
   `de_CH.UTF-8`, `de_AT@euro`; the UI's regex did not accept `de_DE` before).
   - Windows: the user's display languages (GetUserPreferredUILanguages, via sys-locale), not the
     regional format.
   - macOS: the preferred languages (System Settings → General → Language & Region).
   - Linux and other Unix: gettext's order, implemented in `i18n::locales_from_env`: the locale is the
     first set of `LC_ALL`, `LC_MESSAGES`, `LANG` (`LC_TIME` and the like do not count); unless it is
     unset, `C` or `POSIX`, the `LANGUAGE` list comes first. sys-locale read `LANGUAGE` even under
     `LC_ALL=C`, which gettext does not.
   - Among the preferred languages the first one the app has wins (`fr-CH:de-CH` → Deutsch); anything
     else is English. `ANNALO_LOCALE` still stands in for the system (tests, support).
4. Changes while running. Picked up at the next start (e2e 300 restarts one workspace under six
   variable sets). Live pickup is not done: Windows applies a new display language only after signing
   in again, macOS gives a program its languages when it starts, and a running process's environment
   on Linux does not change; none of them signals it cheaply to a running program.
5. First run and splash. The main window gets an initialization script with the resolved language
   (`window.__ARCALO_LANG__`; index.html cannot carry a script under the CSP). `i18n.ts` starts in it
   and `main.tsx` sets `<html lang>` before React renders, so the splash (whose only text is the name)
   and the first frame are in the right language; the intro on an English system is English from its
   first scene (e2e 300 checks no German word is left).
6. Number and date formats unchanged: the date format is its own setting (independent of the
   language); the number format, while unset, follows the resolved language in the UI
   (`numberFormatOf`) and in the shell (`CatsDecimal::Number`, `i18n::decimal_comma`).

## Found and fixed
| # | Severity | Finding | Cause | Fix | Test |
|---|----------|---------|-------|-----|------|
| 1 | High | A first run on an English system showed the German welcome (q113-branding.md) | the stored default was German; the first-run flow switched to the system language only after it had mounted (through its queued settings writes), so the intro started German and the switch did not reliably hold | new installs store „system“, the shell resolves it before the window loads, the UI starts in it; the first-run auto-switch is gone | e2e 300 (intro and language step on an English and a German system) |
| 2 | Medium | Shell and UI could disagree on a POSIX tag (`de_DE.UTF-8`): the shell read German, the UI's `langFromLocale` English | `/^de\b/` does not match before `_` | the same rule as the shell | languageChoice.test.ts |
| 3 | Low | Linux: `LANGUAGE` won even under `LC_ALL=C` | sys-locale's order differs from gettext's | own gettext-order reader | i18n.rs, e2e 300 |
| 4 | Low | `<html lang>` said `de` until the settings arrived, also on an English install | static attribute | set from the boot language before React | e2e 300 |

## Left
- No live pickup of a changed system language (see 4); the description of the setting says "at every
  start".
- The quick capture, quick search and presenter windows have no boot script; they take the language
  from the settings when they open (as before).
