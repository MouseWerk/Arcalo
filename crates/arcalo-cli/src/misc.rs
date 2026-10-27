//! The workspace overview, search, the calendar, attachments, settings and the vault.

use std::path::Path;

use arcalo_core::calsync::{self, Busy};
use arcalo_core::external::Change;
use arcalo_core::search::SearchHit;
use arcalo_core::settings::Settings;
use arcalo_core::tasks::{TaskFilter, TaskStatus};
use arcalo_core::{attachment_manager, attachments, capture, demo, i18n, search, tr, trf, vault};
use chrono::{DateTime, Duration, FixedOffset, Local, Utc};
use serde::Serialize;

use crate::model::{PageOut, Pages, local};
use crate::output::{Failure, Outcome};
use crate::pages::day;
use crate::time::day_start;
use crate::{AttachCmd, CalendarCmd, Ctx, SettingsCmd};

pub fn info(ctx: &Ctx) -> Outcome<()> {
    let db = &ctx.ws.db;
    #[derive(Serialize)]
    struct Counts {
        pages: usize,
        trash: usize,
        tags: usize,
        tasks_open: usize,
        tasks_done: usize,
        time_entries: usize,
        projects: usize,
        attachments: usize,
    }
    #[derive(Serialize)]
    struct Info {
        version: &'static str,
        data_dir: String,
        database: String,
        portable: bool,
        encrypted: bool,
        schema_version: usize,
        /// `de` or `en`: the language of messages (Settings → Sprache).
        language: &'static str,
        time_tracking: bool,
        counts: Counts,
    }
    let tasks = |status| db.list_tasks(&TaskFilter { status, ..Default::default() }).map(|l| l.len());
    let info = Info {
        version: env!("CARGO_PKG_VERSION"),
        data_dir: ctx.ws.loc.data_dir.display().to_string(),
        database: ctx.ws.loc.db.display().to_string(),
        portable: ctx.ws.loc.portable,
        encrypted: ctx.ws.encrypted,
        schema_version: db.schema_version()?,
        language: if i18n::is_en() { "en" } else { "de" },
        time_tracking: ctx.ws.settings.time_tracking(),
        counts: Counts {
            pages: db.list_pages()?.len(),
            trash: db.list_trash()?.len(),
            tags: db.tag_counts()?.len(),
            tasks_open: tasks(TaskStatus::Open)?,
            tasks_done: tasks(TaskStatus::Done)?,
            time_entries: db.list_time_entries(&Default::default())?.len(),
            projects: db.list_projects()?.len(),
            attachments: attachment_manager::list(db, &ctx.ws.attachments_dir())?.files.len(),
        },
    };
    ctx.out.show(&info, |i| {
        let c = &i.counts;
        let mut s = format!("Arcalo {}\n", i.version);
        s.push_str(&format!("{}: {}\n", tr!("Datenordner", "Data folder"), i.data_dir));
        s.push_str(&format!("{}: {}\n", tr!("Datenbank", "Database"), i.database));
        if i.encrypted {
            s.push_str(&format!("{}\n", tr!("Verschlüsselt", "Encrypted")));
        }
        if i.portable {
            s.push_str(&format!("{}\n", tr!("Portabler Modus", "Portable mode")));
        }
        let (p, t, o, d, e) = (c.pages, c.trash, c.tasks_open, c.tasks_done, c.time_entries);
        s.push_str(&trf!(
            "{p} Seiten ({t} im Papierkorb), {o} offene und {d} erledigte Aufgaben, {e} Buchungen",
            "{p} pages ({t} in the trash), {o} open and {d} done tasks, {e} time entries"
        ));
        s
    })
}

/// Search hits without the markers around matched words.
fn plain(s: &str) -> String {
    s.replace(['\u{2}', '\u{3}'], "")
}

pub fn search(ctx: &Ctx, query: &str, limit: usize) -> Outcome<()> {
    let db = &ctx.ws.db;
    let hits = search::search(db, query, limit)?;
    if !ctx.out.json {
        for hit in hits {
            match hit {
                SearchHit::Page { title, .. } => println!("[{}] {title}", tr!("Seite", "Page")),
                SearchHit::Note { title, snippet, .. } => println!("[{}] {title}: {snippet}", tr!("Notiz", "Note")),
                SearchHit::Similar { title, passage, .. } => {
                    println!("[{}] {title}: {passage}", tr!("ähnlich", "similar"))
                }
                SearchHit::TimeEntry { netzplan_nr, vorgang_nr, snippet, .. } => println!(
                    "[{}]  {netzplan_nr}{}: {snippet}",
                    tr!("Zeit", "Time"),
                    vorgang_nr.map(|v| format!("/{v}")).unwrap_or_default()
                ),
            }
        }
        return Ok(());
    }
    #[derive(Serialize)]
    struct HitOut {
        /// `page`, `note`, `similar` or `time_entry`.
        kind: &'static str,
        page: Option<PageOut>,
        /// The matching passage (notes, similar pages, time entries).
        snippet: Option<String>,
        entry_id: Option<i64>,
        /// `NP-8801/1020` of a time entry.
        reference: Option<String>,
        score: f64,
    }
    let pages = Pages::load(db)?;
    let page = |id: i64| db.page(id).ok().map(|p| pages.out(&p));
    let list: Vec<HitOut> = hits
        .into_iter()
        .map(|h| {
            let score = h.score();
            match h {
                SearchHit::Page { page_id, .. } => {
                    HitOut { kind: "page", page: page(page_id), snippet: None, entry_id: None, reference: None, score }
                }
                SearchHit::Note { page_id, snippet, .. } => HitOut {
                    kind: "note",
                    page: page(page_id),
                    snippet: Some(plain(&snippet)),
                    entry_id: None,
                    reference: None,
                    score,
                },
                SearchHit::Similar { page_id, passage, .. } => HitOut {
                    kind: "similar",
                    page: page(page_id),
                    snippet: Some(passage),
                    entry_id: None,
                    reference: None,
                    score,
                },
                SearchHit::TimeEntry { id, netzplan_nr, vorgang_nr, snippet, .. } => HitOut {
                    kind: "time_entry",
                    page: None,
                    snippet: Some(plain(&snippet)),
                    entry_id: Some(id),
                    reference: Some(vorgang_nr.map_or(netzplan_nr.clone(), |v| format!("{netzplan_nr}/{v}"))),
                    score,
                },
            }
        })
        .collect();
    ctx.out.show(&list, |_| String::new())
}

pub fn calendar(ctx: &Ctx, cmd: CalendarCmd) -> Outcome<()> {
    let today = Local::now().date_naive();
    let (from, to) = match cmd {
        CalendarCmd::Today => (today, today),
        CalendarCmd::Events { from, to } => {
            let from = from.as_deref().map(day).transpose()?.unwrap_or(today);
            let to = to.as_deref().map(day).transpose()?.unwrap_or(from + Duration::days(6));
            if to < from || (to - from).num_days() > 400 {
                return Err(Failure::Usage(
                    tr!("Bitte einen Zeitraum bis zu 400 Tagen wählen", "Please choose a range of up to 400 days")
                        .into(),
                ));
            }
            (from, to)
        }
    };
    let sources = ctx.ws.settings.calendar.active_sources(calsync::outlook::available());
    let events = ctx.ws.db.calendar_events(day_start(from), day_start(to + Duration::days(1)), &sources)?;
    #[derive(Serialize)]
    struct EventOut {
        /// `source|uid|instance`: names the appointment across syncs.
        key: String,
        source: String,
        title: String,
        start: DateTime<FixedOffset>,
        end: DateTime<FixedOffset>,
        all_day: bool,
        location: String,
        organizer: String,
        attendees: Vec<String>,
        /// Teams, Zoom, Webex or Meet link.
        link: Option<String>,
        busy: Busy,
        recurring: bool,
        /// Its meeting note.
        note_page_id: Option<i64>,
        /// The time entry booked from it.
        entry_id: Option<i64>,
        /// Marked „nicht buchen“.
        skip: bool,
    }
    let list: Vec<EventOut> = events
        .into_iter()
        .map(|e| EventOut {
            key: e.key,
            source: e.source,
            start: local(e.event.start),
            end: local(e.event.end),
            all_day: e.event.all_day,
            title: e.event.title,
            location: e.event.location,
            organizer: e.event.organizer,
            attendees: e.event.attendees,
            link: e.event.link,
            busy: e.event.busy,
            recurring: e.event.recurring,
            note_page_id: e.note_page_id,
            entry_id: e.entry_id,
            skip: e.skip,
        })
        .collect();
    ctx.out.show(&list, |l| {
        l.iter()
            .map(|e| {
                let when = if e.all_day {
                    format!("{}  {}", e.start.format("%Y-%m-%d"), tr!("ganztägig  ", "all day    "))
                } else {
                    format!("{}  {}–{}", e.start.format("%Y-%m-%d"), e.start.format("%H:%M"), e.end.format("%H:%M"))
                };
                let place = if e.location.is_empty() { String::new() } else { format!("  ({})", e.location) };
                format!("{when}  {}{place}\n", e.title)
            })
            .collect()
    })
}

pub fn attachments(ctx: &Ctx, cmd: AttachCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    let dir = ctx.ws.attachments_dir();
    match cmd {
        AttachCmd::List => {
            #[derive(Serialize)]
            struct Use {
                id: i64,
                title: String,
                trashed: bool,
            }
            #[derive(Serialize)]
            struct FileOut {
                name: String,
                kind: attachment_manager::FileKind,
                size: u64,
                modified: Option<DateTime<FixedOffset>>,
                /// Pages that embed it.
                used_in: Vec<Use>,
            }
            let list: Vec<FileOut> = attachment_manager::list(db, &dir)?
                .files
                .into_iter()
                .map(|f| FileOut {
                    name: f.name,
                    kind: f.kind,
                    size: f.size,
                    modified: f.modified.map(local),
                    used_in: f
                        .used_in
                        .into_iter()
                        .map(|u| Use { id: u.id, title: u.title, trashed: u.trashed })
                        .collect(),
                })
                .collect();
            ctx.out.show(&list, |l| {
                l.iter()
                    .map(|f| {
                        let used: Vec<&str> = f.used_in.iter().map(|u| u.title.as_str()).collect();
                        format!("{}  {} KB  {}\n", f.name, f.size.div_ceil(1024), used.join(", "))
                    })
                    .collect()
            })
        }
        AttachCmd::Add { file, page } => {
            let target =
                page.map(|r| Pages::load(db).map_err(Failure::from).and_then(|p| p.resolve(&r, false))).transpose()?;
            let saved = attachments::import_file(&dir, &file)?;
            if let Err(e) = db.feed_file(&saved.name, Utc::now()) {
                eprintln!("{}: {e}", tr!("Aktivität nicht erfasst", "Activity not recorded"));
            }
            if let Some(p) = &target {
                let embed = saved.markdown.clone();
                ctx.ws.commit(|db| {
                    let content = db.page_doc(p.id)?.content;
                    crate::pages::save(db, p.id, &capture::append_markdown(&content, &embed))?;
                    Ok(((), Change { pages: vec![p.id], ..Default::default() }))
                })?;
            }
            #[derive(Serialize)]
            struct Added {
                name: String,
                path: String,
                size: u64,
                /// `![[name]]`, the embed for a note.
                markdown: String,
                page_id: Option<i64>,
            }
            let out = Added {
                name: saved.name,
                path: saved.path,
                size: saved.size,
                markdown: saved.markdown,
                page_id: target.map(|p| p.id),
            };
            ctx.out.show(&out, |a| a.markdown.clone())
        }
        AttachCmd::Export { name, to } => {
            let from = attachments::existing(&dir, &name)?;
            let file = from.file_name().map(|n| n.to_owned()).unwrap_or_default();
            let target = if to.is_dir() { to.join(file) } else { to };
            arcalo_core::error::copy_file(&from, &target)?;
            let out = serde_json::json!({ "name": name, "path": target.display().to_string() });
            ctx.out.show(&out, |v| v["path"].as_str().unwrap_or("").to_owned())
        }
    }
}

/// The value at `key` (`editor.autosave_ms`) of a JSON object.
fn at<'v>(v: &'v serde_json::Value, key: &str) -> Option<&'v serde_json::Value> {
    key.split('.').filter(|k| !k.is_empty()).try_fold(v, |cur, k| cur.get(k))
}

fn unknown_key(key: &str) -> Failure {
    Failure::NotFound(trf!("Einstellung „{key}“ gibt es nicht", "There is no setting “{key}”"))
}

pub fn settings(ctx: &Ctx, cmd: SettingsCmd) -> Outcome<()> {
    let text = |v: &serde_json::Value| match v {
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    match cmd {
        SettingsCmd::Get { key } => {
            let all = serde_json::to_value(&ctx.ws.settings)?;
            let v = match key.as_deref() {
                Some(k) => at(&all, k).cloned().ok_or_else(|| unknown_key(k))?,
                None => all,
            };
            ctx.out.show(&v, text)
        }
        SettingsCmd::Set { key, value } => {
            let new: serde_json::Value =
                serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value.clone()));
            let path: Vec<&str> = key.split('.').filter(|k| !k.is_empty()).collect();
            let (last, parents) = path.split_last().ok_or_else(|| unknown_key(&key))?;
            let mut all = serde_json::to_value(&ctx.ws.settings)?;
            let parent =
                parents.iter().try_fold(&mut all, |cur, k| cur.get_mut(*k)).ok_or_else(|| unknown_key(&key))?;
            let obj = parent.as_object_mut().ok_or_else(|| unknown_key(&key))?;
            obj.insert((*last).to_owned(), new);
            let saved = ctx.ws.commit(|db| {
                // As a save on the settings page: checked, cleaned, and what other commands save on
                // their own (start page, calendar sources, …) taken from what is stored.
                let stored = db.load_settings()?;
                let mut s = Settings::for_save(all, &stored)?;
                s.normalize();
                let s = s.finish_save(&stored, |t| db.page_by_title(t).ok().flatten().is_some())?;
                db.save_settings(&s)?;
                Ok((s, Change { settings: true, ..Default::default() }))
            })?;
            let after = serde_json::to_value(&saved)?;
            let v = at(&after, &key).cloned().ok_or_else(|| unknown_key(&key))?;
            ctx.out.show(&serde_json::json!({ "key": key, "value": v }), |o| format!("{key} = {}", text(&o["value"])))
        }
    }
}

pub fn demo(ctx: &Ctx) -> Outcome<()> {
    let seeded = ctx.ws.commit(|db| {
        let seeded = demo::seed_explicit(db, Local::now())?;
        Ok((seeded, if seeded { Change::everything() } else { Change::default() }))
    })?;
    ctx.out.show(&serde_json::json!({ "seeded": seeded }), |_| {
        if seeded {
            trf!("Beispiel-Arbeitsbereich in {} angelegt", "Demo workspace created in {}", ctx.ws.loc.db.display())
        } else {
            tr!("Der Arbeitsbereich hat schon Daten; nichts angelegt.", "Workspace already has data; nothing seeded.")
                .into()
        }
    })
}

pub fn import(ctx: &Ctx, dir: &Path) -> Outcome<()> {
    let r = vault::import_vault(&ctx.ws.db, dir, &ctx.ws.attachments_dir())?;
    ctx.ws.db.record_external_change(&Change { tree: true, ..Default::default() })?;
    ctx.out.show(&r, |r| {
        let (p, f, a, s) = (r.pages, r.folders, r.attachments, r.skipped);
        trf!(
            "{p} Seiten, {f} Ordner, {a} Bilder importiert ({s} Dateien übersprungen)",
            "{p} pages, {f} folders, {a} images imported ({s} files skipped)"
        )
    })
}

pub fn export_vault(ctx: &Ctx, dir: &Path) -> Outcome<()> {
    let n = vault::export_vault(&ctx.ws.db, dir, &ctx.ws.attachments_dir())?;
    let out = serde_json::json!({ "files": n, "dir": dir.display().to_string() });
    ctx.out.show(&out, |_| {
        trf!("{n} Markdown-Dateien nach {} geschrieben", "{n} Markdown files written to {}", dir.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_keys_are_dotted_paths() {
        let v = serde_json::json!({ "editor": { "autosave_ms": 450 }, "theme": "dark" });
        assert_eq!(at(&v, "editor.autosave_ms"), Some(&serde_json::json!(450)));
        assert_eq!(at(&v, "theme"), Some(&serde_json::json!("dark")));
        assert_eq!(at(&v, "editor.missing"), None);
        assert_eq!(plain("a \u{2}b\u{3} c"), "a b c");
    }
}
