use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use chrono::TimeZone;

use super::*;
use crate::calsync::{IcsSource, OUTLOOK};

fn t(day: u32, h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, day, h, m, 0).unwrap()
}

const Z: Zone = Zone::Utc;

fn local(t: DateTime<Utc>) -> String {
    t.format(LOCAL_FORMAT).to_string()
}

/// One appointment of the fake Outlook.
#[derive(Debug, Clone, Default)]
struct Item {
    folder: String,
    marker: String,
    subject: String,
    start: String,
    end: String,
    location: String,
    status: i64,
    invited: bool,
    recurring: bool,
}

/// Outlook as the script sees it: items by EntryID, Deleted Items, closed or not, an answer
/// that gets lost, the updates sent to attendees.
#[derive(Default)]
struct Fake {
    items: RefCell<HashMap<String, Item>>,
    trash: RefCell<HashMap<String, (String, Item)>>,
    closed: Cell<bool>,
    lose_answer: Cell<bool>,
    sent: RefCell<Vec<String>>,
    runs: Cell<u32>,
    n: Cell<u32>,
}

impl Fake {
    fn add(&self, id: &str, item: Item) {
        self.items.borrow_mut().insert(id.into(), item);
    }

    fn get(&self, id: &str) -> Item {
        self.items.borrow()[id].clone()
    }

    fn set(&self, f: &LocalFields, it: &mut Item) {
        if let Some(x) = &f.subject {
            it.subject = x.clone();
        }
        if let Some(x) = &f.start {
            it.start = x.clone();
        }
        if let Some(x) = &f.end {
            it.end = x.clone();
        }
        if let Some(x) = &f.location {
            it.location = x.clone();
        }
    }

    fn one(&self, o: &EntryOp) -> EntryResult {
        let folder = if o.calendar.default { String::new() } else { o.calendar.entry_id.clone() };
        let mut res =
            EntryResult { key: o.key, ok: true, modified: Some("2026-10-01T00:00:00Z".into()), ..Default::default() };
        let fail = |code: &str| EntryResult { key: o.key, ok: false, code: Some(code.into()), ..Default::default() };
        let found = {
            let items = self.items.borrow();
            o.entry_id.clone().filter(|e| items.get(e).is_some_and(|i| i.folder == folder)).or_else(|| {
                items.iter().find(|(_, i)| i.folder == folder && i.marker == o.marker).map(|(k, _)| k.clone())
            })
        };
        let id = match (o.op.as_str(), found) {
            ("restore", _) => {
                let Some((_, mut it)) = self.trash.borrow_mut().remove(o.deleted_id.as_deref().unwrap_or("")) else {
                    return fail("not_found");
                };
                self.n.set(self.n.get() + 1);
                let id = format!("R{}", self.n.get());
                it.folder = folder;
                self.set(&o.fields, &mut it);
                self.add(&id, it);
                id
            }
            ("create", Some(id)) => {
                let mut it = self.get(&id);
                self.set(&o.fields, &mut it);
                self.add(&id, it);
                id
            }
            ("create", None) => {
                self.n.set(self.n.get() + 1);
                let id = format!("E{}", self.n.get());
                let mut it = Item { folder, marker: o.marker.clone(), ..Default::default() };
                self.set(&o.fields, &mut it);
                self.add(&id, it);
                id
            }
            ("delete", None) => return res,
            (_, None) => return fail("not_found"),
            (op, Some(id)) => {
                let mut it = self.get(&id);
                if it.recurring {
                    return fail("series");
                }
                if !matches!(it.status, 0 | 1) {
                    return fail("received");
                }
                if op == "delete" {
                    if it.invited {
                        return fail("needs_send");
                    }
                    let item = self.items.borrow_mut().remove(&id).unwrap();
                    let deleted = format!("DEL-{id}");
                    self.trash.borrow_mut().insert(deleted.clone(), (id, item));
                    res.deleted_id = Some(deleted);
                    return res;
                }
                if it.invited && !o.send {
                    return fail("needs_send");
                }
                let now = LocalFields {
                    subject: Some(it.subject.clone()),
                    start: Some(it.start.clone()),
                    end: Some(it.end.clone()),
                    location: Some(it.location.clone()),
                };
                let differs = |seen: &Option<String>, mine: &Option<String>, now: &Option<String>| {
                    seen.is_some() && now != seen && now != mine
                };
                let conflict = LocalFields {
                    subject: now.subject.clone().filter(|_| differs(&o.seen.subject, &o.fields.subject, &now.subject)),
                    start: now.start.clone().filter(|_| differs(&o.seen.start, &o.fields.start, &now.start)),
                    end: now.end.clone().filter(|_| differs(&o.seen.end, &o.fields.end, &now.end)),
                    location: now
                        .location
                        .clone()
                        .filter(|_| differs(&o.seen.location, &o.fields.location, &now.location)),
                };
                if conflict != LocalFields::default() {
                    let mut r = fail("conflict");
                    r.current = Some(conflict);
                    return r;
                }
                self.set(&o.fields, &mut it);
                if o.send && it.status == 1 && it.invited {
                    self.sent.borrow_mut().push(id.clone());
                }
                self.add(&id, it);
                id
            }
        };
        res.global_id = Some(format!("G-{id}"));
        res.entry_id = Some(id);
        res
    }
}

impl EntryWriter for Fake {
    fn write(&self, ops: &[EntryOp]) -> Result<Vec<EntryResult>> {
        self.runs.set(self.runs.get() + 1);
        if self.closed.get() {
            return Err(Error::State("Outlook ist nicht geöffnet".into()));
        }
        let out: Vec<EntryResult> = ops.iter().map(|o| self.one(o)).collect();
        if self.lose_answer.replace(false) {
            return Err(Error::State("Zeitüberschreitung".into()));
        }
        Ok(out)
    }
}

fn cals() -> Vec<OutlookCalendar> {
    vec![OutlookCalendar::default_calendar("#2563eb")]
}

fn ctx(cals: &[OutlookCalendar]) -> WriteContext<'_> {
    WriteContext { enabled: true, available: true, calendars: cals }
}

/// A synced Outlook appointment (also put into the fake Outlook).
fn synced(db: &Database, fake: &Fake, id: &str, title: &str, start: DateTime<Utc>, minutes: i64, item: Item) -> String {
    let end = start + Duration::minutes(minutes);
    let it = Item { subject: title.into(), start: local(start), end: local(end), ..item };
    let ev = NewEvent {
        uid: format!("G-{id}"),
        instance: String::new(),
        recurring: it.recurring,
        start,
        end,
        all_day: false,
        title: title.into(),
        location: it.location.clone(),
        organizer: String::new(),
        attendees: if it.invited { vec!["Anna".into()] } else { vec![] },
        body: None,
        link: None,
        busy: Busy::Busy,
        private: false,
        categories: vec![],
        meta: EventMeta {
            outlook_id: Some(id.into()),
            modified: Some("2026-09-30T00:00:00Z".into()),
            meeting: it.status,
            has_attendees: it.invited,
        },
    };
    fake.add(id, it);
    let mut all: Vec<NewEvent> = db
        .calendar_events(t(1, 0, 0), t(31, 0, 0), &[OUTLOOK.into()])
        .unwrap()
        .into_iter()
        .filter(|e| e.write.is_none())
        .map(|e| e.event)
        .collect();
    all.push(ev);
    db.calendar_replace(OUTLOOK, t(1, 0, 0), t(31, 0, 0), &all).unwrap();
    event_key(OUTLOOK, &format!("G-{id}"), "")
}

/// What the next sync reads from the fake Outlook (default calendar).
fn sync(db: &Database, fake: &Fake) {
    let evs: Vec<NewEvent> = fake
        .items
        .borrow()
        .iter()
        .filter(|(_, i)| i.folder.is_empty())
        .map(|(id, i)| {
            let p = |s: &str| Utc.from_utc_datetime(&NaiveDateTime::parse_from_str(s, LOCAL_FORMAT).unwrap());
            NewEvent {
                uid: format!("G-{id}"),
                instance: String::new(),
                recurring: i.recurring,
                start: p(&i.start),
                end: p(&i.end),
                all_day: false,
                title: i.subject.clone(),
                location: i.location.clone(),
                organizer: String::new(),
                attendees: vec![],
                body: None,
                link: None,
                busy: Busy::Busy,
                private: false,
                categories: vec![],
                meta: EventMeta {
                    outlook_id: Some(id.clone()),
                    modified: None,
                    meeting: i.status,
                    has_attendees: i.invited,
                },
            }
        })
        .collect();
    db.calendar_replace(OUTLOOK, t(1, 0, 0), t(31, 0, 0), &evs).unwrap();
}

fn shown(db: &Database) -> Vec<CalendarEvent> {
    db.calendar_events(t(1, 0, 0), t(31, 0, 0), &[OUTLOOK.into()]).unwrap()
}

fn draft(title: &str, start: DateTime<Utc>, minutes: i64) -> EntryDraft {
    EntryDraft {
        source: OUTLOOK.into(),
        title: title.into(),
        start,
        end: start + Duration::minutes(minutes),
        location: String::new(),
    }
}

fn patch_title(title: &str) -> Fields {
    Fields { title: Some(title.into()), ..Default::default() }
}

#[test]
fn a_new_appointment_is_shown_at_once_written_and_seen_once_after_the_sync() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let ev = db.entry_create(&draft("Angebot schreiben", t(5, 9, 0), 30), now).unwrap();
    assert!(ev.key.starts_with("outlook|arcalo-entry-") && ev.key.ends_with('|'), "{}", ev.key);
    assert_eq!(ev.write.as_ref().map(|w| (w.op.as_str(), w.state.as_str())), Some(("create", "pending")));
    assert_eq!(editability(&ev, &ctx(&cals())), Editability::Yes, "a waiting new one can be changed");
    // Booked or marked before Outlook has it: the mark moves to its real key.
    db.calendar_set_skip(&ev.key, true).unwrap();
    assert_eq!(shown(&db).len(), 1);

    assert_eq!(flush(&db, &fake, now, &Z, false, &cals()).unwrap(), 1);
    let all = shown(&db);
    assert_eq!(all.len(), 1);
    let e = &all[0];
    assert_eq!(
        (e.key.as_str(), e.event.title.as_str(), e.event.meta.outlook_id.as_deref()),
        ("outlook|G-E1|", "Angebot schreiben", Some("E1"))
    );
    assert!(e.write.is_none() && e.skip, "written, the mark followed");
    let it = fake.get("E1");
    assert_eq!(
        (it.start.as_str(), it.end.as_str(), it.marker.starts_with(MARKER_PREFIX)),
        ("2026-10-05T09:00:00", "2026-10-05T09:30:00", true)
    );

    // The next sync brings it back from Outlook: shown once.
    sync(&db, &fake);
    let all = shown(&db);
    assert_eq!(all.len(), 1);
    assert!(all[0].skip);
    assert_eq!(db.entry_outbox_len().unwrap(), 0);
}

#[test]
fn a_lost_answer_finds_the_appointment_by_its_marker() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    db.entry_create(&draft("Review", t(5, 9, 0), 60), now).unwrap();
    fake.lose_answer.set(true);
    assert!(flush(&db, &fake, now, &Z, false, &cals()).is_err());
    assert_eq!(fake.items.borrow().len(), 1, "Outlook saved it, the answer got lost");
    let w = shown(&db)[0].write.clone().unwrap();
    assert!(w.error.as_deref().unwrap().contains("Zeitüberschreitung"));
    // Retried after the back-off: found by its marker, no second appointment.
    assert_eq!(flush(&db, &fake, now, &Z, false, &cals()).unwrap(), 0, "not due yet");
    assert_eq!(flush(&db, &fake, now + Duration::minutes(1), &Z, false, &cals()).unwrap(), 1);
    assert_eq!(fake.items.borrow().len(), 1);
    assert_eq!(shown(&db)[0].key, "outlook|G-E1|");
}

#[test]
fn a_change_during_a_write_is_not_lost() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let ev = db.entry_create(&draft("Entwurf", t(5, 9, 0), 60), now).unwrap();
    // The write runs, meanwhile the user renames it.
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    let results = fake.write(&ops);
    db.entry_update(&ev.key, &patch_title("Endfassung"), false, now).unwrap();
    db.entry_outbox_apply(&ops, &results, now, &Z).unwrap();
    assert_eq!(fake.get("E1").subject, "Entwurf");
    let e = shown(&db).pop().unwrap();
    assert_eq!((e.event.title.as_str(), e.write.as_ref().map(|w| w.op.as_str())), ("Endfassung", Some("update")));
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(fake.get("E1").subject, "Endfassung");
    assert_eq!(fake.items.borrow().len(), 1);
    assert!(shown(&db)[0].write.is_none());

    // The same for a change of an existing appointment.
    let key = synced(&db, &fake, "A", "Jour fixe", t(6, 10, 0), 60, Item::default());
    db.entry_update(
        &key,
        &Fields { start: Some(t(6, 11, 0)), end: Some(t(6, 12, 0)), ..Default::default() },
        false,
        now,
    )
    .unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    let results = fake.write(&ops);
    db.entry_update(&key, &patch_title("Jour fixe neu"), false, now).unwrap();
    db.entry_outbox_apply(&ops, &results, now, &Z).unwrap();
    assert_eq!(fake.get("A").start, "2026-10-06T11:00:00");
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    let a = fake.get("A");
    assert_eq!(
        (a.subject.as_str(), a.start.as_str()),
        ("Jour fixe neu", "2026-10-06T11:00:00"),
        "no conflict with its own write"
    );
    assert_eq!(db.entry_outbox_len().unwrap(), 0);
}

#[test]
fn changes_are_patches_merged_per_appointment_and_dropped_when_undone() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let key =
        synced(&db, &fake, "A", "Planung", t(6, 10, 0), 60, Item { location: "Raum 1".into(), ..Default::default() });
    db.entry_update(&key, &Fields { end: Some(t(6, 11, 30)), ..Default::default() }, false, now).unwrap();
    db.entry_update(&key, &patch_title("Planung Q4"), false, now).unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    assert_eq!(ops.len(), 1, "one write per appointment");
    let f = &ops[0].fields;
    assert_eq!(
        (f.subject.as_deref(), f.start.as_deref(), f.end.as_deref(), f.location.as_deref()),
        (Some("Planung Q4"), None, Some("2026-10-06T11:30:00"), None),
        "only what changed"
    );
    assert_eq!(
        (ops[0].seen.subject.as_deref(), ops[0].seen.end.as_deref()),
        (Some("Planung"), Some("2026-10-06T11:00:00"))
    );
    // Both changed back: nothing left to write.
    db.entry_update(
        &key,
        &Fields { title: Some("Planung".into()), end: Some(t(6, 11, 0)), ..Default::default() },
        false,
        now,
    )
    .unwrap();
    assert_eq!(db.entry_outbox_len().unwrap(), 0);
    assert!(shown(&db)[0].write.is_none());
    assert!(
        db.entry_update(&key, &Fields { end: Some(t(6, 9, 0)), ..Default::default() }, false, now).is_err(),
        "end before start"
    );
}

#[test]
fn conflicts_are_settled_either_way_and_other_fields_never_conflict() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let key = synced(&db, &fake, "A", "Kickoff", t(6, 10, 0), 60, Item::default());

    // Different fields: Outlook moved the place, Arcalo the title.
    db.entry_update(&key, &patch_title("Kickoff Kunde"), false, now).unwrap();
    fake.items.borrow_mut().get_mut("A").unwrap().location = "Raum 2".into();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    let a = fake.get("A");
    assert_eq!((a.subject.as_str(), a.location.as_str()), ("Kickoff Kunde", "Raum 2"));

    // The same field: Outlook's version taken.
    db.entry_update(&key, &patch_title("Kickoff (verschoben)"), false, now).unwrap();
    fake.items.borrow_mut().get_mut("A").unwrap().subject = "Kickoff Kunde X".into();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    let e = shown(&db).pop().unwrap();
    let w = e.write.clone().unwrap();
    assert_eq!(w.state, "conflict");
    assert_eq!(w.outlook.as_ref().and_then(|f| f.title.as_deref()), Some("Kickoff Kunde X"));
    assert_eq!(w.mine.as_ref().and_then(|f| f.title.as_deref()), Some("Kickoff (verschoben)"));
    assert_eq!(db.entry_outbox_len().unwrap(), 0, "a conflict waits for the user, not for a retry");
    db.entry_resolve(&key, false).unwrap();
    let e = shown(&db).pop().unwrap();
    assert_eq!((e.event.title.as_str(), e.write.is_none()), ("Kickoff Kunde X", true));
    assert_eq!(fake.get("A").subject, "Kickoff Kunde X");

    // Again, the user's change kept.
    db.entry_update(&key, &patch_title("Kickoff final"), false, now).unwrap();
    fake.items.borrow_mut().get_mut("A").unwrap().subject = "Kickoff (Outlook)".into();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(shown(&db)[0].write.as_ref().unwrap().state, "conflict");
    db.entry_resolve(&key, true).unwrap();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(fake.get("A").subject, "Kickoff final");
    let e = shown(&db).pop().unwrap();
    assert_eq!((e.event.title.as_str(), e.write.is_none()), ("Kickoff final", true));
}

#[test]
fn deletes_go_to_deleted_items_and_come_back_with_undo() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let key = synced(&db, &fake, "A", "Zahnarzt", t(7, 15, 0), 60, Item::default());
    db.calendar_set_skip(&key, true).unwrap();

    // Undone before Outlook had it: nothing is written.
    db.entry_delete(&key, now).unwrap();
    assert!(shown(&db).is_empty());
    db.entry_undo(&key).unwrap();
    assert_eq!(shown(&db).len(), 1);
    assert_eq!(flush(&db, &fake, now, &Z, false, &cals()).unwrap(), 0);

    // Deleted in Outlook (to Deleted Items), then brought back.
    db.entry_delete(&key, now).unwrap();
    assert_eq!(flush(&db, &fake, now, &Z, false, &cals()).unwrap(), 1);
    assert!(fake.items.borrow().is_empty() && fake.trash.borrow().contains_key("DEL-A"));
    sync(&db, &fake);
    assert!(shown(&db).is_empty());
    let back = db.entry_undo(&key).unwrap();
    assert_eq!((back.event.title.as_str(), back.write.as_ref().map(|w| w.op.as_str())), ("Zahnarzt", Some("restore")));
    assert_eq!(shown(&db).len(), 1, "shown again at once");
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(fake.items.borrow().len(), 1);
    sync(&db, &fake);
    let all = shown(&db);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].event.title, "Zahnarzt");

    // A new appointment deleted before it was written never reaches Outlook; undo writes it after all.
    let ev = db.entry_create(&draft("Doch nicht", t(8, 9, 0), 30), now).unwrap();
    db.entry_delete(&ev.key, now).unwrap();
    assert_eq!(flush(&db, &fake, now, &Z, false, &cals()).unwrap(), 0);
    assert_eq!(shown(&db).len(), 1);
    db.entry_undo(&ev.key).unwrap();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(fake.items.borrow().len(), 2);
    let written = shown(&db).into_iter().find(|e| e.event.title == "Doch nicht").unwrap();
    assert_eq!(written.key, "outlook|G-E2|");
    // Done deletes are kept a day for their undo.
    db.entry_delete(&written.key, now).unwrap();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    db.entry_outbox_due(now + Duration::hours(UNDO_HOURS + 1), &Z, false, &cals()).unwrap();
    assert!(db.entry_undo(&written.key).is_err(), "too late");
}

#[test]
fn a_new_appointment_deleted_while_its_write_is_under_way_leaves_nothing_in_outlook() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    // Outlook saves it, the answer gets lost, and the user deletes it while the write runs.
    let ev = db.entry_create(&draft("Kurz", t(5, 9, 0), 30), now).unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    fake.lose_answer.set(true);
    let results = fake.write(&ops);
    db.entry_delete(&ev.key, now).unwrap();
    db.entry_outbox_apply(&ops, &results, now, &Z).unwrap();
    assert!(shown(&db).is_empty());
    flush(&db, &fake, now + Duration::minutes(5), &Z, false, &cals()).unwrap();
    assert!(fake.items.borrow().is_empty(), "deleted in Outlook by its marker: {:?}", fake.items.borrow());

    // The same with a rename while the write ran.
    let ev = db.entry_create(&draft("Entwurf", t(5, 11, 0), 30), now).unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    fake.lose_answer.set(true);
    let results = fake.write(&ops);
    db.entry_update(&ev.key, &patch_title("Endfassung"), false, now).unwrap();
    db.entry_outbox_apply(&ops, &results, now, &Z).unwrap();
    db.entry_delete(&ev.key, now).unwrap();
    flush(&db, &fake, now + Duration::minutes(5), &Z, false, &cals()).unwrap();
    assert!(fake.items.borrow().is_empty(), "{:?}", fake.items.borrow());
    assert!(shown(&db).is_empty());
    // Its undo still writes it.
    db.entry_undo(&ev.key).unwrap();
    flush(&db, &fake, now + Duration::minutes(6), &Z, false, &cals()).unwrap();
    assert_eq!(fake.items.borrow().len(), 1);
    assert_eq!(fake.items.borrow().values().next().unwrap().subject, "Endfassung");
}

#[test]
fn a_delete_undone_and_deleted_again_while_it_is_written_stays_deleted() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let key = synced(&db, &fake, "A", "Zahnarzt", t(7, 15, 0), 60, Item::default());
    db.entry_delete(&key, now).unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    let results = fake.write(&ops);
    db.entry_undo(&key).unwrap();
    db.entry_delete(&key, now).unwrap();
    db.entry_outbox_apply(&ops, &results, now, &Z).unwrap();
    assert!(shown(&db).is_empty(), "the last thing the user did was the delete");
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert!(fake.items.borrow().is_empty() && fake.trash.borrow().contains_key("DEL-A"));
    sync(&db, &fake);
    assert!(shown(&db).is_empty());
    // Its undo brings it back.
    db.entry_undo(&key).unwrap();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(fake.items.borrow().len(), 1);
}

#[test]
fn a_restore_whose_answer_got_lost_does_not_wait_forever() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let key = synced(&db, &fake, "A", "Zahnarzt", t(7, 15, 0), 60, Item::default());
    db.entry_delete(&key, now).unwrap();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    db.entry_undo(&key).unwrap();
    fake.lose_answer.set(true);
    assert!(flush(&db, &fake, now, &Z, false, &cals()).is_err());
    assert_eq!(fake.items.borrow().len(), 1, "moved back, the answer got lost");
    flush(&db, &fake, now + Duration::minutes(5), &Z, false, &cals()).unwrap();
    assert_eq!(db.entry_outbox_len().unwrap(), 0, "nothing left to retry");
    sync(&db, &fake);
    let all = shown(&db);
    assert_eq!(all.len(), 1);
    assert!(all[0].write.is_none(), "{:?}", all[0].write);

    // A delete whose answer got lost has no item in Deleted Items to move back: the undo says so.
    db.entry_delete(&all[0].key, now).unwrap();
    fake.lose_answer.set(true);
    assert!(flush(&db, &fake, now, &Z, false, &cals()).is_err());
    flush(&db, &fake, now + Duration::minutes(5), &Z, false, &cals()).unwrap();
    let e = db.entry_undo(&all[0].key).unwrap_err();
    assert!(e.to_string().contains("Gelöschte Elemente"), "{e}");
    assert_eq!(db.entry_outbox_len().unwrap(), 0);
}

#[test]
fn titles_and_places_arcalo_shows_instead_of_outlooks_never_conflict() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    // An appointment without a subject is shown as „(Ohne Betreff)“; naming it is no conflict.
    let key = synced(&db, &fake, "A", "(Ohne Betreff)", t(6, 9, 0), 30, Item::default());
    fake.items.borrow_mut().get_mut("A").unwrap().subject = String::new();
    db.entry_update(&key, &patch_title("Benannt"), false, now).unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    assert_eq!(ops[0].seen.subject, None);
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(fake.get("A").subject, "Benannt");

    // A private one keeps its subject and place in Outlook; a new place is no conflict and
    // Outlook's place never comes into Arcalo.
    let key = synced(
        &db,
        &fake,
        "P",
        crate::calsync::PRIVATE_TITLE,
        t(6, 11, 0),
        30,
        Item { location: String::new(), ..Default::default() },
    );
    db.conn().execute("UPDATE calendar_events SET private = 1 WHERE uid = 'G-P'", []).unwrap();
    {
        let mut items = fake.items.borrow_mut();
        let p = items.get_mut("P").unwrap();
        p.subject = "Arzt".into();
        p.location = "Praxis".into();
    }
    db.entry_update(&key, &Fields { location: Some("Praxis Nord".into()), ..Default::default() }, false, now).unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals()).unwrap();
    assert_eq!((ops[0].seen.subject.as_deref(), ops[0].seen.location.as_deref()), (None, None));
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    let p = fake.get("P");
    assert_eq!((p.subject.as_str(), p.location.as_str()), ("Arzt", "Praxis Nord"));
    assert_eq!(db.entry_outbox_len().unwrap(), 0);
}

#[test]
fn read_only_kinds_and_the_reason_for_each() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let mine = synced(&db, &fake, "A", "Eigener Termin", t(6, 9, 0), 30, Item::default());
    let received =
        synced(&db, &fake, "B", "Einladung", t(6, 10, 0), 30, Item { status: 3, invited: true, ..Default::default() });
    let series = synced(&db, &fake, "C", "Daily", t(6, 11, 0), 15, Item { recurring: true, ..Default::default() });
    let organized =
        synced(&db, &fake, "D", "Workshop", t(6, 13, 0), 60, Item { status: 1, invited: true, ..Default::default() });
    let alone = synced(&db, &fake, "E", "Fokuszeit", t(6, 15, 0), 60, Item { status: 1, ..Default::default() });
    let mut cals = cals();
    let ev = |k: &str| db.calendar_event(k).unwrap();
    let c = ctx(&cals);
    assert_eq!(editability(&ev(&mine), &c), Editability::Yes);
    assert_eq!(editability(&ev(&received), &c), Editability::Received);
    assert_eq!(editability(&ev(&series), &c), Editability::Series);
    assert_eq!(editability(&ev(&organized), &c), Editability::Confirm);
    assert_eq!(editability(&ev(&alone), &c), Editability::Yes, "organized without attendees");
    assert_eq!(editability(&ev(&mine), &WriteContext { enabled: false, ..c }), Editability::Off);
    assert_eq!(
        editability(&ev(&received), &WriteContext { enabled: false, ..c }),
        Editability::Received,
        "read-only stays read-only"
    );
    assert_eq!(editability(&ev(&mine), &WriteContext { available: false, ..c }), Editability::Unavailable);
    let mut ics = ev(&mine);
    ics.source = IcsSource { id: "s1".into(), ..Default::default() }.source_id();
    assert_eq!(editability(&ics, &c), Editability::Ics);
    let mut old = ev(&mine);
    old.event.meta.outlook_id = None;
    assert_eq!(editability(&old, &c), Editability::Unknown);
    cals[0].free_busy = true;
    assert_eq!(editability(&ev(&mine), &ctx(&cals)), Editability::FreeBusy);
    cals[0].free_busy = false;
    cals[0].kind = OutlookKind::Shared;
    assert_eq!(editability(&ev(&mine), &ctx(&cals)), Editability::Shared);
    assert!(!writable_calendar(&cals[0]));

    // The core refuses what the Kalender does not offer.
    for k in [&received, &series] {
        assert!(db.entry_update(k, &patch_title("x"), true, now).is_err(), "{k}");
        assert!(db.entry_delete(k, now).is_err(), "{k}");
    }
    assert!(db.entry_delete(&organized, now).is_err(), "cancelled in Outlook");
    assert!(db.entry_create(&EntryDraft { source: "ics:s1".into(), ..draft("x", t(6, 9, 0), 30) }, now).is_err());
    assert_eq!(db.entry_outbox_len().unwrap(), 0);
}

#[test]
fn an_organized_meeting_is_changed_only_with_the_update_to_its_attendees() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let key =
        synced(&db, &fake, "D", "Workshop", t(6, 13, 0), 60, Item { status: 1, invited: true, ..Default::default() });
    let later = Fields { start: Some(t(6, 14, 0)), end: Some(t(6, 15, 0)), ..Default::default() };
    let e = db.entry_update(&key, &later, false, now).unwrap_err();
    assert!(e.to_string().contains("Teilnehmende"), "{e}");
    assert_eq!(db.entry_outbox_len().unwrap(), 0, "nothing saved without the confirmation");
    let ev = db.entry_update(&key, &later, true, now).unwrap();
    assert!(ev.write.as_ref().unwrap().send);
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(*fake.sent.borrow(), ["D"], "Outlook sent the update");
    assert_eq!(fake.get("D").start, "2026-10-06T14:00:00");
    // A plain appointment never sends anything.
    let mine = synced(&db, &fake, "A", "Notiz", t(6, 9, 0), 30, Item::default());
    db.entry_update(&mine, &patch_title("Notiz 2"), true, now).unwrap();
    flush(&db, &fake, now, &Z, false, &cals()).unwrap();
    assert_eq!(fake.sent.borrow().len(), 1);
}

#[test]
fn a_closed_outlook_keeps_the_writes_waiting_with_a_growing_delay() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let key = synced(&db, &fake, "A", "Telefonat", t(6, 9, 0), 30, Item::default());
    db.entry_update(&key, &patch_title("Telefonat Kunde"), false, now).unwrap();
    fake.closed.set(true);
    assert!(flush(&db, &fake, now, &Z, false, &cals()).is_err());
    let w = shown(&db)[0].write.clone().unwrap();
    assert_eq!(w.state, "pending");
    assert!(w.error.unwrap().contains("nicht geöffnet"));
    assert_eq!(shown(&db)[0].event.title, "Telefonat Kunde", "shown as changed meanwhile");
    // 1 minute, then 2.
    assert!(db.entry_outbox_due(now + Duration::seconds(59), &Z, false, &cals()).unwrap().is_empty());
    assert!(flush(&db, &fake, now + Duration::minutes(1), &Z, false, &cals()).is_err());
    assert!(db.entry_outbox_due(now + Duration::minutes(2), &Z, false, &cals()).unwrap().is_empty());
    assert_eq!(
        db.entry_outbox_due(now + Duration::minutes(2), &Z, true, &cals()).unwrap().len(),
        1,
        "„Erneut versuchen“"
    );
    fake.closed.set(false);
    assert_eq!(flush(&db, &fake, now + Duration::minutes(3), &Z, false, &cals()).unwrap(), 1);
    assert_eq!(fake.get("A").subject, "Telefonat Kunde");
    assert_eq!(fake.runs.get(), 3);
}

#[test]
fn new_appointments_go_to_the_chosen_own_calendar() {
    let db = Database::open_in_memory().unwrap();
    let fake = Fake::default();
    let now = t(1, 8, 0);
    let mut cals = cals();
    cals.push(OutlookCalendar {
        id: "outlook:abcdefabcdef".into(),
        entry_id: "PROJ".into(),
        store_id: "S".into(),
        name: "Projekt".into(),
        enabled: true,
        ..Default::default()
    });
    let ev = db
        .entry_create(
            &EntryDraft { source: "outlook:abcdefabcdef".into(), ..draft("Projekttermin", t(6, 9, 0), 30) },
            now,
        )
        .unwrap();
    let ops = db.entry_outbox_due(now, &Z, false, &cals).unwrap();
    assert_eq!(ops[0].calendar, CalendarRef { default: false, entry_id: "PROJ".into(), store_id: "S".into() });
    db.entry_outbox_apply(&ops, &fake.write(&ops), now, &Z).unwrap();
    assert_eq!(fake.get("E1").folder, "PROJ");
    assert!(
        db.calendar_events(t(1, 0, 0), t(31, 0, 0), &["outlook:abcdefabcdef".into()]).unwrap()[0].key.contains("G-E1")
    );
    assert!(ev.key.starts_with("outlook:abcdefabcdef|"));
    // The setting falls back to the default calendar when its target is not an own one anymore.
    let mut s =
        crate::calsync::CalendarSettings { entry_target: "outlook:gone".into(), ..Default::default() }.normalized();
    assert_eq!(s.entry_target, OUTLOOK);
    s.entry_minutes = 7;
    assert_eq!(s.normalized().entry_minutes, 15);
}

#[test]
fn script_answers_and_ops_have_the_documented_shape() {
    let out = r#"{"ok":true,"results":[{"id":3,"ok":true,"entryId":"00A","globalId":"040","modified":"2026-10-01T08:00:00Z","deletedId":""},
        {"id":4,"ok":false,"error":"conflict","current":{"subject":"Neu in Outlook"}},
        {"id":5,"ok":false,"error":"needs_send"}]}"#;
    let r = crate::calsync::outlookwrite::parse_entries_output(out).unwrap();
    assert_eq!(
        (r[0].ok, r[0].entry_id.as_deref(), r[0].modified.as_deref(), r[0].deleted_id.as_deref()),
        (true, Some("00A"), Some("2026-10-01T08:00:00Z"), None)
    );
    assert_eq!(
        (r[1].code.as_deref(), r[1].current.as_ref().and_then(|c| c.subject.as_deref())),
        (Some("conflict"), Some("Neu in Outlook"))
    );
    assert!(r[2].error.as_deref().unwrap().contains("Teilnehmende"));
    let e = crate::calsync::outlookwrite::parse_entries_output(r#"{"ok":false,"error":"not_running"}"#).unwrap_err();
    assert!(e.to_string().contains("Änderung wird eingetragen"), "{e}");

    let db = Database::open_in_memory().unwrap();
    db.entry_create(&EntryDraft { location: "Raum 3".into(), ..draft("Neu", t(6, 9, 0), 45) }, t(1, 8, 0)).unwrap();
    let ops = db.entry_outbox_due(t(1, 8, 0), &Z, false, &cals()).unwrap();
    let v = ops_json(&ops);
    assert_eq!(v[0]["kind"], "entry");
    assert_eq!(v[0]["op"], "create");
    assert!(v[0]["marker"].as_str().unwrap().starts_with(MARKER_PREFIX));
    assert_eq!(v[0]["calendar"]["default"], true);
    assert_eq!(
        v[0]["fields"],
        serde_json::json!({"subject": "Neu", "start": "2026-10-06T09:00:00", "end": "2026-10-06T09:45:00", "location": "Raum 3"})
    );
    assert_eq!(v[0]["seen"], serde_json::json!({}));
    assert_eq!(v[0]["send"], false);
}

#[test]
fn the_script_writes_appointments_without_starting_outlook_and_sends_only_when_confirmed() {
    let script = crate::calsync::outlook::SCRIPT;
    assert!(script.is_ascii());
    for needle in [
        "$o.kind -eq 'entry'",
        "Write-Entry",
        "'ArcaloEntry'",
        "Find-Entry",
        "error = 'conflict'",
        "error = 'series'",
        "error = 'received'",
        "error = 'needs_send'",
        "GetDefaultFolder(3)",
        "LastModificationTime",
        "$Mode -eq 'show'",
        ".Display()",
        "[string]$EntryId",
    ] {
        assert!(script.contains(needle), "{needle}");
    }
    // `.Send(` only once, in the path of an organized meeting whose update the user confirmed.
    let sends: Vec<&str> = script.lines().filter(|l| l.contains(".Send(")).collect();
    assert_eq!(sends.len(), 1, "{sends:?}");
    assert!(sends[0].contains("if ($o.send -and $status -eq 1 -and $invited -gt 0)"), "{}", sends[0]);
    // Writes only attach to a running Outlook.
    let write = &script[script.find("if ($Mode -eq 'write')").unwrap()..script.find("if ($Mode -eq 'show')").unwrap()];
    assert!(write.contains("GetActiveObject('Outlook.Application')") && !write.contains("New-Object -ComObject"));
    // Recipients of an appointment that is no meeting were never invited: no refusal for them.
    assert!(script.contains("if ($status -ne 0) { $invited = Count-Invited $item }"));
    // A new start alone keeps the end; spaces around a text are no conflict.
    assert!(script.contains("elseif ($null -ne $f.start) { $end = $item.End }"));
    assert!(script.contains("$is = ([string]$now[$k]).Trim()") && script.contains("-cne ([string]$seen).Trim()"));
    // A restore moved back by a try whose answer got lost is not moved again.
    assert!(script.contains("if (-not $back) { $item = $item.Move($folder) }"));
    // The read gives what a write needs.
    assert!(script.contains("modified       = ''") && script.contains("recipients     = 0"));
}

#[test]
fn the_read_keeps_what_a_write_needs() {
    let out = r#"{"ok":true,"items":[
      {"entryId":"A","globalId":"G1","subject":"Workshop","start":"2026-10-21T08:00:00Z","end":"2026-10-21T09:00:00Z","meetingStatus":1,"recipients":2,"modified":"2026-10-20T07:00:00Z","organizer":"Ich","attendees":["Ich","Anna"]},
      {"entryId":"B","globalId":"G2","subject":"Allein","start":"2026-10-21T10:00:00Z","end":"2026-10-21T11:00:00Z","meetingStatus":1,"recipients":0,"organizer":"Ich","attendees":"Ich"},
      {"entryId":"C","globalId":"G3","subject":"","start":"2026-10-21T12:00:00Z","end":"2026-10-21T13:00:00Z","meetingStatus":1,"recipients":3,"sensitivity":2},
      {"entryId":"D","globalId":"G4","subject":"Alt","start":"2026-10-21T14:00:00Z","end":"2026-10-21T15:00:00Z","meetingStatus":1,"organizer":"Ich","attendees":["Ich","Jörg"]}]}"#;
    let privacy = crate::calsync::Privacy { private_details: false, include_body: false, meeting_links: false };
    let evs = crate::calsync::outlook::parse_output(out, &Zone::Utc, privacy).unwrap();
    let m: Vec<(&str, bool, i64)> =
        evs.iter().map(|e| (e.meta.outlook_id.as_deref().unwrap(), e.meta.has_attendees, e.meta.meeting)).collect();
    assert_eq!(
        m,
        [("A", true, 1), ("B", false, 1), ("C", true, 1), ("D", true, 1)],
        "the count, else the names; a private one too"
    );
    assert_eq!(evs[0].meta.modified.as_deref(), Some("2026-10-20T07:00:00Z"));
    assert!(evs[2].attendees.is_empty(), "the names of a private one are dropped, the count stays");
}
