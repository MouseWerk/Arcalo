//! `/zeit` chips in notes and the bookings behind them.
//!
//! A booked `/zeit` line becomes a chip, stored in the Markdown as
//! `<time-entry id="12" hours="1,50" target="NP-8801/1020" la="DEV" date="2026-10-04">Text</time-entry>`.
//! The note shows the booking: when the entry is edited elsewhere (timesheet, Kalender, entry
//! dialog) the chip is rewritten with the new values, and when it is deleted the chip keeps its
//! values with `state="deleted"`. A chip belongs to its entry only on the entry's page and only
//! once (the first in the note): copies show as not booked instead of sharing the booking.

use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;
use crate::model::{TimeEntry, TimeEntryRow};

/// A chip found in a note's Markdown.
#[derive(Debug, Clone, PartialEq)]
pub struct Chip {
    /// Byte range of the whole `<time-entry …>…</time-entry>` element.
    pub range: std::ops::Range<usize>,
    /// Attributes in their order, unescaped.
    pub attrs: Vec<(String, String)>,
    pub text: String,
}

impl Chip {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn entry_id(&self) -> Option<i64> {
        self.attr("id").and_then(|v| v.trim().parse().ok())
    }
}

/// What a chip shows of its booking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChipValues {
    pub minutes: i64,
    /// `NP-8801/1020` (or the Netzplan alone).
    pub target: String,
    pub leistungsart: Option<String>,
    /// Local day of the booking.
    pub date: NaiveDate,
    pub text: String,
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn escape_attr(s: &str) -> String {
    escape_text(s).replace('"', "&quot;")
}

/// The chips of a note, in document order.
pub fn chips(content: &str) -> Vec<Chip> {
    let mut out = vec![];
    let mut from = 0;
    while let Some(i) = content[from..].find("<time-entry") {
        let start = from + i;
        let rest = &content[start..];
        let parsed = (|| {
            let open_end = rest.find('>')?;
            let head = &rest["<time-entry".len()..open_end];
            if !head.is_empty() && !head.starts_with(char::is_whitespace) {
                return None;
            }
            let close = rest[open_end + 1..].find("</time-entry>")?;
            let text = &rest[open_end + 1..open_end + 1 + close];
            if text.contains('<') {
                return None;
            }
            let mut attrs = vec![];
            let mut h = head.trim_start();
            while let Some(eq) = h.find("=\"") {
                let name = h[..eq].trim();
                let after = &h[eq + 2..];
                let end = after.find('"')?;
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return None;
                }
                attrs.push((name.to_owned(), unescape(&after[..end])));
                h = after[end + 1..].trim_start();
            }
            let len = open_end + 1 + close + "</time-entry>".len();
            Some(Chip { range: start..start + len, attrs, text: unescape(text) })
        })();
        match parsed {
            Some(c) => {
                from = c.range.end;
                out.push(c);
            }
            None => from = start + "<time-entry".len(),
        }
    }
    out
}

/// Hours as a chip stores them: two decimals, with the separator the chip already uses
/// (`1,50` or `1.50`).
pub fn chip_hours(minutes: i64, point: bool) -> String {
    let cents = (minutes * 100 + 30).div_euclid(60);
    format!("{}{}{:02}", cents.div_euclid(100), if point { '.' } else { ',' }, cents.rem_euclid(100))
}

/// The chip's Markdown: the attributes in a fixed order (`id`, `hours`, `target`, `la`, `date`,
/// `state`; the editor writes the same), so a rewrite changes only what changed.
pub fn render(attrs: &[(String, String)], text: &str) -> String {
    const ORDER: [&str; 6] = ["id", "hours", "target", "la", "date", "state"];
    let mut s = String::from("<time-entry");
    let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    for k in ORDER {
        // id, hours and target are always written (as the editor does); the others when set.
        match get(k) {
            Some(v) if !v.is_empty() || k == "id" || k == "hours" || k == "target" => {
                s.push_str(&format!(" {k}=\"{}\"", escape_attr(v)))
            }
            None if k == "id" || k == "hours" || k == "target" => s.push_str(&format!(" {k}=\"\"")),
            _ => {}
        }
    }
    // Attributes of a later version are kept (after the known ones).
    for (k, v) in attrs.iter().filter(|(k, _)| !ORDER.contains(&k.as_str())) {
        s.push_str(&format!(" {k}=\"{}\"", escape_attr(v)));
    }
    s.push('>');
    s.push_str(&escape_text(text));
    s.push_str("</time-entry>");
    s
}

/// Rewrites the chip of `entry_id` (the first one not marked deleted; copies stay as they are) with the booking's
/// current `values`, or marks it deleted (`None`). `None` when nothing changed.
pub fn rewrite(content: &str, entry_id: i64, values: Option<&ChipValues>) -> Option<String> {
    // A chip already marked deleted is history: an entry that got its id later (SQLite reuses
    // the highest id) belongs to a newer chip.
    let chip =
        chips(content).into_iter().find(|c| c.entry_id() == Some(entry_id) && c.attr("state") != Some("deleted"))?;
    let mut attrs = chip.attrs.clone();
    let mut set = |k: &str, v: String| match attrs.iter_mut().find(|(n, _)| n == k) {
        Some(a) => a.1 = v,
        None => attrs.push((k.to_owned(), v)),
    };
    let text = match values {
        Some(v) => {
            let point = chip.attr("hours").is_some_and(|h| h.contains('.') && !h.contains(','));
            set("hours", chip_hours(v.minutes, point));
            set("target", v.target.clone());
            set("la", v.leistungsart.clone().unwrap_or_default());
            set("date", v.date.format("%Y-%m-%d").to_string());
            set("state", String::new());
            v.text.clone()
        }
        None => {
            set("state", "deleted".into());
            chip.text.clone()
        }
    };
    let next = render(&attrs, &text);
    if next == content[chip.range.clone()] {
        return None;
    }
    Some(format!("{}{}{}", &content[..chip.range.start], next, &content[chip.range.end..]))
}

/// How a chip in a note relates to its booking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChipLink {
    /// The booking of this chip.
    Linked,
    /// The booking belongs to a chip in another note: this one is a copy.
    Elsewhere,
    /// No such booking here (deleted, or the note came from another device).
    Missing,
}

/// One chip asked about by the editor: its entry id and the reference it shows.
#[derive(Debug, Clone, Deserialize)]
pub struct ChipQuery {
    pub id: i64,
    #[serde(default)]
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChipState {
    pub id: i64,
    pub link: ChipLink,
    /// The booking (linked chips), for the chip's values and „Eintrag bearbeiten“.
    pub row: Option<TimeEntryRow>,
}

impl Database {
    /// The entry with its WBS context (Netzplan number, WBS element, project).
    pub fn time_entry_row(&self, id: i64) -> Result<Option<TimeEntryRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {}, p.project_code, n.netzplan_nr, n.wbs_element
                     FROM time_entries e
                     JOIN netzplaene n ON n.id = e.netzplan_id
                     JOIN projects p ON p.id = n.project_id
                     WHERE e.id = ?1",
                    Self::ENTRY_COLS
                ),
                [id],
                |r| {
                    Ok(TimeEntryRow {
                        entry: Self::map_entry(r)?,
                        project_code: r.get(11)?,
                        netzplan_nr: r.get(12)?,
                        wbs_element: r.get(13)?,
                    })
                },
            )
            .optional()?)
    }

    fn live_page_content(&self, page_id: i64) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT content FROM pages WHERE id = ?1 AND deleted_at IS NULL", [page_id], |r| r.get(0))
            .optional()?)
    }

    /// What the chip of `e` shows, in the time zone `tz`.
    pub fn chip_values<Tz: TimeZone>(&self, e: &TimeEntry, tz: &Tz) -> Result<ChipValues> {
        let nr = self.netzplan_by_id(e.netzplan_id)?.netzplan_nr;
        Ok(ChipValues {
            minutes: e.duration_minutes.unwrap_or(0),
            target: crate::desktop::timer_label(&nr, e.vorgang_nr.as_deref()),
            leistungsart: e.leistungsart.clone(),
            date: e.start_time.with_timezone(tz).date_naive(),
            text: e.description.clone(),
        })
    }

    /// Rewrites the chip of entry `entry_id` on `page_id` (see [`rewrite`]); `values` `None`
    /// marks it deleted. Returns whether the page changed.
    pub(crate) fn sync_chip(&self, page_id: i64, entry_id: i64, values: Option<&ChipValues>) -> Result<bool> {
        let Some(content) = self.live_page_content(page_id)? else { return Ok(false) };
        let Some(next) = rewrite(&content, entry_id, values) else { return Ok(false) };
        self.save_page_content_at(page_id, &next, Utc::now())?;
        Ok(true)
    }

    /// After an entry was edited: its chip shows the new values. Returns the rewritten page.
    pub fn sync_entry_chip(&self, e: &TimeEntry) -> Result<Option<i64>> {
        let Some(page) = e.page_id else { return Ok(None) };
        let values = self.chip_values(e, &Local)?;
        Ok(self.sync_chip(page, e.id, Some(&values))?.then_some(page))
    }

    /// How the chips `queries` of page `page_id` relate to their bookings. A chip that was moved
    /// to this note (cut and pasted; its old note no longer has it) takes its booking along.
    pub fn chip_states(&self, page_id: i64, queries: &[ChipQuery]) -> Result<Vec<ChipState>> {
        let mut out = vec![];
        for q in queries {
            let Some(row) = self.time_entry_row(q.id)? else {
                out.push(ChipState { id: q.id, link: ChipLink::Missing, row: None });
                continue;
            };
            let link = match row.entry.page_id {
                Some(p) if p == page_id => ChipLink::Linked,
                Some(other) => {
                    let target = crate::desktop::timer_label(&row.netzplan_nr, row.entry.vorgang_nr.as_deref());
                    let still_there = self.live_page_content(other)?.is_some_and(|c| {
                        chips(&c).iter().any(|c| c.entry_id() == Some(q.id) && c.attr("state") != Some("deleted"))
                    });
                    // Only the same booking moves along (an id from another device's note
                    // names some other entry here).
                    if !still_there && target.eq_ignore_ascii_case(q.target.trim()) {
                        self.conn()
                            .execute("UPDATE time_entries SET page_id = ?2 WHERE id = ?1", params![q.id, page_id])?;
                        ChipLink::Linked
                    } else {
                        ChipLink::Elsewhere
                    }
                }
                None => ChipLink::Missing,
            };
            let row = match link {
                ChipLink::Linked => self.time_entry_row(q.id)?,
                _ => None,
            };
            out.push(ChipState { id: q.id, link, row });
        }
        Ok(out)
    }

    /// Puts a booking deleted with its chip back (the chip came back: undo in the editor, or
    /// „Rückgängig“). Keeps its id when that is still free, so the chip finds it again.
    pub fn restore_time_entry(&self, e: &TimeEntry) -> Result<TimeEntry> {
        let free =
            self.conn().query_row("SELECT 1 FROM time_entries WHERE id = ?1", [e.id], |_| Ok(())).optional()?.is_none();
        let end = e.start_time + chrono::Duration::minutes(e.duration_minutes.unwrap_or(0));
        self.conn().execute(
            "INSERT INTO time_entries
               (id, netzplan_id, vorgang_nr, leistungsart, start_time, end_time, duration_minutes, description, status_flag, source, page_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'draft', ?9, ?10)",
            params![
                free.then_some(e.id),
                e.netzplan_id,
                e.vorgang_nr,
                e.leistungsart,
                crate::db::ts(e.start_time),
                crate::db::ts(e.end_time.unwrap_or(end)),
                e.duration_minutes.unwrap_or(0),
                e.description,
                e.source.as_str(),
                e.page_id
            ],
        )?;
        let entry = self.time_entry(self.conn().last_insert_rowid())?;
        self.feed_entry("entry_created", &entry, Utc::now())?;
        Ok(entry)
    }
}

/// The local day of an instant, for chip dates.
pub fn local_day(t: DateTime<Utc>) -> NaiveDate {
    t.with_timezone(&Local).date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, NewTimeEntry};

    const NOTE: &str = "Vormittag\n\n<time-entry id=\"7\" hours=\"1,50\" target=\"NP-8801/1020\">Review &amp; Abstimmung</time-entry>\n\nmehr";

    #[test]
    fn chips_are_parsed_and_rendered_the_same_way() {
        let c = chips(NOTE);
        assert_eq!(c.len(), 1);
        assert_eq!(
            (c[0].entry_id(), c[0].attr("target"), c[0].text.as_str()),
            (Some(7), Some("NP-8801/1020"), "Review & Abstimmung")
        );
        assert_eq!(render(&c[0].attrs, &c[0].text), &NOTE[c[0].range.clone()], "unchanged chips stay byte for byte");
        // Broken markup is skipped, the next chip still found.
        let two = format!("<time-entryx> <time-entry id=\"1\" hours=\"0,50\" target=\"A\"></time-entry>{NOTE}");
        assert_eq!(chips(&two).iter().map(|c| c.entry_id()).collect::<Vec<_>>(), vec![Some(1), Some(7)]);
        // Quotes and angle brackets survive a round trip.
        let attrs =
            vec![("id".into(), "3".into()), ("hours".into(), "1,00".into()), ("target".into(), "A\"<B>".into())];
        let md = render(&attrs, "x < y");
        assert_eq!(chips(&md)[0].attrs, attrs);
        assert_eq!(chips(&md)[0].text, "x < y");
    }

    #[test]
    fn the_first_chip_of_an_entry_follows_its_booking() {
        let v = ChipValues {
            minutes: 135,
            target: "NP-8801/1030".into(),
            leistungsart: Some("PM".into()),
            date: NaiveDate::from_ymd_opt(2026, 10, 2).unwrap(),
            text: "Planung".into(),
        };
        let copy = format!("{NOTE}\n\n{}", &NOTE[chips(NOTE)[0].range.clone()]);
        let next = rewrite(&copy, 7, Some(&v)).unwrap();
        let c = chips(&next);
        assert_eq!(
            &next[c[0].range.clone()],
            "<time-entry id=\"7\" hours=\"2,25\" target=\"NP-8801/1030\" la=\"PM\" date=\"2026-10-02\">Planung</time-entry>"
        );
        assert_eq!(c[1].attr("hours"), Some("1,50"), "a copy is not rewritten");
        assert!(next.starts_with("Vormittag\n\n") && next.contains("\n\nmehr"), "the rest stays");
        assert_eq!(rewrite(&next, 7, Some(&v)), None, "nothing changed: no rewrite");
        assert_eq!(rewrite(&next, 8, Some(&v)), None, "no chip of that entry");
        // Deleted: values kept, marked.
        let gone = rewrite(&next, 7, None).unwrap();
        assert!(gone.contains("date=\"2026-10-02\" state=\"deleted\">Planung</time-entry>"), "{gone}");
        // A marked chip stays as it is; a newer chip of the same id (SQLite reused it) is the
        // one rewritten.
        let marked = rewrite(NOTE, 7, None).unwrap();
        assert_eq!(rewrite(&marked, 7, None), None);
        let newer = format!("{marked}\n\n<time-entry id=\"7\" hours=\"0,50\" target=\"NP-8801/1030\">Neu</time-entry>");
        let c = chips(&rewrite(&newer, 7, Some(&v)).unwrap());
        assert_eq!((c[0].attr("hours"), c[1].attr("hours")), (Some("1,50"), Some("2,25")));
        // A chip written with a decimal point keeps it.
        let en = NOTE.replace("1,50", "1.50");
        assert!(rewrite(&en, 7, Some(&v)).unwrap().contains("hours=\"2.25\""));
        assert_eq!(chip_hours(20, false), "0,33");
    }

    #[test]
    fn edits_and_deletes_reach_the_note_and_copies_do_not_share_the_booking() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Systemintegration", 40.0).unwrap().id;
        let page = db.create_page(None, "Notiz", None).unwrap();
        let other = db.create_page(None, "Andere", None).unwrap();
        let t0 = Utc::now() - chrono::Duration::hours(3);
        let e = db
            .insert_time_entry(&NewTimeEntry {
                netzplan_id: np,
                vorgang_nr: Some("1020".into()),
                leistungsart: None,
                start_time: t0,
                duration_minutes: 90,
                description: "Review".into(),
                source: EntrySource::Slash,
                page_id: Some(page.id),
            })
            .unwrap();
        let chip = format!("<time-entry id=\"{}\" hours=\"1,50\" target=\"NP-8801/1020\">Review</time-entry>", e.id);
        db.save_page_content(page.id, &format!("A {chip}\n\nB {chip}")).unwrap();
        db.save_page_content(other.id, &format!("Kopie {chip}")).unwrap();

        let q = |page: i64| db.chip_states(page, &[ChipQuery { id: e.id, target: "NP-8801/1020".into() }]).unwrap();
        assert_eq!(q(page.id)[0].link, ChipLink::Linked);
        assert_eq!(q(page.id)[0].row.as_ref().unwrap().netzplan_nr, "NP-8801");
        assert_eq!(q(other.id)[0].link, ChipLink::Elsewhere, "a copy in another note");

        // Edited in the timesheet: the first chip shows it, the copies do not.
        let e2 = db.update_time_entry(e.id, Some("1020"), Some("DEV"), t0, 120, "Review lang").unwrap();
        assert_eq!(db.sync_entry_chip(&e2).unwrap(), None, "rewritten with the update already");
        let content = db.page_doc(page.id).unwrap().content;
        let c = chips(&content);
        assert_eq!(
            (c[0].attr("hours"), c[0].attr("la"), c[0].text.as_str()),
            (Some("2,00"), Some("DEV"), "Review lang")
        );
        assert_eq!(c[0].attr("date"), Some(local_day(t0).format("%Y-%m-%d").to_string().as_str()));
        assert_eq!(c[1].attr("hours"), Some("1,50"));

        // The chip cut from the note and pasted into the other: the booking moves along.
        db.save_page_content(page.id, "A").unwrap();
        assert_eq!(q(other.id)[0].link, ChipLink::Linked);
        assert_eq!(db.time_entry(e.id).unwrap().page_id, Some(other.id));
        // An id that names another booking (a note from another device) does not take it.
        assert_eq!(
            db.chip_states(page.id, &[ChipQuery { id: e.id, target: "NP-1/1".into() }]).unwrap()[0].link,
            ChipLink::Elsewhere
        );

        // Deleted with the chip (it is gone from the note): the note is left alone.
        let before = db.time_entry(e.id).unwrap();
        db.save_page_content(other.id, &format!("Kopie {chip}")).unwrap();
        db.delete_time_entry_with_chip(e.id).unwrap();
        assert!(!db.page_doc(other.id).unwrap().content.contains("state="));
        db.restore_time_entry(&before).unwrap();
        // Deleted elsewhere: the chip is marked; restored with the same id.
        db.delete_time_entry(e.id).unwrap();
        assert!(db.page_doc(other.id).unwrap().content.contains("state=\"deleted\""));
        assert_eq!(q(other.id)[0].link, ChipLink::Missing);
        let back = db.restore_time_entry(&before).unwrap();
        assert_eq!((back.id, back.duration_minutes, back.page_id), (e.id, Some(120), Some(other.id)));
    }
}
