use std::cell::RefCell;

use chrono::TimeZone;

use super::*;
use crate::calsync::{NewEvent, OUTLOOK};

fn t(day: u32, h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, day, h, m, 0).unwrap()
}

fn new(title: &str, start: DateTime<Utc>, minutes: i64, link: BlockLink) -> NewBlock {
    NewBlock {
        title: title.into(),
        start: Some(start),
        end: Some(start + Duration::minutes(minutes)),
        link,
        reference: String::new(),
    }
}

fn event(uid: &str, start: DateTime<Utc>, minutes: i64, title: &str, busy: Busy) -> NewEvent {
    NewEvent {
        uid: uid.into(),
        instance: String::new(),
        recurring: false,
        start,
        end: start + Duration::minutes(minutes),
        all_day: false,
        title: title.into(),
        location: String::new(),
        organizer: String::new(),
        attendees: vec![],
        body: None,
        link: None,
        busy,
        private: false,
        categories: vec![],
    }
}

#[test]
fn times_snap_to_quarter_hours() {
    assert_eq!(snap(t(5, 9, 7)), t(5, 9, 0));
    assert_eq!(snap(t(5, 9, 8)), t(5, 9, 15));
    assert_eq!(snap(t(5, 23, 53)), t(6, 0, 0));
    assert_eq!(normalize(t(5, 9, 2), t(5, 9, 5)), (t(5, 9, 0), t(5, 9, 15)), "at least one step");
    assert_eq!(normalize(t(5, 9, 0), t(5, 8, 0)), (t(5, 9, 0), t(5, 9, 15)), "end before start");
    assert_eq!(normalize(t(5, 6, 0), t(6, 6, 0)).1, t(5, 18, 0), "at most 12 hours");
    assert_eq!(retry_minutes(0), 1);
    assert_eq!(retry_minutes(3), 8);
    assert_eq!(retry_minutes(40), 30);
}

#[test]
fn overlaps_and_free_slots() {
    assert!(overlaps(t(5, 9, 0), t(5, 10, 0), t(5, 9, 30), t(5, 11, 0)));
    assert!(!overlaps(t(5, 9, 0), t(5, 10, 0), t(5, 10, 0), t(5, 11, 0)), "touching is free");
    let busy = [(t(5, 9, 0), t(5, 10, 0)), (t(5, 10, 45), t(5, 12, 0))];
    // From 8:10 an hour fits only after the second meeting (8:15 and 10:00 are too short): the
    // gap's start and the half hours after it.
    let s = free_slots(t(5, 8, 10), t(5, 14, 0), &busy, 60);
    assert_eq!(s, [t(5, 12, 0), t(5, 12, 30), t(5, 13, 0)]);
    assert!(!s.contains(&t(5, 8, 15)), "8:15–9:15 runs into the meeting");
    let s = free_slots(t(5, 8, 10), t(5, 14, 0), &busy, 45);
    assert_eq!(&s[..3], [t(5, 8, 15), t(5, 10, 0), t(5, 12, 0)]);
    assert_eq!(s.last(), Some(&t(5, 13, 0)));
    assert!(free_slots(t(5, 8, 0), t(5, 8, 30), &[], 60).is_empty());
    assert_eq!(free_slots(t(5, 0, 0), t(6, 0, 0), &[], 15).len(), MAX_SLOTS);
}

#[test]
fn blocks_are_created_moved_resized_and_deleted() {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_page(None, "Projekt", None).unwrap();
    db.save_page_content(p.id, "---\nvorgang: NP-8801/1020\n---\n- [ ] Erstes\n- [ ] Bericht schreiben\n").unwrap();
    let pr = db.create_project("PRJ-1", "Rollout").unwrap();
    let np = db.create_netzplan(pr.id, "NP-8801", "NP-8801-1020", "Integration", 10.0).unwrap();
    db.create_vorgang(np.id, "1020", "Systemintegration", 1.0, 10.0).unwrap();
    let now = t(1, 8, 0);

    // A task: its text is the title, the page's Vorgang the suggestion.
    let task = BlockLink::Task { page_id: p.id, ordinal: 1, text: "Bericht schreiben".into() };
    let b = db.block_create(&new("", t(5, 9, 7), 60, task.clone()), now, false).unwrap();
    assert_eq!((b.title.as_str(), b.start, b.end), ("Bericht schreiben", t(5, 9, 0), t(5, 10, 0)));
    assert_eq!((b.page_title.as_deref(), b.task_done), (Some("Projekt"), Some(false)));
    assert_eq!((b.reference.as_str(), b.suggested_reference.as_deref()), ("", Some("NP-8801/1020")));
    assert_eq!(b.outlook, OutlookState::None);

    // An issue without a cached summary: the key; with one: key and summary.
    let i = db.block_create(&new("", t(5, 13, 0), 30, BlockLink::Issue { key: " erp-7 ".into() }), now, false).unwrap();
    assert_eq!((i.title.as_str(), i.link.clone()), ("ERP-7", BlockLink::Issue { key: "ERP-7".into() }));
    db.conn()
        .execute(
            "INSERT INTO issues (site, key, summary, status, url, seen_at) VALUES ('s', 'ERP-8', 'Login', 'Offen', 'https://j/ERP-8', ?1)",
            [ts(now)],
        )
        .unwrap();
    let i8 = db.block_create(&new("", t(6, 13, 0), 30, BlockLink::Issue { key: "ERP-8".into() }), now, false).unwrap();
    assert_eq!((i8.title.as_str(), i8.issue_status.as_deref()), ("ERP-8 Login", Some("Offen")));
    db.issue_wbs_set("project", "ERP", "NP-8801", false).unwrap();
    assert_eq!(db.block(i8.id).unwrap().suggested_reference.as_deref(), Some("NP-8801"));

    // A block of its own with a Vorgang; a wrong one is refused.
    let own = NewBlock { reference: "NP-8801/1020".into(), ..new("Planung", t(5, 15, 0), 45, BlockLink::None) };
    let o = db.block_create(&own, now, false).unwrap();
    assert_eq!((o.reference.as_str(), o.minutes()), ("NP-8801/1020", 45));
    assert!(db.block_create(&NewBlock { reference: "NP-0".into(), ..own.clone() }, now, false).is_err());
    assert!(db.block_create(&NewBlock { start: None, ..own }, now, false).is_err());

    // Range: overlapping blocks only, by start.
    let ids = |v: Vec<FocusBlock>| v.into_iter().map(|b| b.id).collect::<Vec<_>>();
    assert_eq!(ids(db.blocks_in(t(5, 0, 0), t(6, 0, 0)).unwrap()), [b.id, i.id, o.id]);
    assert_eq!(ids(db.blocks_in(t(5, 9, 59), t(5, 13, 1)).unwrap()), [b.id, i.id]);
    assert_eq!(ids(db.blocks_in(t(5, 10, 0), t(5, 13, 0)).unwrap()), Vec::<i64>::new(), "touching ends");

    // Move (snapped), resize, rename, Vorgang off.
    let m = BlockPatch { start: Some(t(6, 10, 50)), end: Some(t(6, 11, 50)), ..Default::default() };
    let b2 = db.block_update(b.id, &m, now, false).unwrap();
    assert_eq!((b2.start, b2.end), (t(6, 10, 45), t(6, 11, 45)));
    let b3 = db
        .block_update(
            b.id,
            &BlockPatch { end: Some(t(6, 12, 30)), title: Some(" Bericht ".into()), ..Default::default() },
            now,
            false,
        )
        .unwrap();
    assert_eq!((b3.start, b3.end, b3.title.as_str()), (t(6, 10, 45), t(6, 12, 30), "Bericht"));
    let o2 = db
        .block_update(o.id, &BlockPatch { reference: Some(String::new()), ..Default::default() }, now, false)
        .unwrap();
    assert_eq!((o2.reference.as_str(), o2.netzplan_id), ("", None));

    // The task is ticked off through the block, also after its line moved.
    db.save_page_content(p.id, "- [ ] Neu oben\n- [ ] Erstes\n- [ ] Bericht schreiben\n").unwrap();
    db.block_task_done(b.id).unwrap();
    assert_eq!(db.block(b.id).unwrap().task_done, Some(true));
    let content: String = db.conn().query_row("SELECT content FROM pages WHERE id = ?1", [p.id], |r| r.get(0)).unwrap();
    assert!(content.contains("- [x] Bericht schreiben"));
    assert!(db.block_task_done(o.id).is_err(), "no task");

    // A focus session started from the block counts its minutes.
    let s = crate::focus::start(
        &db,
        &crate::focus::FocusStart { minutes: 25.0, block_id: Some(b.id), ..Default::default() },
        t(6, 10, 45),
    )
    .unwrap();
    db.conn().execute("UPDATE focus_sessions SET worked_minutes = 25, status = 'done' WHERE id = ?1", [s.id]).unwrap();
    assert_eq!(db.block(b.id).unwrap().focus_minutes, 25);

    db.block_delete(b.id).unwrap();
    assert!(db.block(b.id).is_err());
    assert!(db.block_delete(b.id).is_err());
    assert_eq!(db.block_outbox_len().unwrap(), 0, "never in Outlook: nothing to delete there");
}

#[test]
fn free_slots_of_a_day_avoid_meetings_and_blocks() {
    let db = Database::open_in_memory().unwrap();
    let z = Zone::Utc;
    db.calendar_replace(
        OUTLOOK,
        t(1, 0, 0),
        t(30, 0, 0),
        &[event("a", t(5, 8, 0), 120, "Workshop", Busy::Busy), event("f", t(5, 10, 0), 60, "Frei", Busy::Free)],
    )
    .unwrap();
    db.block_create(&new("Block", t(5, 10, 0), 60, BlockLink::None), t(1, 0, 0), false).unwrap();
    let day = NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
    let s = db.block_free_slots(day, 60, t(1, 0, 0), &z, &[OUTLOOK.into()]).unwrap();
    assert_eq!(s[0], t(5, 11, 0), "after the meeting and the block; a free appointment does not count");
    // Today: from now on.
    let s = db.block_free_slots(day, 60, t(5, 14, 5), &z, &[OUTLOOK.into()]).unwrap();
    assert_eq!(s.first(), Some(&t(5, 14, 15)));
    assert_eq!(s.last(), Some(&t(5, 17, 0)));
}

/// Answers like Outlook: keeps the appointments (EntryID, marker), finds one by marker before
/// it adds one, or fails like a closed Outlook.
struct FakeBridge {
    calls: RefCell<Vec<Vec<WriteOp>>>,
    closed: RefCell<bool>,
    /// Saves, but the answer is lost (a script timeout).
    lost: RefCell<bool>,
    /// The calendar: (EntryID, marker, subject).
    items: RefCell<Vec<(String, String, String)>>,
    added: RefCell<i64>,
}

impl FakeBridge {
    fn new() -> FakeBridge {
        FakeBridge {
            calls: RefCell::new(vec![]),
            closed: RefCell::new(false),
            lost: RefCell::new(false),
            items: RefCell::new(vec![]),
            added: RefCell::new(0),
        }
    }

    fn subjects(&self) -> Vec<String> {
        self.items.borrow().iter().map(|i| i.2.clone()).collect()
    }
}

impl Bridge for FakeBridge {
    fn write(&self, ops: &[WriteOp]) -> Result<Vec<WriteResult>> {
        self.calls.borrow_mut().push(ops.to_vec());
        if *self.closed.borrow() {
            return Err(Error::State(crate::calsync::outlookwrite::not_running()));
        }
        let mut out = vec![];
        for o in ops {
            let mut items = self.items.borrow_mut();
            let at = items.iter().position(|i| match &o.entry_id {
                Some(e) => &i.0 == e,
                None => i.1 == o.marker,
            });
            let entry = if o.op == "delete" {
                at.map(|at| items.remove(at).0)
            } else {
                let at = at.unwrap_or_else(|| {
                    *self.added.borrow_mut() += 1;
                    items.push((format!("E{}", self.added.borrow()), o.marker.clone(), String::new()));
                    items.len() - 1
                });
                items[at].2 = o.subject.clone();
                Some(items[at].0.clone())
            };
            out.push(WriteResult {
                key: o.key,
                ok: true,
                global_id: entry.as_ref().map(|e| format!("G{e}")),
                entry_id: entry,
                error: None,
            });
        }
        if *self.lost.borrow() {
            return Err(Error::State("timeout".into()));
        }
        Ok(out)
    }
}

#[test]
fn outlook_writes_are_queued_retried_and_the_synced_copy_is_not_shown_twice() {
    let db = Database::open_in_memory().unwrap();
    let z = Zone::Utc;
    let bridge = FakeBridge::new();
    let now = t(1, 8, 0);

    // Outlook closed: the write waits, with the reason, and is not tried again before its time.
    *bridge.closed.borrow_mut() = true;
    let b = db.block_create(&new("Konzept", t(5, 9, 0), 60, BlockLink::None), now, true).unwrap();
    assert_eq!(b.outlook, OutlookState::Pending);
    assert!(flush(&db, &bridge, now, &z, false).is_err());
    let b1 = db.block(b.id).unwrap();
    assert_eq!(b1.outlook, OutlookState::Pending);
    assert!(b1.outlook_error.unwrap().contains("nicht geöffnet"));
    assert_eq!(flush(&db, &bridge, now + Duration::seconds(30), &z, false).unwrap(), 0, "waits a minute");
    assert_eq!(bridge.calls.borrow().len(), 1);

    // Outlook open: created as „Fokus: …“ at local times, the ids are stored.
    *bridge.closed.borrow_mut() = false;
    assert_eq!(flush(&db, &bridge, now + Duration::minutes(2), &z, false).unwrap(), 1);
    let op = bridge.calls.borrow().last().unwrap()[0].clone();
    assert_eq!((op.op.as_str(), op.entry_id.as_deref(), op.subject.as_str()), ("upsert", None, "Fokus: Konzept"));
    assert_eq!(op.start, Some(t(5, 9, 0).naive_utc()));
    let b2 = db.block(b.id).unwrap();
    assert_eq!((b2.outlook, b2.outlook_entry_id.as_deref()), (OutlookState::Written, Some("E1")));
    assert_eq!(db.block_outbox_len().unwrap(), 0);

    // The next sync brings the appointment back: it shows as the block, not as a meeting.
    let synced =
        [event("GE1", t(5, 9, 0), 60, "Fokus: Konzept", Busy::Busy), event("x", t(5, 11, 0), 30, "Daily", Busy::Busy)];
    db.calendar_replace(OUTLOOK, t(1, 0, 0), t(30, 0, 0), &synced).unwrap();
    let titles = |db: &Database| -> Vec<String> {
        db.calendar_events(t(5, 0, 0), t(6, 0, 0), &[OUTLOOK.into()])
            .unwrap()
            .into_iter()
            .map(|e| e.event.title)
            .collect()
    };
    assert_eq!(titles(&db), ["Daily"]);

    // Moved: the same appointment is updated. Without the setting a block that is in Outlook
    // still follows; one that never was stays out.
    db.block_update(
        b.id,
        &BlockPatch { start: Some(t(5, 14, 0)), end: Some(t(5, 15, 30)), ..Default::default() },
        now,
        false,
    )
    .unwrap();
    let other = db.block_create(&new("Nur hier", t(5, 16, 0), 30, BlockLink::None), now, false).unwrap();
    db.block_update(other.id, &BlockPatch { start: Some(t(5, 16, 30)), ..Default::default() }, now, false).unwrap();
    assert_eq!(flush(&db, &bridge, now + Duration::minutes(3), &z, false).unwrap(), 1);
    let op = bridge.calls.borrow().last().unwrap()[0].clone();
    assert_eq!(
        (op.marker.as_str(), op.op.as_str(), op.entry_id.as_deref()),
        (ops_marker(&db, b.id).as_str(), "upsert", Some("E1"))
    );
    assert_eq!(op.end, Some(t(5, 15, 30).naive_utc()));

    // A change while a write is under way is not lost.
    db.block_update(b.id, &BlockPatch { title: Some("Konzept v2".into()), ..Default::default() }, now, false).unwrap();
    let ops = db.block_outbox_due(now, &z, true).unwrap();
    db.block_update(b.id, &BlockPatch { title: Some("Konzept v3".into()), ..Default::default() }, now, false).unwrap();
    let results = bridge.write(&ops);
    db.block_outbox_apply(&ops, &results, now).unwrap();
    assert_eq!(db.block_outbox_len().unwrap(), 1, "v3 still to write");
    flush(&db, &bridge, now, &z, true).unwrap();
    assert_eq!(bridge.calls.borrow().last().unwrap()[0].subject, "Fokus: Konzept v3");

    // Deleted while Outlook is closed: the appointment stays hidden until it is gone.
    *bridge.closed.borrow_mut() = true;
    db.block_delete(b.id).unwrap();
    assert!(flush(&db, &bridge, now + Duration::minutes(10), &z, false).is_err());
    assert_eq!(titles(&db), ["Daily"]);
    *bridge.closed.borrow_mut() = false;
    flush(&db, &bridge, now + Duration::minutes(20), &z, false).unwrap();
    let op = bridge.calls.borrow().last().unwrap()[0].clone();
    assert_eq!((op.op.as_str(), op.entry_id.as_deref()), ("delete", Some("E1")));
    assert_eq!(db.block_outbox_len().unwrap(), 0);
}

fn ops_marker(db: &Database, id: i64) -> String {
    db.block_marker(id).unwrap()
}

#[test]
fn a_waiting_delete_survives_a_new_block_that_gets_the_same_id() {
    let db = Database::open_in_memory().unwrap();
    let z = Zone::Utc;
    let bridge = FakeBridge::new();
    let now = t(1, 8, 0);
    let a = db.block_create(&new("A", t(5, 9, 0), 60, BlockLink::None), now, true).unwrap();
    flush(&db, &bridge, now, &z, false).unwrap();
    assert_eq!(bridge.subjects(), ["Fokus: A"]);

    // Outlook closed: A deleted, B created (SQLite hands out A's rowid again).
    *bridge.closed.borrow_mut() = true;
    db.block_delete(a.id).unwrap();
    let b = db.block_create(&new("B", t(5, 11, 0), 60, BlockLink::None), now, true).unwrap();
    assert_eq!(b.id, a.id, "the rowid is reused");
    assert_eq!(db.block_outbox_len().unwrap(), 2, "the delete of A stays queued next to B's write");
    assert!(flush(&db, &bridge, now, &z, true).is_err());

    *bridge.closed.borrow_mut() = false;
    flush(&db, &bridge, now, &z, true).unwrap();
    assert_eq!(bridge.subjects(), ["Fokus: B"], "A is gone from Outlook");
    let b = db.block(b.id).unwrap();
    assert_eq!((b.outlook, b.outlook_entry_id.as_deref()), (OutlookState::Written, Some("E2")));
    assert_eq!(db.block_outbox_len().unwrap(), 0);
}

#[test]
fn a_block_deleted_while_its_first_write_is_under_way_leaves_no_appointment() {
    let db = Database::open_in_memory().unwrap();
    let z = Zone::Utc;
    let bridge = FakeBridge::new();
    let now = t(1, 8, 0);
    let b = db.block_create(&new("Kurz", t(5, 9, 0), 60, BlockLink::None), now, true).unwrap();
    let ops = db.block_outbox_due(now, &z, false).unwrap();
    db.block_delete(b.id).unwrap();
    let results = bridge.write(&ops);
    db.block_outbox_apply(&ops, &results, now).unwrap();
    assert_eq!(bridge.subjects(), ["Fokus: Kurz"], "created meanwhile");
    flush(&db, &bridge, now, &z, false).unwrap();
    let op = bridge.calls.borrow().last().unwrap()[0].clone();
    assert_eq!((op.op.as_str(), op.entry_id.as_deref()), ("delete", Some("E1")));
    assert!(bridge.subjects().is_empty());
    assert_eq!(db.block_outbox_len().unwrap(), 0);

    // Deleted before the answer of a write that timed out: found by its marker and deleted.
    let b = db.block_create(&new("Weg", t(5, 9, 0), 60, BlockLink::None), now, true).unwrap();
    *bridge.lost.borrow_mut() = true;
    assert!(flush(&db, &bridge, now, &z, false).is_err());
    *bridge.lost.borrow_mut() = false;
    db.block_delete(b.id).unwrap();
    flush(&db, &bridge, now, &z, true).unwrap();
    assert!(bridge.subjects().is_empty(), "{:?}", bridge.subjects());
    assert_eq!(db.block_outbox_len().unwrap(), 0);
}

#[test]
fn a_write_whose_answer_was_lost_does_not_add_a_second_appointment() {
    let db = Database::open_in_memory().unwrap();
    let z = Zone::Utc;
    let bridge = FakeBridge::new();
    let now = t(1, 8, 0);
    let b = db.block_create(&new("Konzept", t(5, 9, 0), 60, BlockLink::None), now, true).unwrap();
    *bridge.lost.borrow_mut() = true;
    assert!(flush(&db, &bridge, now, &z, false).is_err());
    assert_eq!(db.block(b.id).unwrap().outlook, OutlookState::Pending);
    *bridge.lost.borrow_mut() = false;
    flush(&db, &bridge, now, &z, true).unwrap();
    assert_eq!(bridge.subjects(), ["Fokus: Konzept"], "one appointment");
    assert_eq!(db.block(b.id).unwrap().outlook_entry_id.as_deref(), Some("E1"));

    // An answer without ids keeps the stored ones.
    db.block_update(b.id, &BlockPatch { title: Some("Konzept 2".into()), ..Default::default() }, now, true).unwrap();
    let ops = db.block_outbox_due(now, &z, true).unwrap();
    let r = vec![WriteResult { key: ops[0].key, ok: true, entry_id: None, global_id: None, error: None }];
    db.block_outbox_apply(&ops, &Ok(r), now).unwrap();
    assert_eq!(db.block(b.id).unwrap().outlook_entry_id.as_deref(), Some("E1"));
}

#[test]
fn the_migration_keeps_waiting_writes_and_gives_deletes_their_own_marker() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE focus_blocks (id INTEGER PRIMARY KEY, title TEXT);
         CREATE TABLE focus_block_outbox (block_id INTEGER PRIMARY KEY, op TEXT NOT NULL, entry_id TEXT, uid TEXT,
           seq INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_try TEXT, error TEXT);
         INSERT INTO focus_blocks (id, title) VALUES (1, 'a'), (2, 'b');
         INSERT INTO focus_block_outbox (block_id, op, entry_id, seq) VALUES (1, 'upsert', NULL, 2), (2, 'delete', 'E9', 1);",
    )
    .unwrap();
    c.execute_batch(include_str!("../../migrations/0018_focus_block_writes.sql")).unwrap();
    let rows: Vec<(String, Option<String>, bool, i64)> = c
        .prepare(
            "SELECT o.op, o.entry_id, EXISTS (SELECT 1 FROM focus_blocks b WHERE b.marker = o.marker), o.seq
             FROM focus_block_outbox o ORDER BY o.id",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows, [("upsert".into(), None, true, 2), ("delete".into(), Some("E9".into()), false, 1)]);
}
