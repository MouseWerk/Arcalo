//! Data of the notes widgets of the start page: „Vor einem Jahr“ (pages of this day in earlier
//! years, that day's daily note and a random older note), „Schreiben“ (words and new pages per
//! day from the activity journal), „Per Git-Sync geändert“ (the pages the last syncs pulled
//! from others, recorded by the shell with [`record_pulled`]) and the inbox of quick capture
//! (its entries, and filing one into a page with [`inbox_move`]).
//!
//! Everything reads bounded ranges through indexes (the journal by time, pages by id): nothing
//! here walks all pages or their texts.

use crate::tr;
use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::Ctx;
use crate::capture::{append_markdown, inbox_title};
use crate::db::{Database, PAGE_COLS, map_page};
use crate::error::{Error, Result};
use crate::model::Page;

/// Earliest year „Vor einem Jahr“ looks back to.
const MAX_YEARS: i32 = 10;
/// Pages per earlier year.
const PAGES_PER_YEAR: usize = 8;
/// A random note is at least this old (days since its last change).
const RANDOM_MIN_AGE_DAYS: i64 = 30;
/// Characters typed per word (German and English average, with the space).
pub const CHARS_PER_WORD: f64 = 6.0;
/// Longest statistics (days).
const MAX_WRITING_DAYS: u32 = 92;
/// Pulled pages remembered.
pub const MAX_PULLED: usize = 50;
/// Settings key of the pulled pages (JSON, newest first).
const PULLED_KEY: &str = "gitsync.pulled";

fn ts(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// The first words of a note's text: no frontmatter, headings, list or task marks.
pub fn excerpt(markdown: &str, max: usize) -> String {
    let body = match markdown.strip_prefix("---\n") {
        Some(rest) => rest.split_once("\n---").map_or(markdown, |(_, after)| after),
        None => markdown,
    };
    let mut out = String::new();
    for line in body.lines() {
        let l = line
            .trim()
            .trim_start_matches(['#', '>', '-', '*', '+'])
            .trim_start()
            .trim_start_matches("[ ] ")
            .trim_start_matches("[x] ")
            .trim();
        if l.is_empty() || l.starts_with("```") || l.starts_with("<!--") {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&l.replace("**", "").replace("[[", "").replace("]]", ""));
        if out.chars().count() >= max {
            break;
        }
    }
    if out.chars().count() > max {
        let cut: String = out.chars().take(max).collect();
        format!("{}…", cut.trim_end())
    } else {
        out
    }
}

// ----------------------------------------------------------------- a year ago

#[derive(Debug, Clone, Serialize)]
pub struct YearAgo {
    pub year: i32,
    pub years_ago: i32,
    /// That day's daily note.
    pub daily: Option<Page>,
    /// Pages created or edited that day (without the daily note).
    pub pages: Vec<Page>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RandomNote {
    pub page: Page,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResurfaceData {
    pub date: NaiveDate,
    /// Earlier years with something on this day, the latest first.
    pub years: Vec<YearAgo>,
    /// A note not changed for a while, picked by the seed.
    pub random: Option<RandomNote>,
    /// How many notes the random one is picked from.
    pub pool: i64,
}

/// Pages of `day` (local): created or edited per the journal, created per the page, or saved
/// as a version; newest activity first, at most `limit`.
fn pages_of_day<Tz: TimeZone>(ctx: &Ctx<Tz>, day: NaiveDate, limit: usize) -> Result<Vec<Page>> {
    let from = ts(ctx.day_start(day));
    let to = ts(ctx.day_start(day + Duration::days(1)));
    let mut st = ctx.db.conn().prepare_cached(
        "SELECT page_id, MAX(at) FROM (
             SELECT page_id, at FROM activity
              WHERE at >= ?1 AND at < ?2 AND page_id IS NOT NULL AND kind IN ('page_created', 'page_edited')
             UNION ALL
             SELECT page_id, created_at FROM page_versions WHERE created_at >= ?1 AND created_at < ?2
             UNION ALL
             SELECT id, created_at FROM pages WHERE created_at >= ?1 AND created_at < ?2
         ) GROUP BY page_id ORDER BY MAX(at) DESC LIMIT 40",
    )?;
    let ids: Vec<i64> = st.query_map(params![from, to], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let mut out = vec![];
    for id in ids {
        if let Some(p) = page_alive(ctx.db, id)?
            && p.daily_date.is_none()
        {
            out.push(p);
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

fn page_alive(db: &Database, id: i64) -> Result<Option<Page>> {
    Ok(db
        .conn()
        .query_row(&format!("SELECT {PAGE_COLS} FROM pages WHERE id = ?1 AND deleted_at IS NULL"), [id], map_page)
        .optional()?)
}

fn daily_of(db: &Database, day: NaiveDate) -> Result<Option<Page>> {
    Ok(db
        .conn()
        .query_row(
            &format!("SELECT {PAGE_COLS} FROM pages WHERE daily_date = ?1 AND deleted_at IS NULL"),
            [day.format("%Y-%m-%d").to_string()],
            map_page,
        )
        .optional()?)
}

/// „Vor einem Jahr“: this day in the earlier years (29 February only in leap years) and a
/// random note that has not changed for a month, picked by `seed`.
pub fn resurface<Tz: TimeZone>(ctx: &Ctx<Tz>, seed: u64) -> Result<ResurfaceData> {
    let today = ctx.today;
    let mut years = vec![];
    for back in 1..=MAX_YEARS {
        let Some(day) = NaiveDate::from_ymd_opt(today.year() - back, today.month(), today.day()) else {
            continue;
        };
        let daily = daily_of(ctx.db, day)?;
        let pages = pages_of_day(ctx, day, PAGES_PER_YEAR)?;
        if daily.is_some() || !pages.is_empty() {
            years.push(YearAgo { year: day.year(), years_ago: back, daily, pages });
        }
    }
    let before = ts(ctx.now - Duration::days(RANDOM_MIN_AGE_DAYS));
    let pool: i64 = ctx.db.conn().query_row(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND daily_date IS NULL AND updated_at < ?1",
        [&before],
        |r| r.get(0),
    )?;
    let random = if pool > 0 {
        let offset = (seed % pool as u64) as i64;
        let page = ctx.db.conn().query_row(
            &format!(
                "SELECT {PAGE_COLS} FROM pages WHERE deleted_at IS NULL AND daily_date IS NULL AND updated_at < ?1
                 ORDER BY id LIMIT 1 OFFSET ?2"
            ),
            params![before, offset],
            map_page,
        )?;
        let content: String =
            ctx.db.conn().query_row("SELECT content FROM pages WHERE id = ?1", [page.id], |r| r.get(0))?;
        Some(RandomNote { excerpt: excerpt(&content, 220), page })
    } else {
        None
    };
    Ok(ResurfaceData { date: today, years, random, pool })
}

// ----------------------------------------------------------------- writing

#[derive(Debug, Clone, Serialize)]
pub struct WritingDay {
    pub date: NaiveDate,
    /// Words written (characters typed / [`CHARS_PER_WORD`]).
    pub words: i64,
    /// Pages created.
    pub created: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WritingData {
    /// One entry per day, oldest first, today last.
    pub days: Vec<WritingDay>,
    pub words: i64,
    pub created: i64,
    /// Days in a row up to today (or yesterday) with something written.
    pub streak: usize,
}

/// „Schreiben“: words and new pages per local day of the last `days` days, from the activity
/// journal (edits of a page within an hour are one event with the characters they changed).
pub fn writing<Tz: TimeZone>(ctx: &Ctx<Tz>, days: u32) -> Result<WritingData> {
    let days = days.clamp(1, MAX_WRITING_DAYS);
    let first = ctx.today - Duration::days(i64::from(days) - 1);
    let mut st = ctx.db.conn().prepare_cached(
        "SELECT at, kind, amount FROM activity WHERE at >= ?1 AND kind IN ('page_created', 'page_edited')",
    )?;
    let rows = st.query_map([ts(ctx.day_start(first))], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    })?;
    let mut by_day: BTreeMap<NaiveDate, (i64, i64)> = BTreeMap::new();
    for row in rows {
        let (at, kind, amount) = row?;
        let Ok(t) = DateTime::parse_from_rfc3339(&at) else { continue };
        let day = ctx.local_day(t.with_timezone(&Utc));
        let e = by_day.entry(day).or_default();
        e.0 += amount.max(0);
        if kind == "page_created" {
            e.1 += 1;
        }
    }
    let list: Vec<WritingDay> = (0..days)
        .map(|i| {
            let date = first + Duration::days(i64::from(i));
            let (chars, created) = by_day.get(&date).copied().unwrap_or_default();
            WritingDay { date, words: (chars as f64 / CHARS_PER_WORD).round() as i64, created }
        })
        .collect();
    // Today may still be empty: the streak then counts from yesterday.
    let mut streak = 0;
    let mut it = list.iter().rev().peekable();
    if it.peek().is_some_and(|d| d.words == 0 && d.created == 0) {
        it.next();
    }
    for d in it {
        if d.words == 0 && d.created == 0 {
            break;
        }
        streak += 1;
    }
    Ok(WritingData {
        words: list.iter().map(|d| d.words).sum(),
        created: list.iter().map(|d| d.created).sum(),
        days: list,
        streak,
    })
}

// ----------------------------------------------------------------- pulled by Git sync

/// How a sync changed a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PulledChange {
    Changed,
    Created,
    Trashed,
    Conflict,
}

/// A page a sync pulled from the server, as recorded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PulledRecord {
    pub page_id: i64,
    pub title: String,
    pub change: PulledChange,
    pub at: DateTime<Utc>,
}

/// Remembers the pages a sync took over from the server (newest first, one entry per page,
/// at most [`MAX_PULLED`]).
pub fn record_pulled(db: &Database, changes: &[(i64, PulledChange)], at: DateTime<Utc>) -> Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let mut list = pulled_records(db)?;
    let mut fresh = vec![];
    let mut seen = HashSet::new();
    for (id, change) in changes {
        if !seen.insert(*id) {
            continue;
        }
        let title: String = db
            .conn()
            .query_row("SELECT title FROM pages WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .unwrap_or_default();
        fresh.push(PulledRecord { page_id: *id, title, change: *change, at });
    }
    list.retain(|r| !seen.contains(&r.page_id));
    fresh.extend(list);
    fresh.truncate(MAX_PULLED);
    db.meta_set(PULLED_KEY, &serde_json::to_string(&fresh)?)
}

fn pulled_records(db: &Database) -> Result<Vec<PulledRecord>> {
    Ok(db.meta_get(PULLED_KEY)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

#[derive(Debug, Clone, Serialize)]
pub struct PulledItem {
    #[serde(flatten)]
    pub record: PulledRecord,
    /// The page as it is now (`None` when it is gone or in the trash).
    pub page: Option<Page>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PulledData {
    /// Git sync is switched on.
    pub enabled: bool,
    /// A remote is set (a sync can run).
    pub configured: bool,
    pub items: Vec<PulledItem>,
}

/// „Per Git-Sync geändert“: the pages the last syncs pulled from others, newest first.
pub fn pulled<Tz: TimeZone>(ctx: &Ctx<Tz>, limit: usize) -> Result<PulledData> {
    let git = &ctx.settings.git_sync;
    let mut items = vec![];
    for record in pulled_records(ctx.db)?.into_iter().take(limit.clamp(1, MAX_PULLED)) {
        let page = page_alive(ctx.db, record.page_id)?;
        items.push(PulledItem { record, page });
    }
    Ok(PulledData { enabled: git.enabled, configured: !git.remote_url.trim().is_empty(), items })
}

// ----------------------------------------------------------------- inbox

/// An entry of the inbox page: a capture under its timestamp.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InboxItem {
    /// Position among the entries (0 = first on the page).
    pub index: usize,
    /// „23.09.2026, 14:30“ as the capture wrote it.
    pub stamp: String,
    /// The captured Markdown.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InboxData {
    /// The inbox page (`None` until the first capture into it).
    pub page_id: Option<i64>,
    pub title: String,
    /// The newest first, at most the limit.
    pub items: Vec<InboxItem>,
    pub total: usize,
}

/// `**23.09.2026, 14:30**`: the timestamp line of an inbox entry.
fn stamp_of(line: &str) -> Option<&str> {
    let inner = line.trim().strip_prefix("**")?.strip_suffix("**")?;
    let b = inner.as_bytes();
    let digits = |r: std::ops::Range<usize>| r.into_iter().all(|i| b.get(i).is_some_and(u8::is_ascii_digit));
    let ok = inner.len() == 17
        && digits(0..2)
        && b[2] == b'.'
        && digits(3..5)
        && b[5] == b'.'
        && digits(6..10)
        && &inner[10..12] == ", "
        && digits(12..14)
        && b[14] == b':'
        && digits(15..17);
    ok.then_some(inner)
}

/// The entries of an inbox page with the line range each takes (header to the next header).
fn entries(content: &str) -> Vec<(InboxItem, std::ops::Range<usize>)> {
    let lines: Vec<&str> = content.lines().collect();
    let starts: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| stamp_of(l).is_some()).map(|(i, _)| i).collect();
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let end = starts.get(n + 1).copied().unwrap_or(lines.len());
            let text = lines[start + 1..end].join("\n").trim().to_owned();
            let stamp = stamp_of(lines[start]).unwrap_or_default().to_owned();
            (InboxItem { index: n, stamp, text }, start..end)
        })
        .collect()
}

/// The entries of an inbox page (oldest first, as on the page).
pub fn inbox_items(content: &str) -> Vec<InboxItem> {
    entries(content).into_iter().map(|(i, _)| i).collect()
}

fn inbox_page(db: &Database, title: &str) -> Result<Option<Page>> {
    let title = if title.trim().is_empty() { inbox_title() } else { title.trim() };
    db.page_by_title(title)
}

/// The inbox: the captures waiting on the inbox page (the target „Posteingang“ of quick
/// capture, Settings → Schnellerfassung), the newest first.
pub fn inbox<Tz: TimeZone>(ctx: &Ctx<Tz>, limit: usize) -> Result<InboxData> {
    let title = ctx.settings.capture.inbox_title.trim();
    let title = if title.is_empty() { inbox_title().to_owned() } else { title.to_owned() };
    let Some(page) = inbox_page(ctx.db, &title)?.filter(|p| p.deleted_at.is_none()) else {
        return Ok(InboxData { page_id: None, title, items: vec![], total: 0 });
    };
    let mut items = inbox_items(&ctx.db.page_doc(page.id)?.content);
    let total = items.len();
    items.reverse();
    items.truncate(limit.clamp(1, 100));
    Ok(InboxData { page_id: Some(page.id), title: page.title, items, total })
}

/// Content without the line range `r`, with no double blank line left where it was.
fn without_lines(content: &str, r: std::ops::Range<usize>) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut kept: Vec<&str> = lines[..r.start].to_vec();
    let rest = &lines[r.end..];
    while kept.last().is_some_and(|l| l.trim().is_empty()) && rest.first().is_none_or(|l| l.trim().is_empty()) {
        kept.pop();
    }
    kept.extend_from_slice(rest);
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) }
}

/// Takes entry `index` off the inbox page `inbox_page_id` (only while its text is still
/// `expect`, so a page edited meanwhile is never cut in the wrong place) and, with `target`,
/// appends its text to that page. Returns the target's title.
pub fn inbox_move(
    db: &Database,
    inbox_page_id: i64,
    index: usize,
    expect: &str,
    target: Option<i64>,
) -> Result<Option<String>> {
    db.atomic(|| {
        let content = db.page_doc(inbox_page_id)?.content;
        let list = entries(&content);
        let Some((item, range)) = list.into_iter().find(|(i, _)| i.index == index) else {
            return Err(Error::State(
                tr!("Der Eintrag ist nicht mehr im Posteingang", "The entry is no longer in the inbox").into(),
            ));
        };
        if item.text.trim() != expect.trim() {
            return Err(Error::State(
                tr!("Der Posteingang wurde inzwischen geändert", "The inbox was changed meanwhile").into(),
            ));
        }
        let title = match target {
            Some(id) if id == inbox_page_id => {
                return Err(Error::State(tr!("Bitte eine andere Seite wählen", "Choose another page").into()));
            }
            Some(id) => {
                let page = db.page(id)?;
                if page.deleted_at.is_some() {
                    return Err(Error::not_found("page", id.to_string()));
                }
                let before = db.page_doc(id)?.content;
                db.save_page_content(id, &append_markdown(&before, &item.text))?;
                Some(page.title)
            }
            None => None,
        };
        db.save_page_content(inbox_page_id, &without_lines(&content, range))?;
        Ok(title)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn excerpt_skips_marks_and_frontmatter() {
        let md = "---\nstatus: offen\n---\n# Titel\n\n- [ ] Eine **Aufgabe**\n> Zitat mit [[Link]]\n";
        assert_eq!(excerpt(md, 200), "Titel Eine Aufgabe Zitat mit Link");
        assert_eq!(excerpt("abcdefghij", 4), "abcd…");
    }

    #[test]
    fn inbox_entries_parse_and_move() {
        let md = "Vorne\n\n**23.09.2026, 14:30**\n\n- erste\n\n**24.09.2026, 09:05**\n\nZweite Zeile\nmehr\n";
        let items = inbox_items(md);
        assert_eq!(items.len(), 2);
        assert_eq!((items[0].stamp.as_str(), items[0].text.as_str()), ("23.09.2026, 14:30", "- erste"));
        assert_eq!(items[1].text, "Zweite Zeile\nmehr");
        // Not a timestamp: bold text of other shapes.
        assert!(stamp_of("**Wichtig**").is_none() && stamp_of("**23.09.2026 14:30**").is_none());
        assert_eq!(without_lines(md, 2..6), "Vorne\n\n**24.09.2026, 09:05**\n\nZweite Zeile\nmehr\n");
        assert_eq!(without_lines(md, 6..10), "Vorne\n\n**23.09.2026, 14:30**\n\n- erste\n");

        let db = Database::open_in_memory().unwrap();
        let ib = db.create_page(None, "Posteingang", Some("inbox")).unwrap();
        db.save_page_content(ib.id, md).unwrap();
        let target = db.create_page(None, "Projekt", None).unwrap();
        db.save_page_content(target.id, "# Projekt\n").unwrap();
        // A stale view of the entry is refused, the page stays as it was.
        assert!(inbox_move(&db, ib.id, 0, "- anders", Some(target.id)).is_err());
        assert_eq!(db.page_doc(ib.id).unwrap().content, md);
        let title = inbox_move(&db, ib.id, 0, "- erste", Some(target.id)).unwrap();
        assert_eq!(title.as_deref(), Some("Projekt"));
        assert_eq!(db.page_doc(target.id).unwrap().content, "# Projekt\n\n- erste\n");
        assert_eq!(inbox_items(&db.page_doc(ib.id).unwrap().content).len(), 1);
        // Done without a target: just taken off the inbox.
        assert_eq!(inbox_move(&db, ib.id, 0, "Zweite Zeile\nmehr", None).unwrap(), None);
        assert_eq!(db.page_doc(ib.id).unwrap().content, "Vorne\n");
        assert!(inbox_move(&db, ib.id, 0, "x", None).is_err());

        let settings = Settings::default();
        let tz = Utc;
        let ctx = Ctx::new(
            &db,
            &tz,
            at("2026-10-01T10:00:00Z"),
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            &[],
            &settings,
        );
        let data = super::inbox(&ctx, 10).unwrap();
        assert_eq!((data.page_id, data.total), (Some(ib.id), 0));
    }

    #[test]
    fn writing_counts_words_per_local_day() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Notiz", None).unwrap();
        // Only the events below (creating the page recorded one at the real time).
        db.conn().execute("DELETE FROM activity", []).unwrap();
        let ins = |at: &str, kind: &str, amount: i64| {
            db.conn()
                .execute(
                    "INSERT INTO activity (at, kind, page_id, title, amount) VALUES (?1, ?2, ?3, 'Notiz', ?4)",
                    params![at, kind, p.id, amount],
                )
                .unwrap();
        };
        ins("2026-09-29T08:00:00Z", "page_edited", 600);
        ins("2026-09-30T08:00:00Z", "page_created", 120);
        ins("2026-09-30T09:00:00Z", "page_edited", 60);
        // Before the window and other kinds do not count.
        ins("2026-08-01T08:00:00Z", "page_edited", 6000);
        ins("2026-09-30T10:00:00Z", "task_done", 999);
        let settings = Settings::default();
        let tz = Utc;
        let ctx = Ctx::new(
            &db,
            &tz,
            at("2026-10-01T10:00:00Z"),
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            &[],
            &settings,
        );
        let w = writing(&ctx, 14).unwrap();
        assert_eq!(w.days.len(), 14);
        assert_eq!(w.days.last().unwrap().date.to_string(), "2026-10-01");
        let get = |d: &str| w.days.iter().find(|x| x.date.to_string() == d).map(|x| (x.words, x.created)).unwrap();
        assert_eq!(get("2026-09-29"), (100, 0));
        assert_eq!(get("2026-09-30"), (30, 1));
        assert_eq!((w.words, w.created, w.streak), (130, 1, 2), "today is still empty: the streak counts to yesterday");
    }

    #[test]
    fn resurface_finds_this_day_in_earlier_years() {
        let db = Database::open_in_memory().unwrap();
        let old = db.create_page(None, "Planung 2025", None).unwrap();
        db.conn()
            .execute(
                "UPDATE pages SET created_at = '2025-10-01T09:00:00Z', updated_at = '2025-10-02T09:00:00Z' WHERE id = ?1",
                [old.id],
            )
            .unwrap();
        db.save_page_content(old.id, "# Planung\n\nWas wir uns vorgenommen haben.\n").unwrap();
        db.conn().execute("UPDATE pages SET updated_at = '2025-10-02T09:00:00Z' WHERE id = ?1", [old.id]).unwrap();
        let daily = db.daily_note(NaiveDate::from_ymd_opt(2024, 10, 1).unwrap()).unwrap();
        let fresh = db.create_page(None, "Heute neu", None).unwrap();
        let settings = Settings::default();
        let tz = Utc;
        let ctx = Ctx::new(
            &db,
            &tz,
            at("2026-10-01T10:00:00Z"),
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            &[],
            &settings,
        );
        let r = resurface(&ctx, 0).unwrap();
        let years: Vec<_> = r
            .years
            .iter()
            .map(|y| (y.year, y.daily.as_ref().map(|d| d.id), y.pages.iter().map(|p| p.id).collect::<Vec<_>>()))
            .collect();
        assert_eq!(years, [(2025, None, vec![old.id]), (2024, Some(daily.id), vec![])]);
        // The random note is an older one (not the new page, not a daily note).
        let pick = r.random.unwrap();
        assert_ne!(pick.page.id, fresh.id);
        assert!(pick.page.daily_date.is_none());
        assert!(r.pool >= 1);
        // Another seed may pick another note, the same seed the same one.
        assert_eq!(resurface(&ctx, 0).unwrap().random.unwrap().page.id, pick.page.id);
    }

    #[test]
    fn pulled_pages_are_remembered_newest_first() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Alpha", None).unwrap();
        let b = db.create_page(None, "Beta", None).unwrap();
        record_pulled(&db, &[(a.id, PulledChange::Changed), (b.id, PulledChange::Created)], at("2026-10-01T08:00:00Z"))
            .unwrap();
        record_pulled(&db, &[(a.id, PulledChange::Conflict)], at("2026-10-01T09:00:00Z")).unwrap();
        record_pulled(&db, &[], at("2026-10-01T10:00:00Z")).unwrap();
        let mut settings = Settings::default();
        settings.git_sync.enabled = true;
        let tz = Utc;
        let ctx = Ctx::new(
            &db,
            &tz,
            at("2026-10-01T10:00:00Z"),
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            &[],
            &settings,
        );
        let p = pulled(&ctx, 10).unwrap();
        let got: Vec<_> = p.items.iter().map(|i| (i.record.title.as_str(), i.record.change)).collect();
        assert_eq!(got, [("Alpha", PulledChange::Conflict), ("Beta", PulledChange::Created)]);
        assert!(p.enabled && !p.configured);
        assert!(p.items.iter().all(|i| i.page.is_some()));
    }
}
