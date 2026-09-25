//! „Woche vorschlagen“: a timesheet draft for a week from what the user did – meetings of the
//! calendar sync, focus sessions that were not booked and editing sessions on pages – that the
//! user reviews and takes over in one go ([`apply`]).
//!
//! The proposal is deterministic (no AI):
//!
//! * **Signals** ([`collect`]): appointments that are over (not all-day, not free or out of
//!   office, not private without details, not marked „nicht buchen“, not booked), finished focus
//!   sessions without a booking, and page edits from the activity journal (one row per page and
//!   hour: the editing session ends at its last save and lasts about two minutes per save, 10 to
//!   60 minutes; daily notes and single tiny edits do not count, nor edits on days off).
//! * **WBS** ([`resolve`]): first what the user decided (the series or subject of a booked
//!   appointment, a page or text remembered from an earlier proposal) and explicit links (a
//!   page's `vorgang:` property, that of a parent page, the meeting note's, the Vorgang of a focus
//!   session), then history (booked from this page before, an entry described alike), then the
//!   similarity of the text to Vorgang names and recent booking texts (token overlap); else none.
//! * **Time** ([`build`]): each local day is cut into slots of the rounding step (5 minutes when
//!   rounding is off). Slots touched by an existing booking or a running timer, and slots after
//!   „now“ (or after today, when the rest of today is wanted), are never proposed. A slot goes to
//!   the signal that covers most of it (with rounding „nearest“ at least half), focus before
//!   appointments before page edits. Runs of slots with the same WBS (or, without WBS, of the
//!   same source) become one proposal; small free holes between them are bridged. On workdays
//!   the proposals are cut to the daily target minus what is booked (weakest signals first), and
//!   what is still missing is reported as the day's gap.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::calsync::tz::Zone;
use crate::calsync::{Busy, CalendarEvent, HintBasis, PRIVATE_TITLE};
use crate::db::{Database, EntryFilter, parse_ts, ts};
use crate::error::{Error, Result};
use crate::model::{EntrySource, NewTimeEntry, StatusFlag};
use crate::tracking::{self, BudgetStatus, Thresholds};

/// Where a proposal comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Calendar,
    Focus,
    Page,
}

impl SourceKind {
    /// Which signal gets a contested slot: focus sessions were really worked, meetings are
    /// in the calendar, page edits are an estimate.
    fn priority(self) -> u8 {
        match self {
            SourceKind::Focus => 3,
            SourceKind::Calendar => 2,
            SourceKind::Page => 1,
        }
    }
}

/// A source of a proposal: an appointment (`id` = event key), a focus session or a page (ids).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceRef {
    pub kind: SourceKind,
    pub id: String,
    /// Subject, goal or page title.
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    None,
    Low,
    Medium,
    High,
}

/// Why a WBS was chosen, in the order they are tried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    /// The user chose it before (booked series or subject, remembered page or text).
    Learned,
    /// An explicit link: `vorgang:` property, focus session on a Vorgang.
    Link,
    /// Booked like this before.
    History,
    /// The text resembles the Vorgang.
    Similar,
}

/// The WBS proposed for a booking.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WbsGuess {
    pub netzplan_id: i64,
    pub vorgang_nr: Option<String>,
    pub leistungsart: Option<String>,
    /// `NP-8801/1020` or `NP-8801`.
    pub reference: String,
    pub confidence: Confidence,
    pub basis: Basis,
    /// „wie letzte Woche: Jour fixe Kunde X“
    pub reason: String,
}

/// Something the user did in a stretch of time.
#[derive(Debug, Clone, PartialEq)]
pub struct Signal {
    pub kind: SourceKind,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub text: String,
    pub source: SourceRef,
    pub wbs: Option<WbsGuess>,
}

impl Signal {
    fn confidence(&self) -> Confidence {
        self.wbs.as_ref().map_or(Confidence::None, |w| w.confidence)
    }

    /// Signals with the same key merge: the WBS, or the source itself without one.
    fn group(&self) -> String {
        match &self.wbs {
            Some(w) => format!("wbs:{}/{}", w.netzplan_id, w.vorgang_nr.as_deref().unwrap_or("").to_lowercase()),
            None => format!("src:{:?}:{}", self.source.kind, self.source.id),
        }
    }
}

/// A proposed booking.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    /// Stable within one proposal (start and group).
    pub id: String,
    /// Local day.
    pub date: NaiveDate,
    pub start: DateTime<Utc>,
    pub minutes: i64,
    pub text: String,
    /// The source with the most time in it.
    pub kind: SourceKind,
    pub wbs: Option<WbsGuess>,
    pub confidence: Confidence,
    pub reason: String,
    pub sources: Vec<SourceRef>,
}

/// Totals of one day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaySummary {
    pub date: NaiveDate,
    pub workday: bool,
    /// Daily target on workdays, 0 otherwise.
    pub target_minutes: i64,
    /// Finished entries of the day (drafts included).
    pub booked_minutes: i64,
    pub proposed_minutes: i64,
    /// What is still missing to the target after booked and proposed (workdays that began).
    pub gap_minutes: i64,
    /// Proposed time left out because the day would exceed its target.
    pub capped_minutes: i64,
    /// The day has begun (proposals are possible).
    pub started: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekProposal {
    pub week_start: NaiveDate,
    pub days: Vec<DaySummary>,
    pub proposals: Vec<Proposal>,
    /// Nothing after this instant is proposed (now, or the end of today).
    pub until: DateTime<Utc>,
    /// Slot length in minutes.
    pub step_minutes: i64,
}

/// Options of [`propose`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProposeOptions {
    /// Also propose today's appointments that are still to come.
    pub rest_of_today: bool,
    /// Calendar sources to read (the active ones); `None` reads all stored events.
    pub sources: Option<Vec<String>>,
}

// ------------------------------------------------------------------ building

/// One local day for [`build`].
#[derive(Debug, Clone, PartialEq)]
pub struct Day {
    pub date: NaiveDate,
    /// Local midnight and the next one, in UTC (23 or 25 hours apart on DST days).
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub workday: bool,
    pub booked_minutes: i64,
}

/// How [`build`] cuts and caps.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    /// Slot length (the rounding step, at least 5 minutes).
    pub step: i64,
    /// Rounding up: a slot counts when a signal touches it; else it must cover half of it.
    pub round_up: bool,
    /// Daily target on workdays (0 = no cap).
    pub target_minutes: i64,
    /// Nothing at or after this instant is proposed.
    pub until: DateTime<Utc>,
    /// Holes up to this many minutes between blocks of the same group are bridged.
    pub bridge_minutes: i64,
}

impl Plan {
    /// From the settings: rounding step and mode, daily target.
    pub fn from_settings(s: &crate::settings::Settings, until: DateTime<Utc>) -> Plan {
        let r = s.time.rounding;
        let step = (r.step_minutes as i64).max(5);
        Plan {
            step,
            round_up: r.mode == crate::prefs::RoundMode::Up,
            target_minutes: (s.daily_target_hours * 60.0).round().max(0.0) as i64,
            until,
            bridge_minutes: step.max(15),
        }
    }
}

fn overlap(a0: DateTime<Utc>, a1: DateTime<Utc>, b0: DateTime<Utc>, b1: DateTime<Utc>) -> i64 {
    (a1.min(b1) - a0.max(b0)).num_seconds().max(0)
}

/// How a signal claims a slot: covers half of it, source priority, coverage, earlier start; its index.
type Rank = (bool, u8, i64, std::cmp::Reverse<DateTime<Utc>>, usize);

/// Cuts the signals into proposals per day, around the existing bookings (`busy`), see the
/// module documentation.
pub fn build(
    days: &[Day],
    signals: &[Signal],
    busy: &[(DateTime<Utc>, DateTime<Utc>)],
    plan: &Plan,
) -> (Vec<Proposal>, Vec<DaySummary>) {
    let step = Duration::minutes(plan.step);
    let step_secs = plan.step * 60;
    let mut proposals = vec![];
    let mut summaries = vec![];
    for day in days {
        let n = ((day.to - day.from).num_seconds() / step_secs).max(0) as usize;
        let slot = |i: usize| (day.from + step * i as i32, day.from + step * (i as i32 + 1));
        let blocked: Vec<bool> = (0..n)
            .map(|i| {
                let (s, e) = slot(i);
                e > plan.until || busy.iter().any(|&(b0, b1)| b0 < e && b1 > s)
            })
            .collect();
        // Each free slot goes to the signal that covers most of it (then by source priority).
        let mut assign: Vec<Option<usize>> = vec![None; n];
        for (i, a) in assign.iter_mut().enumerate() {
            if blocked[i] {
                continue;
            }
            let (s, e) = slot(i);
            let mut best: Option<Rank> = None;
            for (k, sig) in signals.iter().enumerate() {
                if sig.kind == SourceKind::Page && !day.workday {
                    continue;
                }
                let cov = overlap(s, e, sig.start, sig.end.min(plan.until));
                if cov == 0 || (!plan.round_up && cov * 2 < step_secs) {
                    continue;
                }
                let rank = (cov * 2 >= step_secs, sig.kind.priority(), cov, std::cmp::Reverse(sig.start), k);
                if best.as_ref().is_none_or(|b| (b.0, b.1, b.2, b.3) < (rank.0, rank.1, rank.2, rank.3)) {
                    best = Some(rank);
                }
            }
            *a = best.map(|b| b.4);
        }
        // Bridge small free holes between two blocks of the same group.
        let max_hole = (plan.bridge_minutes / plan.step).max(1) as usize;
        let mut i = 0;
        while i < n {
            let Some(k) = assign[i] else {
                i += 1;
                continue;
            };
            let mut j = i + 1;
            while j < n && assign[j].is_none() && !blocked[j] {
                j += 1;
            }
            let hole = j - i - 1;
            if hole > 0
                && hole <= max_hole
                && j < n
                && assign[j].is_some_and(|m| signals[m].group() == signals[k].group())
            {
                for a in &mut assign[i + 1..j] {
                    *a = Some(k);
                }
            }
            i = j.max(i + 1);
        }
        // Cap at the target: the weakest signals give up their latest slots first.
        let allowed = if day.workday && plan.target_minutes > 0 {
            Some((plan.target_minutes - day.booked_minutes).max(0))
        } else {
            None
        };
        let mut capped = 0;
        if let Some(allowed) = allowed {
            let mut taken: Vec<usize> = (0..n).filter(|&i| assign[i].is_some()).collect();
            let over = taken.len() as i64 * plan.step - allowed;
            if over > 0 {
                taken.sort_by_key(|&i| {
                    let s = &signals[assign[i].unwrap_or_default()];
                    (s.kind.priority(), s.confidence(), std::cmp::Reverse(i))
                });
                let drop = ((over + plan.step - 1) / plan.step) as usize;
                for &i in taken.iter().take(drop) {
                    assign[i] = None;
                }
                capped = drop as i64 * plan.step;
            }
        }
        // Runs of the same group become proposals.
        let mut day_minutes = 0;
        let mut i = 0;
        while i < n {
            let Some(k) = assign[i] else {
                i += 1;
                continue;
            };
            let group = signals[k].group();
            let mut j = i;
            let mut members: Vec<(usize, i64)> = vec![];
            while j < n && assign[j].is_some_and(|m| signals[m].group() == group) {
                let m = assign[j].unwrap_or(k);
                match members.iter_mut().find(|(x, _)| *x == m) {
                    Some((_, c)) => *c += 1,
                    None => members.push((m, 1)),
                }
                j += 1;
            }
            let minutes = (j - i) as i64 * plan.step;
            day_minutes += minutes;
            proposals.push(proposal(day.date, slot(i).0, minutes, &group, &members, signals));
            i = j;
        }
        let started = day.from < plan.until;
        let target = if day.workday { plan.target_minutes } else { 0 };
        summaries.push(DaySummary {
            date: day.date,
            workday: day.workday,
            target_minutes: target,
            booked_minutes: day.booked_minutes,
            proposed_minutes: day_minutes,
            gap_minutes: if started { (target - day.booked_minutes - day_minutes).max(0) } else { 0 },
            capped_minutes: capped,
            started,
        });
    }
    (proposals, summaries)
}

/// One proposal from the signals of a run (`members`: signal and its slots, in order).
fn proposal(
    date: NaiveDate,
    start: DateTime<Utc>,
    minutes: i64,
    group: &str,
    members: &[(usize, i64)],
    signals: &[Signal],
) -> Proposal {
    let mut texts: Vec<&str> = vec![];
    let mut sources: Vec<SourceRef> = vec![];
    for &(m, _) in members {
        let s = &signals[m];
        if !texts.iter().any(|t| t.eq_ignore_ascii_case(&s.text)) {
            texts.push(&s.text);
        }
        if !sources.contains(&s.source) {
            sources.push(s.source.clone());
        }
    }
    let text = if texts.len() > 3 { format!("{} …", texts[..3].join("; ")) } else { texts.join("; ") };
    let main = members.iter().max_by_key(|&&(m, c)| (c, std::cmp::Reverse(m))).map_or(0, |&(m, _)| m);
    // The most confident reason explains the WBS.
    let best = members
        .iter()
        .map(|&(m, _)| &signals[m])
        .max_by_key(|s| (s.confidence(), s.kind.priority()))
        .unwrap_or(&signals[main]);
    let wbs = best.wbs.clone();
    Proposal {
        id: format!("{}|{group}", ts(start)),
        date,
        start,
        minutes,
        text,
        kind: signals[main].kind,
        confidence: wbs.as_ref().map_or(Confidence::None, |w| w.confidence),
        reason: wbs.as_ref().map_or_else(|| "Kein passender Vorgang gefunden".to_owned(), |w| w.reason.clone()),
        wbs,
        sources,
    }
}

// ------------------------------------------------------------------ signals

/// Estimated editing time per save (autosave), and the bounds of one hour's session.
const MINUTES_PER_SAVE: i64 = 2;
const MIN_EDIT_MINUTES: i64 = 10;
const MAX_EDIT_MINUTES: i64 = 60;
/// A single save changing fewer characters is no work session (a checkbox, a typo).
const MIN_EDIT_CHARS: i64 = 20;

/// Lower case with single spaces (memory keys, text comparison).
pub fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// The stretch of one activity row (page edits of one UTC hour): see the module documentation.
fn edit_block(kind: &str, at: DateTime<Utc>, count: i64) -> (DateTime<Utc>, DateTime<Utc>) {
    let hour = at - Duration::seconds(at.timestamp().rem_euclid(3600));
    let est = Duration::minutes((count * MINUTES_PER_SAVE).clamp(MIN_EDIT_MINUTES, MAX_EDIT_MINUTES));
    let min = Duration::minutes(MIN_EDIT_MINUTES);
    if kind == "page_created" {
        // A created page keeps its creation time; the edits of the hour follow it.
        (at, (at + est).min(hour + Duration::hours(1)).max(at + min))
    } else {
        // The session ends with the last save of the hour.
        let start = (at - est).max(hour);
        (start, at.max(start + min))
    }
}

/// Whether an appointment still needs booking (the calendar view's „Termine übernehmen“ rules).
fn bookable(e: &CalendarEvent) -> bool {
    let done = e.event.all_day || e.skip || e.entry_id.is_some();
    let not_work =
        matches!(e.event.busy, Busy::Free | Busy::Oof) || (e.event.private && e.event.title == PRIVATE_TITLE);
    !done && !not_work && e.event.end > e.event.start
}

/// The signals of `from..to` with their WBS, and the existing bookings (busy intervals and
/// booked minutes per local day).
pub struct Collected {
    pub signals: Vec<Signal>,
    pub busy: Vec<(DateTime<Utc>, DateTime<Utc>)>,
    pub booked: HashMap<NaiveDate, i64>,
}

/// Reads the signals of `from..to` (see the module documentation) and resolves their WBS.
pub fn collect(
    db: &Database,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    now: DateTime<Utc>,
    zone: &Zone,
    sources: Option<&[String]>,
) -> Result<Collected> {
    let ctx = WbsContext::load(db, now, zone)?;
    // Existing bookings: every entry touching the range (a running timer until now).
    let entries = db.list_time_entries(&EntryFilter {
        from: Some(from - Duration::days(1)),
        to: Some(to),
        ..Default::default()
    })?;
    let mut busy = vec![];
    let mut booked: HashMap<NaiveDate, i64> = HashMap::new();
    for r in &entries {
        let e = &r.entry;
        let end = match e.status_flag {
            StatusFlag::Running => now,
            _ => e.end_time.unwrap_or(e.start_time + Duration::minutes(e.duration_minutes.unwrap_or(0))),
        };
        busy.push((e.start_time, end.max(e.start_time + Duration::minutes(e.duration_minutes.unwrap_or(0)))));
        if e.status_flag != StatusFlag::Running && e.start_time >= from {
            *booked.entry(zone.to_wall(e.start_time).date()).or_default() += e.duration_minutes.unwrap_or(0);
        }
    }
    let mut signals = vec![];

    // Appointments.
    let events = match sources {
        Some(s) => db.calendar_events(from, to, s)?,
        None => {
            let all: Vec<String> = {
                let mut st = db.conn().prepare_cached("SELECT DISTINCT source FROM calendar_events")?;
                st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
            };
            db.calendar_events(from, to, &all)?
        }
    };
    for e in events.iter().filter(|e| bookable(e)) {
        // Booked by hand: an entry of that day described like the subject.
        let day = zone.to_wall(e.event.start).date();
        let title = norm(&e.event.title);
        let by_hand = entries.iter().any(|r| {
            let d = norm(&r.entry.description);
            r.entry.status_flag != StatusFlag::Running
                && zone.to_wall(r.entry.start_time).date() == day
                && !d.is_empty()
                && (d == title || d.contains(&title) || title.contains(&d))
        });
        if by_hand {
            continue;
        }
        let source = SourceRef { kind: SourceKind::Calendar, id: e.key.clone(), label: e.event.title.clone() };
        signals.push(Signal {
            kind: SourceKind::Calendar,
            start: e.event.start,
            end: e.event.end,
            text: e.event.title.clone(),
            wbs: ctx.for_event(db, e)?,
            source,
        });
    }

    // Focus sessions that booked nothing.
    {
        let mut st = db.conn().prepare_cached(
            "SELECT id, netzplan_id, vorgang_nr, goal, started_at, ended_at, worked_minutes FROM focus_sessions
             WHERE status IN ('done', 'aborted') AND entry_id IS NULL AND worked_minutes >= 1
               AND started_at < ?2 AND COALESCE(ended_at, started_at) > ?1
             ORDER BY started_at",
        )?;
        let rows = st.query_map(params![ts(from), ts(to)], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?;
        for row in rows {
            let (id, np, vorgang, goal, started, ended, worked) = row?;
            let start = parse_ts(&started)?;
            let end = match ended {
                Some(e) => parse_ts(&e)?,
                None => start + Duration::minutes(worked),
            };
            let text =
                if goal.trim().is_empty() { crate::focus::DEFAULT_GOAL.to_owned() } else { goal.trim().to_owned() };
            let wbs = ctx.for_focus(db, np, vorgang.as_deref(), &text)?;
            signals.push(Signal {
                kind: SourceKind::Focus,
                start,
                end,
                source: SourceRef { kind: SourceKind::Focus, id: id.to_string(), label: text.clone() },
                text,
                wbs,
            });
        }
    }

    // Page editing sessions.
    {
        let mut st = db.conn().prepare_cached(
            "SELECT a.kind, a.at, a.count, a.amount, p.id, p.title FROM activity a JOIN pages p ON p.id = a.page_id
             WHERE a.kind IN ('page_edited', 'page_created') AND a.at >= ?1 AND a.at < ?2
               AND p.deleted_at IS NULL AND p.daily_date IS NULL
             ORDER BY a.at",
        )?;
        let rows = st.query_map(params![ts(from - Duration::hours(1)), ts(to)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        let mut guesses: HashMap<i64, Option<WbsGuess>> = HashMap::new();
        for row in rows {
            let (kind, at, count, amount, page_id, title) = row?;
            if count <= 1 && (kind == "page_created" || amount < MIN_EDIT_CHARS) {
                continue;
            }
            let (start, end) = edit_block(&kind, parse_ts(&at)?, count);
            let wbs = match guesses.get(&page_id) {
                Some(g) => g.clone(),
                None => {
                    let g = ctx.for_page(db, page_id)?;
                    guesses.insert(page_id, g.clone());
                    g
                }
            };
            signals.push(Signal {
                kind: SourceKind::Page,
                start,
                end,
                text: title.clone(),
                source: SourceRef { kind: SourceKind::Page, id: page_id.to_string(), label: title },
                wbs,
            });
        }
    }
    Ok(Collected { signals, busy, booked })
}

/// The proposal for the local week starting at `week_start` (7 days).
pub fn propose(
    db: &Database,
    week_start: NaiveDate,
    now: DateTime<Utc>,
    zone: &Zone,
    opts: &ProposeOptions,
) -> Result<WeekProposal> {
    let settings = db.load_settings().unwrap_or_default();
    let midnight = |d: NaiveDate| zone.to_utc(d.and_time(NaiveTime::MIN));
    let dates: Vec<NaiveDate> = (0..7).map(|i| week_start + chrono::Days::new(i)).collect();
    let from = midnight(week_start);
    let to = midnight(week_start + chrono::Days::new(7));
    let today = zone.to_wall(now).date();
    let until = if opts.rest_of_today { midnight(today + chrono::Days::new(1)).max(now) } else { now };
    let c = collect(db, from, to, now, zone, opts.sources.as_deref())?;
    let days: Vec<Day> = dates
        .iter()
        .map(|&d| Day {
            date: d,
            from: midnight(d),
            to: midnight(d + chrono::Days::new(1)),
            workday: settings.workdays.contains(&d.weekday().number_from_monday()),
            booked_minutes: c.booked.get(&d).copied().unwrap_or(0),
        })
        .collect();
    // With the rest of today only today's appointments may lie ahead.
    let signals: Vec<Signal> = c
        .signals
        .into_iter()
        .filter(|s| {
            s.start < now
                || (opts.rest_of_today && s.kind == SourceKind::Calendar && zone.to_wall(s.start).date() == today)
        })
        .collect();
    let plan = Plan::from_settings(&settings, until);
    let (proposals, days) = build(&days, &signals, &c.busy, &plan);
    Ok(WeekProposal { week_start, days, proposals, until, step_minutes: plan.step })
}

// ---------------------------------------------------------------------- WBS

/// A bookable reference with the words it is known by.
#[derive(Debug, Clone)]
struct Target {
    netzplan_id: i64,
    vorgang_nr: Option<String>,
    reference: String,
    title: String,
    /// Words of the Vorgang (or Netzplan) description.
    title_words: Vec<String>,
    /// Words of the Netzplan, project and recent booking texts.
    context_words: Vec<String>,
    /// Leistungsarten booked on it, most used first.
    leistungsarten: Vec<String>,
}

/// Netzplan, Vorgang, Leistungsart and a text (link property or booking start) of a match.
type Hit = (i64, Option<String>, Option<String>, String);

/// What the WBS resolution needs from the database, read once per proposal.
pub struct WbsContext {
    targets: Vec<Target>,
    /// Netzplan id → number.
    netzplaene: HashMap<i64, String>,
    /// Existing Leistungsarten.
    las: HashSet<String>,
    time: crate::prefs::TimePrefs,
    zone: Zone,
}

const STOP_WORDS: &[&str] = &[
    "und",
    "oder",
    "der",
    "die",
    "das",
    "den",
    "dem",
    "des",
    "ein",
    "eine",
    "einer",
    "mit",
    "für",
    "von",
    "vom",
    "zum",
    "zur",
    "auf",
    "bei",
    "aus",
    "nach",
    "über",
    "the",
    "and",
    "for",
    "with",
    "neu",
    "neue",
    "termin",
    "besprechung",
    "meeting",
    "call",
    "notiz",
    "notizen",
];

/// Lower-case words of at least three letters, without stop words.
pub fn words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for w in text.split(|c: char| !c.is_alphanumeric()).map(str::to_lowercase) {
        if w.chars().count() >= 3
            && !w.chars().all(|c| c.is_ascii_digit())
            && !STOP_WORDS.contains(&w.as_str())
            && !out.contains(&w)
        {
            out.push(w);
        }
    }
    out
}

/// Two words match when equal or when one begins with the other (at least five letters:
/// „Integration“ – „Integrationstest“).
fn word_match(a: &str, b: &str) -> bool {
    a == b || (a.chars().count().min(b.chars().count()) >= 5 && (a.starts_with(b) || b.starts_with(a)))
}

/// Similarity of `text` to a target: 2 per word shared with its name, 1 per word shared with
/// its context (each word of the text counts once).
fn similarity(text: &[String], t: &Target) -> u32 {
    text.iter()
        .map(|w| {
            if t.title_words.iter().any(|x| word_match(w, x)) {
                2
            } else if t.context_words.iter().any(|x| word_match(w, x)) {
                1
            } else {
                0
            }
        })
        .sum()
}

/// Monday of the week of `d`.
fn monday(d: NaiveDate) -> NaiveDate {
    d - chrono::Days::new(d.weekday().num_days_from_monday() as u64)
}

impl WbsContext {
    pub fn load(db: &Database, now: DateTime<Utc>, zone: &Zone) -> Result<WbsContext> {
        let netzplaene: HashMap<i64, String> =
            db.list_netzplaene(None)?.into_iter().map(|n| (n.id, n.netzplan_nr)).collect();
        let by_nr: HashMap<String, i64> = netzplaene.iter().map(|(id, nr)| (nr.to_lowercase(), *id)).collect();
        let targets = crate::ai::zeitguess::candidates(db, now)?
            .into_iter()
            .filter_map(|c| {
                let (np, v) = match c.reference.split_once('/') {
                    Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
                    None => (c.reference.clone(), None),
                };
                let netzplan_id = *by_nr.get(&np.to_lowercase())?;
                let mut context = words(&c.context);
                for r in &c.recent {
                    context.extend(words(r));
                }
                Some(Target {
                    netzplan_id,
                    vorgang_nr: v,
                    title_words: words(&c.title),
                    title: c.title,
                    context_words: context,
                    leistungsarten: c.leistungsarten,
                    reference: c.reference,
                })
            })
            .collect();
        let las = db.list_leistungsarten()?.into_iter().map(|(code, _)| code).collect();
        let time = db.load_settings().map(|s| s.time).unwrap_or_default();
        Ok(WbsContext { targets, netzplaene, las, time, zone: zone.clone() })
    }

    /// `24.09.` in local time.
    fn day(&self, t: DateTime<Utc>) -> String {
        self.zone.to_wall(t).format("%d.%m.").to_string()
    }

    fn reference(&self, netzplan_id: i64, vorgang: Option<&str>) -> Option<String> {
        let nr = self.netzplaene.get(&netzplan_id)?;
        Some(crate::desktop::timer_label(nr, vorgang))
    }

    /// The Leistungsart for a booking: the one given (if it exists), the Netzplan's default,
    /// or the one most booked on the reference.
    fn leistungsart(&self, netzplan_id: i64, vorgang: Option<&str>, given: Option<String>) -> Option<String> {
        if let Some(la) = given.filter(|l| self.las.contains(l)) {
            return Some(la);
        }
        let nr = self.netzplaene.get(&netzplan_id)?;
        if let Some(la) = self.time.default_la_for(nr).filter(|l| self.las.contains(*l)) {
            return Some(la.to_owned());
        }
        let reference = crate::desktop::timer_label(nr, vorgang).to_lowercase();
        self.targets
            .iter()
            .find(|t| t.reference.to_lowercase() == reference)
            .and_then(|t| t.leistungsarten.first().cloned())
    }

    fn guess(
        &self,
        netzplan_id: i64,
        vorgang: Option<String>,
        la: Option<String>,
        confidence: Confidence,
        basis: Basis,
        reason: impl FnOnce(&str) -> String,
    ) -> Option<WbsGuess> {
        let vorgang = vorgang.filter(|v| !v.is_empty());
        let reference = self.reference(netzplan_id, vorgang.as_deref())?;
        Some(WbsGuess {
            leistungsart: self.leistungsart(netzplan_id, vorgang.as_deref(), la),
            reason: reason(&reference),
            netzplan_id,
            vorgang_nr: vorgang,
            reference,
            confidence,
            basis,
        })
    }

    /// A reference like `NP-8801/1020` (or a WBS element) resolved.
    fn resolve_ref(&self, db: &Database, reference: &str) -> Option<(i64, Option<String>)> {
        let (np, v) = match reference.split_once('/') {
            Some((n, v)) => (n.trim(), Some(v.trim()).filter(|v| !v.is_empty())),
            None => (reference.trim(), None),
        };
        let n = db.netzplan_by_ref(np).ok()?;
        let vorgang = match v {
            None => None,
            Some(v) => {
                let list = db.list_vorgaenge(n.id).ok()?;
                match list.iter().find(|x| x.vorgang_nr.eq_ignore_ascii_case(v)) {
                    Some(found) => Some(found.vorgang_nr.clone()),
                    None if list.is_empty() => Some(v.to_owned()),
                    None => return None,
                }
            }
        };
        Some((n.id, vorgang))
    }

    /// Remembered for a text (`kind = 'text'`).
    fn memory(&self, db: &Database, kind: &str, key: &str) -> Result<Option<Hit>> {
        Ok(db
            .conn()
            .query_row(
                "SELECT netzplan_id, vorgang_nr, leistungsart, link_ref FROM wbs_memory WHERE kind = ?1 AND key = ?2",
                params![kind, key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?)
    }

    fn text_memory(&self, db: &Database, text: &str) -> Result<Option<WbsGuess>> {
        let key = norm(text);
        if key.is_empty() {
            return Ok(None);
        }
        Ok(self.memory(db, "text", &key)?.and_then(|(np, v, la, _)| {
            self.guess(np, v, la, Confidence::High, Basis::Learned, |r| {
                format!("gelernt: „{text}“ zuletzt auf {r} übernommen")
            })
        }))
    }

    /// The newest finished entry described like `text`.
    fn by_description(&self, db: &Database, text: &str) -> Result<Option<WbsGuess>> {
        if text.trim().is_empty() {
            return Ok(None);
        }
        let hit: Option<Hit> = db
            .conn()
            .query_row(
                "SELECT netzplan_id, vorgang_nr, leistungsart, start_time FROM time_entries
                 WHERE description = ?1 COLLATE NOCASE AND status_flag <> 'running' ORDER BY start_time DESC LIMIT 1",
                [text.trim()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        Ok(hit.and_then(|(np, v, la, at)| {
            let when = parse_ts(&at).map(|t| self.day(t)).unwrap_or_default();
            self.guess(np, v, la, Confidence::Medium, Basis::History, |r| {
                format!("am {when} „{}“ auf {r} gebucht", text.trim())
            })
        }))
    }

    /// The target the text resembles most, when one stands out.
    fn similar(&self, text: &str) -> Option<WbsGuess> {
        let w = words(text);
        if w.is_empty() {
            return None;
        }
        let mut scored: Vec<(u32, &Target)> =
            self.targets.iter().map(|t| (similarity(&w, t), t)).filter(|(s, _)| *s >= 2).collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0));
        match scored.as_slice() {
            [(best, t), rest @ ..] if rest.first().is_none_or(|(s, _)| s < best) => {
                let title = t.title.clone();
                self.guess(t.netzplan_id, t.vorgang_nr.clone(), None, Confidence::Low, Basis::Similar, |r| {
                    format!("ähnlich wie „{title}“ ({r})")
                })
            }
            _ => None,
        }
    }

    /// An appointment: booked series or subject, remembered text, the meeting note's
    /// `vorgang:`, an entry described like it, similarity.
    pub fn for_event(&self, db: &Database, e: &CalendarEvent) -> Result<Option<WbsGuess>> {
        let memory = db.calendar_wbs_memory(e)?;
        let title = e.event.title.as_str();
        if let Some(m) = &memory
            && m.basis != HintBasis::Description
        {
            let (this, then) = (self.zone.to_wall(e.event.start).date(), self.zone.to_wall(m.booked_at).date());
            let when = if monday(this) - monday(then) == Duration::days(7) {
                "wie letzte Woche".to_owned()
            } else {
                format!("wie am {}", self.day(m.booked_at))
            };
            let label = if m.basis == HintBasis::Series { format!("{when} (Serie)") } else { when };
            let h = m.hint.clone();
            return Ok(self.guess(
                h.netzplan_id,
                h.vorgang_nr,
                h.leistungsart,
                Confidence::High,
                Basis::Learned,
                |_| format!("{label}: {title}"),
            ));
        }
        if let Some(g) = self.text_memory(db, title)? {
            return Ok(Some(g));
        }
        if let Some(page) = e.note_page_id
            && let Some(reference) = db.page_reference(page)?
            && let Some((np, v)) = self.resolve_ref(db, &reference)
        {
            let note = db.page(page)?.title;
            return Ok(self.guess(np, v, None, Confidence::High, Basis::Link, |r| {
                format!("Besprechungsnotiz „{note}“ gehört zu {r}")
            }));
        }
        if let Some(m) = memory {
            let when = self.day(m.booked_at);
            let h = m.hint;
            return Ok(self.guess(
                h.netzplan_id,
                h.vorgang_nr,
                h.leistungsart,
                Confidence::Medium,
                Basis::History,
                |r| format!("am {when} „{}“ auf {r} gebucht", m.description),
            ));
        }
        Ok(self.similar(title))
    }

    /// A focus session: its Vorgang, a remembered goal, an entry described like it, similarity.
    pub fn for_focus(
        &self,
        db: &Database,
        np: Option<i64>,
        vorgang: Option<&str>,
        goal: &str,
    ) -> Result<Option<WbsGuess>> {
        if let Some(np) = np {
            return Ok(self.guess(np, vorgang.map(str::to_owned), None, Confidence::High, Basis::Link, |r| {
                format!("Fokus-Sitzung auf {r}")
            }));
        }
        if let Some(g) = self.text_memory(db, goal)? {
            return Ok(Some(g));
        }
        if goal != crate::focus::DEFAULT_GOAL
            && let Some(g) = self.by_description(db, goal)?
        {
            return Ok(Some(g));
        }
        Ok(if goal == crate::focus::DEFAULT_GOAL { None } else { self.similar(goal) })
    }

    /// A page: remembered for the page, its `vorgang:`, a parent's, a WBS it mentions (text or
    /// tag), booked from it before or like its title, similarity of the title.
    pub fn for_page(&self, db: &Database, page_id: i64) -> Result<Option<WbsGuess>> {
        let (title, content, mut parent): (String, String, Option<i64>) =
            db.conn().query_row("SELECT title, content, parent_id FROM pages WHERE id = ?1", [page_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
        let own = crate::pagework::page_reference(&content);
        if let Some((np, v, la, link_ref)) = self.memory(db, "page", &page_id.to_string())?
            && link_ref == own.clone().unwrap_or_default()
            && let Some(g) = self.guess(np, v, la, Confidence::High, Basis::Learned, |r| {
                format!("gelernt: Seite „{title}“ zuletzt auf {r} übernommen")
            })
        {
            return Ok(Some(g));
        }
        if let Some(reference) = &own
            && let Some((np, v)) = self.resolve_ref(db, reference)
        {
            return Ok(
                self.guess(np, v, None, Confidence::High, Basis::Link, |r| format!("Seite „{title}“ gehört zu {r}"))
            );
        }
        // Parent pages (a project page with `vorgang:`), nearest first.
        let mut seen = HashSet::new();
        while let Some(p) = parent {
            if !seen.insert(p) {
                break;
            }
            let (ptitle, pcontent, next): (String, String, Option<i64>) =
                db.conn().query_row("SELECT title, content, parent_id FROM pages WHERE id = ?1", [p], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
            if let Some(reference) = crate::pagework::page_reference(&pcontent)
                && let Some((np, v)) = self.resolve_ref(db, &reference)
            {
                return Ok(self.guess(np, v, None, Confidence::Medium, Basis::Link, |r| {
                    format!("Seite „{title}“ liegt unter „{ptitle}“ ({r})")
                }));
            }
            parent = next;
        }
        if let Some(g) = self.mentioned(db, page_id, &title, &content)? {
            return Ok(Some(g));
        }
        let hit: Option<Hit> = db
            .conn()
            .query_row(
                "SELECT netzplan_id, vorgang_nr, leistungsart, start_time FROM time_entries
                 WHERE page_id = ?1 AND status_flag <> 'running' ORDER BY start_time DESC LIMIT 1",
                [page_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((np, v, la, at)) = hit {
            let when = parse_ts(&at).map(|t| self.day(t)).unwrap_or_default();
            return Ok(self.guess(np, v, la, Confidence::Medium, Basis::History, |r| {
                format!("am {when} von „{title}“ auf {r} gebucht")
            }));
        }
        if let Some(g) = self.by_description(db, &title)? {
            return Ok(Some(g));
        }
        Ok(self.similar(&title))
    }

    /// The WBS a page mentions most (`NP-8801/1020` in its text, `#np-8801` as tag).
    fn mentioned(&self, db: &Database, page_id: i64, title: &str, content: &str) -> Result<Option<WbsGuess>> {
        let text = content.to_lowercase();
        let tags: HashSet<String> = {
            let mut st = db.conn().prepare_cached("SELECT tag FROM page_tags WHERE page_id = ?1")?;
            st.query_map([page_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?
        };
        let count = |needle: &str| -> usize {
            text.match_indices(needle)
                .filter(|(i, _)| {
                    let before = text[..*i].chars().next_back();
                    let after = text[i + needle.len()..].chars().next();
                    !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
                })
                .count()
        };
        let mut best: Option<(usize, bool, i64, Option<String>)> = None;
        for t in &self.targets {
            let nr = self.netzplaene.get(&t.netzplan_id).map(|n| n.to_lowercase()).unwrap_or_default();
            let (n, specific) = match &t.vorgang_nr {
                Some(v) => (count(&format!("{nr}/{}", v.to_lowercase())), true),
                None => (count(&nr) + usize::from(tags.contains(&nr)), false),
            };
            if n > 0 && best.as_ref().is_none_or(|b| (n, specific) > (b.0, b.1)) {
                best = Some((n, specific, t.netzplan_id, t.vorgang_nr.clone()));
            }
        }
        // A Netzplan named without Vorgang (text or tag), when its Vorgänge are not named.
        if best.is_none() {
            for (id, nr) in &self.netzplaene {
                let nr = nr.to_lowercase();
                let n = count(&nr) + usize::from(tags.contains(&nr));
                if n > 0 && best.as_ref().is_none_or(|b| n > b.0) {
                    best = Some((n, false, *id, None));
                }
            }
        }
        Ok(best.and_then(|(_, _, np, v)| {
            self.guess(np, v, None, Confidence::Medium, Basis::Link, |r| format!("Seite „{title}“ erwähnt {r}"))
        }))
    }
}

// --------------------------------------------------------------------- apply

/// A proposal the user takes over (possibly edited).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Accepted {
    pub start: DateTime<Utc>,
    pub minutes: i64,
    pub text: String,
    pub netzplan_id: i64,
    #[serde(default)]
    pub vorgang_nr: Option<String>,
    #[serde(default)]
    pub leistungsart: Option<String>,
    #[serde(default)]
    pub sources: Vec<SourceRef>,
    /// The user chose another WBS than proposed (or one where none was): remembered for the
    /// pages and the text of the proposal.
    #[serde(default)]
    pub wbs_changed: bool,
    /// The proposal's text before editing (the key the choice is remembered under).
    #[serde(default)]
    pub original_text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Applied {
    pub entry_ids: Vec<i64>,
    /// Budget alerts of the Vorgänge booked on.
    pub alerts: Vec<BudgetStatus>,
}

/// Remembers the WBS chosen for a page or a text (see migration v10).
#[allow(clippy::too_many_arguments)]
pub fn remember(
    db: &Database,
    kind: &str,
    key: &str,
    page_id: Option<i64>,
    netzplan_id: i64,
    vorgang: Option<&str>,
    la: Option<&str>,
    now: DateTime<Utc>,
) -> Result<()> {
    let link_ref = match page_id {
        Some(id) => db.page_reference(id)?.unwrap_or_default(),
        None => String::new(),
    };
    db.conn().execute(
        "INSERT INTO wbs_memory (kind, key, page_id, netzplan_id, vorgang_nr, leistungsart, link_ref, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(kind, key) DO UPDATE SET page_id = ?3, netzplan_id = ?4, vorgang_nr = ?5, leistungsart = ?6,
                link_ref = ?7, updated_at = ?8",
        params![kind, key, page_id, netzplan_id, vorgang, la, link_ref, ts(now)],
    )?;
    Ok(())
}

/// Books the accepted proposals as draft entries in one transaction: links the appointments
/// (booked mark, series and subject for next time) and the focus sessions, and remembers a
/// changed WBS for the pages and texts. All or nothing.
pub fn apply(db: &Database, items: &[Accepted], now: DateTime<Utc>, thresholds: &Thresholds) -> Result<Applied> {
    if items.is_empty() {
        return Ok(Applied { entry_ids: vec![], alerts: vec![] });
    }
    let time = db.load_settings().map(|s| s.time).unwrap_or_default();
    let ids = db.atomic(|| {
        let mut ids = vec![];
        for (n, it) in items.iter().enumerate() {
            let what = || format!("Vorschlag {} („{}“)", n + 1, it.text.trim());
            if !(1..=24 * 60).contains(&it.minutes) {
                return Err(Error::State(format!(
                    "{}: Die Dauer muss zwischen 1 Minute und 24 Stunden liegen",
                    what()
                )));
            }
            let np = db.netzplan_by_id(it.netzplan_id)?;
            // The canonical spelling of the Vorgang (a Netzplan without Vorgänge takes any).
            let vorgang = match it.vorgang_nr.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                None => None,
                Some(v) => {
                    let list = db.list_vorgaenge(np.id)?;
                    match list.iter().find(|x| x.vorgang_nr.eq_ignore_ascii_case(v)) {
                        Some(found) => Some(found.vorgang_nr.clone()),
                        None if list.is_empty() => Some(v.to_owned()),
                        None => return Err(Error::not_found("vorgang", format!("{}/{v}", np.netzplan_nr))),
                    }
                }
            };
            let la = match it.leistungsart.as_deref().filter(|l| !l.is_empty()) {
                Some(l) if db.leistungsart_exists(l)? => Some(l.to_owned()),
                Some(l) => return Err(Error::not_found("leistungsart", l.to_owned())),
                None => time
                    .default_la_for(&np.netzplan_nr)
                    .filter(|l| db.leistungsart_exists(l).unwrap_or(false))
                    .map(str::to_owned),
            };
            let page_id = it.sources.iter().find(|s| s.kind == SourceKind::Page).and_then(|s| s.id.parse::<i64>().ok());
            let page_id = match page_id {
                Some(id) => db.conn().query_row("SELECT id FROM pages WHERE id = ?1", [id], |r| r.get(0)).optional()?,
                None => None,
            };
            let entry = db.insert_time_entry(&NewTimeEntry {
                netzplan_id: np.id,
                vorgang_nr: vorgang.clone(),
                leistungsart: la.clone(),
                start_time: it.start,
                duration_minutes: time.rounding.apply(it.minutes),
                description: it.text.trim().to_owned(),
                source: EntrySource::Auto,
                page_id,
            })?;
            for s in &it.sources {
                match s.kind {
                    // An appointment gone from the calendar since is simply not linked.
                    SourceKind::Calendar => {
                        if db.calendar_event(&s.id).is_ok() {
                            db.calendar_link_entry(&s.id, entry.id)?;
                        }
                    }
                    SourceKind::Focus => {
                        db.conn().execute(
                            "UPDATE focus_sessions SET entry_id = ?2, booked_minutes = worked_minutes
                             WHERE id = ?1 AND entry_id IS NULL AND status <> 'running'",
                            params![s.id.parse::<i64>().unwrap_or(-1), entry.id],
                        )?;
                    }
                    SourceKind::Page => {}
                }
            }
            if it.wbs_changed {
                for s in &it.sources {
                    if s.kind == SourceKind::Page
                        && let Ok(id) = s.id.parse::<i64>()
                        && db
                            .conn()
                            .query_row("SELECT 1 FROM pages WHERE id = ?1", [id], |_| Ok(()))
                            .optional()?
                            .is_some()
                    {
                        remember(db, "page", &id.to_string(), Some(id), np.id, vorgang.as_deref(), la.as_deref(), now)?;
                    }
                }
                let key = norm(if it.original_text.trim().is_empty() { &it.text } else { &it.original_text });
                // Texts of single sources only (a merged text is no subject that comes back).
                if !key.is_empty() && it.sources.len() <= 1 && it.sources.iter().all(|s| s.kind != SourceKind::Page) {
                    remember(db, "text", &key, None, np.id, vorgang.as_deref(), la.as_deref(), now)?;
                }
            }
            ids.push(entry.id);
        }
        Ok(ids)
    })?;
    let mut alerts: Vec<BudgetStatus> = vec![];
    let mut seen = HashSet::new();
    for it in items {
        let key = (it.netzplan_id, it.vorgang_nr.clone().unwrap_or_default().to_lowercase());
        if seen.insert(key) {
            for a in tracking::alerts_for(db, it.netzplan_id, it.vorgang_nr.as_deref(), thresholds)? {
                if !alerts.iter().any(|x| x.label == a.label) {
                    alerts.push(a);
                }
            }
        }
    }
    Ok(Applied { entry_ids: ids, alerts })
}

// ------------------------------------------------------------------ reminder

/// Workdays before today (of today's week, from Monday) booked below the target: (day, missing
/// minutes).
pub fn open_days(db: &Database, now: DateTime<Utc>, zone: &Zone) -> Result<Vec<(NaiveDate, i64)>> {
    let settings = db.load_settings().unwrap_or_default();
    let today = zone.to_wall(now).date();
    let monday = monday(today);
    let target = (settings.daily_target_hours * 60.0).round() as i64;
    let from = zone.to_utc(monday.and_time(NaiveTime::MIN));
    let to = zone.to_utc(today.and_time(NaiveTime::MIN));
    let mut booked: HashMap<NaiveDate, i64> = HashMap::new();
    for r in db.list_time_entries(&EntryFilter { from: Some(from), to: Some(to), ..Default::default() })? {
        if r.entry.status_flag != StatusFlag::Running {
            *booked.entry(zone.to_wall(r.entry.start_time).date()).or_default() +=
                r.entry.duration_minutes.unwrap_or(0);
        }
    }
    let mut out = vec![];
    let mut d = monday;
    while d < today {
        if settings.workdays.contains(&d.weekday().number_from_monday()) {
            let missing = target - booked.get(&d).copied().unwrap_or(0);
            if missing > 0 {
                out.push((d, missing));
            }
        }
        d = d + chrono::Days::new(1);
    }
    Ok(out)
}

/// Time of day from which the reminder is shown on the last workday of the week.
pub const REMINDER_FROM: NaiveTime = match NaiveTime::from_hms_opt(14, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};

/// The ISO week `2026-W39` (the reminder is shown once per week).
pub fn week_key(d: NaiveDate) -> String {
    let w = d.iso_week();
    format!("{}-W{:02}", w.year(), w.week())
}

const WEEKDAYS: [&str; 7] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/// The „Woche vorschlagen“ notification, when one is due: on the last workday of the week from
/// 14:00, once per week, when earlier workdays are below the target (`open`, see [`open_days`]).
pub fn week_reminder(
    now: NaiveDateTime,
    settings: &crate::settings::Settings,
    open: &[(NaiveDate, i64)],
    last_week: Option<&str>,
) -> Option<String> {
    let n = &settings.notifications;
    if !n.week_proposal || n.is_quiet(now.time()) || open.is_empty() || now.time() < REMINDER_FROM {
        return None;
    }
    let today = now.date();
    let last_workday = settings.workdays.iter().copied().filter(|d| (1..=7).contains(d)).max()?;
    if today.weekday().number_from_monday() != last_workday || last_week == Some(week_key(today).as_str()) {
        return None;
    }
    let days: Vec<String> = open
        .iter()
        .map(|(d, m)| {
            format!(
                "{} {} h",
                WEEKDAYS[d.weekday().num_days_from_monday() as usize],
                crate::desktop::format_hours(*m as f64)
            )
        })
        .collect();
    Some(format!("Noch offen: {}. Annalo schlägt die Buchungen aus Terminen, Fokus und Seiten vor.", days.join(", ")))
}

#[cfg(test)]
mod tests;
