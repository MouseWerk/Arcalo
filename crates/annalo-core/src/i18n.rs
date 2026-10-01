//! The language of the texts the backend writes for people: error messages, notifications,
//! the tray and menus, AI instructions and generated Markdown. Settings → Sprache sets it
//! ([`set_lang`] at start and on every save); German until then, like the stored default.
//!
//! Texts are written as pairs where they are used: `tr!("Gespeichert", "Saved")` for a fixed
//! text, `trf!("{n} Termine", "{n} meetings")` for one with values (both are `format!`
//! strings with the same arguments). Machine formats stay as they are in every language:
//! CATS columns, frontmatter keys, HTML markers and the words the parsers accept.

use std::sync::atomic::{AtomicU8, Ordering};

use crate::prefs::{Language, NumberFormat};

static LANG: AtomicU8 = AtomicU8::new(0);
/// Settings → Sprache & Format „Zahlen“: 0 by the language, 1 comma, 2 point.
static NUMBERS: AtomicU8 = AtomicU8::new(0);

// Tests run in parallel threads: there the language is per thread (German unless a test
// switches it with `with_lang`), so a test in English does not change another's texts.
#[cfg(test)]
thread_local! {
    static TEST_LANG: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    static TEST_NUMBERS: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

/// The current language.
pub fn lang() -> Language {
    if is_en() { Language::En } else { Language::De }
}

/// Whether texts are written in English.
pub fn is_en() -> bool {
    #[cfg(test)]
    return TEST_LANG.with(|l| l.get() == 1);
    #[cfg(not(test))]
    return LANG.load(Ordering::Relaxed) == 1;
}

/// Sets the language; returns whether it changed (the shell then rebuilds its menus).
pub fn set_lang(lang: Language) -> bool {
    let v = u8::from(lang == Language::En);
    LANG.swap(v, Ordering::Relaxed) != v
}

/// Sets the decimal separator of numbers and hours (`Auto` follows the language).
pub fn set_number_format(f: NumberFormat) {
    NUMBERS.store(
        match f {
            NumberFormat::Auto => 0,
            NumberFormat::Comma => 1,
            NumberFormat::Point => 2,
        },
        Ordering::Relaxed,
    );
}

/// Whether numbers are written with a decimal comma: the setting, else German.
pub fn decimal_comma() -> bool {
    #[cfg(test)]
    let n = TEST_NUMBERS.with(|n| n.get());
    #[cfg(not(test))]
    let n = NUMBERS.load(Ordering::Relaxed);
    match n {
        1 => true,
        2 => false,
        _ => !is_en(),
    }
}

/// A number formatted with a point (`format!("{:.2}", …)`) in the reader's notation: `28,00`
/// in German, `28.00` in English. Machine formats (CATS) do not use this.
pub fn decimal(point: String) -> String {
    if decimal_comma() { point.replace('.', ",") } else { point }
}

/// The language of a locale tag such as `de-DE`, `de_AT.UTF-8` or `en-US`: German for German,
/// English for anything else (and for none).
pub fn lang_of_locale(tag: &str) -> Language {
    let t = tag.trim().to_ascii_lowercase();
    if t == "de" || t.starts_with("de-") || t.starts_with("de_") || t.starts_with("de.") {
        Language::De
    } else {
        Language::En
    }
}

/// Picks the German or English text: `tr!("Öffnen", "Open")`.
#[macro_export]
macro_rules! tr {
    ($de:expr, $en:expr $(,)?) => {
        if $crate::i18n::is_en() { $en } else { $de }
    };
}

/// Formats the German or English text with the same arguments:
/// `trf!("„{name}“ nicht gefunden", "“{name}” not found")`.
#[macro_export]
macro_rules! trf {
    ($de:literal, $en:literal $(, $($arg:tt)*)?) => {
        if $crate::i18n::is_en() { format!($en $(, $($arg)*)?) } else { format!($de $(, $($arg)*)?) }
    };
}

/// Frontmatter keys Annalo reads and writes: the German name (as older notes have it) and its
/// English alias. Both are read in every language (the first one in a page wins); new content
/// is written with the display language's name. Same table as the UI's `KEY_ALIASES`.
pub const KEY_ALIASES: [(&str, &str); 12] = [
    ("vorgang", "activity"),
    ("netzplan", "network"),
    ("eigenschaften", "properties"),
    ("ansicht", "view"),
    ("datum", "date"),
    ("uhrzeit", "time"),
    ("ort", "location"),
    ("organisator", "organizer"),
    ("teilnehmer", "attendees"),
    ("von", "from"),
    ("an", "to"),
    ("betreff", "subject"),
];

/// A frontmatter key in either language under its German name (lowercase, trimmed).
pub fn canonical_key(key: &str) -> String {
    let k = key.trim().to_lowercase();
    KEY_ALIASES.iter().find(|(_, en)| *en == k).map_or(k, |(de, _)| (*de).to_owned())
}

/// The name to write for a known key (given by its German name) in the display language.
pub fn key(de: &'static str) -> &'static str {
    if is_en() { KEY_ALIASES.iter().find(|(d, _)| *d == de).map_or(de, |(_, en)| en) } else { de }
}

/// Runs `f` with this thread's language set to `lang` (tests only).
#[cfg(test)]
pub(crate) fn with_lang<T>(lang: Language, f: impl FnOnce() -> T) -> T {
    let before = TEST_LANG.with(|l| l.replace(u8::from(lang == Language::En)));
    let out = f();
    TEST_LANG.with(|l| l.set(before));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_keys_in_both_languages() {
        assert_eq!(canonical_key("Activity"), "vorgang");
        assert_eq!(canonical_key(" properties "), "eigenschaften");
        assert_eq!(canonical_key("vorgang"), "vorgang");
        assert_eq!(canonical_key("status"), "status");
        assert_eq!(key("vorgang"), "vorgang");
        with_lang(Language::En, || {
            assert_eq!(key("vorgang"), "activity");
            assert_eq!(key("teilnehmer"), "attendees");
            assert_eq!(key("tags"), "tags");
        });
    }

    #[test]
    fn pairs_follow_the_language() {
        let n = 3;
        assert_eq!(with_lang(Language::De, || tr!("Öffnen", "Open")), "Öffnen");
        assert_eq!(with_lang(Language::En, || tr!("Öffnen", "Open")), "Open");
        assert_eq!(with_lang(Language::En, || trf!("{n} Termine", "{n} meetings")), "3 meetings");
        assert_eq!(with_lang(Language::De, || trf!("{} Termine", "{} meetings", n)), "3 Termine");
    }

    #[test]
    fn decimals_follow_the_language_or_the_setting() {
        let h = || decimal(format!("{:.2}", 28.0));
        assert_eq!(with_lang(Language::De, h), "28,00");
        assert_eq!(with_lang(Language::En, h), "28.00");
        let with_numbers = |n: u8, lang: Language| {
            let before = TEST_NUMBERS.with(|c| c.replace(n));
            let out = with_lang(lang, h);
            TEST_NUMBERS.with(|c| c.set(before));
            out
        };
        assert_eq!(with_numbers(1, Language::En), "28,00", "comma chosen in English");
        assert_eq!(with_numbers(2, Language::De), "28.00", "point chosen in German");
        // The process-wide setting maps the choices.
        set_number_format(NumberFormat::Point);
        assert_eq!(NUMBERS.load(Ordering::Relaxed), 2);
        set_number_format(NumberFormat::Auto);
        assert_eq!(NUMBERS.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn set_lang_reports_a_change() {
        // The only test that touches the process-wide language (the others use their thread's).
        set_lang(Language::De);
        assert!(set_lang(Language::En));
        assert!(!set_lang(Language::En));
        assert_eq!(LANG.load(Ordering::Relaxed), 1);
        assert!(set_lang(Language::De));
    }

    /// An English workspace: generated pages, samples and the folders they use, and that the
    /// German names of an older workspace keep working.
    #[test]
    fn content_in_english() {
        use crate::db::Database;
        with_lang(Language::En, || {
            let db = Database::open_in_memory().unwrap();
            let day = chrono::NaiveDate::from_ymd_opt(2026, 9, 23).unwrap();
            // A new daily note, and capture into its notes section.
            let daily = db.daily_note(day).unwrap();
            assert_eq!(db.page_doc(daily.id).unwrap().content, "## Focus\n\n- [ ] \n\n## Notes\n\n");
            crate::desktop::append_to_daily(&db, day, "todo Call back").unwrap();
            assert!(db.page_doc(daily.id).unwrap().content.ends_with("## Notes\n\n- [ ] Call back\n"));
            // Samples: English pages, the templates folder in English, sample removal.
            assert!(crate::demo::seed(&db, chrono::Utc::now()).unwrap());
            assert!(db.page_by_title("Architecture").unwrap().is_some());
            let titles: Vec<_> = db.list_templates().unwrap().into_iter().map(|p| p.title).collect();
            assert_eq!(titles, ["Meeting", "Customer meeting"]);
            assert_eq!(db.templates_title().unwrap(), crate::templates::TEMPLATES_TITLE_EN);
            // Template tasks do not count as open tasks.
            let counts = db.open_task_counts("2026-09-23", None).unwrap();
            assert_eq!(
                counts.open, 6,
                "3 on Welcome, 2 in the weekly sync, 1 in the daily note; none from the templates"
            );
            crate::demo::remove(&db).unwrap();
            assert!(db.page_by_title("Architecture").unwrap().is_none());
            assert!(db.page_by_title("Welcome").unwrap().is_none());
        });
        // A German workspace switched to English keeps its „Vorlagen“ and „Notizen“.
        let db = Database::open_in_memory().unwrap();
        let day = chrono::NaiveDate::from_ymd_opt(2026, 9, 23).unwrap();
        let daily = db.daily_note(day).unwrap();
        let root = db.templates_root().unwrap();
        with_lang(Language::En, || {
            assert_eq!(db.templates_title().unwrap(), crate::templates::TEMPLATES_TITLE);
            assert_eq!(db.templates_root().unwrap().id, root.id);
            crate::desktop::append_to_daily(&db, day, "Idea").unwrap();
            assert!(db.page_doc(daily.id).unwrap().content.ends_with("## Notizen\n\n- Idea\n"));
        });
    }

    #[test]
    fn locale_tags() {
        for de in ["de", "de-DE", "DE-at", "de_CH.UTF-8", "de.UTF-8"] {
            assert_eq!(lang_of_locale(de), Language::De, "{de}");
        }
        for en in ["en-US", "fr-FR", "", "C", "dex"] {
            assert_eq!(lang_of_locale(en), Language::En, "{en}");
        }
    }
}
