//! iCalendar (RFC 5545) files and subscriptions: content lines (folding, parameters, escapes),
//! components, time zones (`TZID` with IANA or Windows names, `VTIMEZONE` rules) and the
//! appointments inside a window, series expanded (`RRULE`, `RDATE`, `EXDATE`, changed and
//! cancelled instances via `RECURRENCE-ID`).
//!
//! Series are expanded in wall-clock time of their zone, so a meeting at 10:00 stays at 10:00
//! across a change to or from daylight saving time; each instance is then placed in UTC.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rrule::{RRule, Unvalidated};

use super::tz::{Zone, ZoneRules};
use super::{Busy, NewEvent, Privacy, instant_id, meeting_link};
use crate::error::{Error, Result};

/// At most this many instances of one series are generated, and this many events kept per file.
const MAX_INSTANCES: u16 = 2000;
const MAX_EVENTS: usize = 20_000;

/// A content line: `NAME;PARAM=value:VALUE`.
#[derive(Debug, Clone, PartialEq)]
pub struct Prop {
    /// Upper case.
    pub name: String,
    /// Names upper case, values without quotes.
    pub params: Vec<(String, String)>,
    /// Raw value (escapes not resolved).
    pub value: String,
}

impl Prop {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Component {
    pub name: String,
    pub props: Vec<Prop>,
    pub children: Vec<Component>,
}

impl Component {
    pub fn prop(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.name == name)
    }
    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Prop> + 'a {
        self.props.iter().filter(move |p| p.name == name)
    }
    /// A text property with its escapes resolved, trimmed.
    pub fn text(&self, name: &str) -> Option<String> {
        self.prop(name).map(|p| unescape(&p.value).trim().to_owned())
    }
}

/// Undoes the line folding (CRLF or LF followed by a space or tab) on the bytes, so a fold
/// inside a multi-byte character (allowed by the RFC: lines are folded at 75 octets) heals.
fn unfold(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let fold = |j: usize| j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t');
        if b == b'\r' && bytes.get(i + 1) == Some(&b'\n') && fold(i + 2) {
            i += 3;
            continue;
        }
        if b == b'\n' && fold(i + 1) {
            i += 2;
            continue;
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One content line; `None` for lines without a `:`.
pub fn parse_line(line: &str) -> Option<Prop> {
    let mut quoted = false;
    let mut colon = None;
    let mut cuts = vec![];
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => cuts.push(i),
            ':' if !quoted => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let head = &line[..colon];
    let mut bounds = vec![0];
    bounds.extend(cuts.iter().map(|c| c + 1));
    let mut parts = vec![];
    for (n, start) in bounds.iter().enumerate() {
        let end = cuts.get(n).copied().unwrap_or(head.len());
        parts.push(&head[*start..end]);
    }
    let name = parts.first()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = parts[1..]
        .iter()
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_owned()))
        })
        .collect();
    Some(Prop { name, params, value: line[colon + 1..].to_owned() })
}

/// The components of a file (usually one `VCALENDAR`), leniently: a missing `END` closes at
/// the end of the file, a stray one closes up to its `BEGIN`.
pub fn parse_components(bytes: &[u8]) -> Vec<Component> {
    let text = unfold(bytes);
    let mut top = vec![];
    let mut stack: Vec<Component> = vec![];
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let Some(p) = parse_line(line) else { continue };
        match p.name.as_str() {
            "BEGIN" => stack.push(Component { name: p.value.trim().to_ascii_uppercase(), ..Default::default() }),
            "END" => {
                let name = p.value.trim().to_ascii_uppercase();
                if !stack.iter().any(|c| c.name == name) {
                    continue;
                }
                while let Some(c) = stack.pop() {
                    let done = c.name == name;
                    match stack.last_mut() {
                        Some(parent) => parent.children.push(c),
                        None => top.push(c),
                    }
                    if done {
                        break;
                    }
                }
            }
            _ => {
                if let Some(c) = stack.last_mut() {
                    c.props.push(p);
                }
            }
        }
    }
    while let Some(c) = stack.pop() {
        match stack.last_mut() {
            Some(parent) => parent.children.push(c),
            None => top.push(c),
        }
    }
    top
}

/// TEXT escapes: `\n`, `\,`, `\;`, `\\`.
pub fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// A list value split at commas that are not escaped.
fn split_list(v: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut esc = false;
    for c in v.chars() {
        if esc {
            cur.push('\\');
            cur.push(c);
            esc = false;
        } else if c == '\\' {
            esc = true;
        } else if c == ',' {
            out.push(unescape(&cur).trim().to_owned());
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    out.push(unescape(&cur).trim().to_owned());
    out.retain(|s| !s.is_empty());
    out
}

/// A date or a date-time with its zone.
#[derive(Debug, Clone)]
enum When {
    Date(NaiveDate),
    Time(NaiveDateTime, Zone),
}

impl When {
    fn utc(&self, default: &Zone) -> DateTime<Utc> {
        match self {
            When::Date(d) => default.to_utc(d.and_hms_opt(0, 0, 0).unwrap()),
            When::Time(w, z) => z.to_utc(*w),
        }
    }
    /// The wall-clock time in `zone`.
    fn wall_in(&self, zone: &Zone) -> NaiveDateTime {
        match self {
            When::Date(d) => d.and_hms_opt(0, 0, 0).unwrap(),
            When::Time(w, z) => zone.to_wall(z.to_utc(*w)),
        }
    }
}

/// Zones of one file: its `VTIMEZONE`s and the zone of floating times.
struct Zones {
    defined: HashMap<String, Zone>,
    default: Zone,
}

impl Zones {
    fn resolve(&self, tzid: &str) -> Zone {
        Zone::named(tzid)
            .or_else(|| self.defined.get(tzid.trim().trim_matches('"')).cloned())
            .unwrap_or_else(|| self.default.clone())
    }
}

fn parse_naive(v: &str) -> Option<NaiveDateTime> {
    let v = v.trim().trim_end_matches(['Z', 'z']);
    NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M"))
        .or_else(|_| NaiveDateTime::parse_from_str(v, "%Y-%m-%dT%H:%M:%S"))
        .ok()
}

fn parse_date(v: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(v.trim(), "%Y%m%d").or_else(|_| NaiveDate::parse_from_str(v.trim(), "%Y-%m-%d")).ok()
}

/// The values of a date property (one, or a comma list for `EXDATE`/`RDATE`).
fn whens(p: &Prop, zones: &Zones) -> Vec<When> {
    let is_date = p.param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
    p.value
        .split(',')
        .filter_map(|v| {
            let v = v.trim();
            if is_date || (v.len() == 8 && !v.contains('T')) {
                return parse_date(v).map(When::Date);
            }
            let wall = parse_naive(v)?;
            let zone = if v.ends_with(['Z', 'z']) {
                Zone::Utc
            } else {
                p.param("TZID").map(|t| zones.resolve(t)).unwrap_or_else(|| zones.default.clone())
            };
            Some(When::Time(wall, zone))
        })
        .collect()
}

fn when(c: &Component, name: &str, zones: &Zones) -> Option<When> {
    c.prop(name).and_then(|p| whens(p, zones).into_iter().next())
}

/// `P1DT2H30M`, `PT15M`, `-PT5M`, `P2W`.
pub fn parse_duration(v: &str) -> Option<Duration> {
    let v = v.trim();
    let (neg, v) = match v.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, v.strip_prefix('+').unwrap_or(v)),
    };
    let v = v.strip_prefix('P')?;
    let mut total = Duration::zero();
    let mut num = String::new();
    let mut in_time = false;
    for c in v.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            _ => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (c, in_time) {
                    ('W', _) => Duration::weeks(n),
                    ('D', _) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    if !num.is_empty() {
        return None;
    }
    Some(if neg { -total } else { total })
}

/// `+0100`, `-0530`, `+010000`.
fn parse_offset(v: &str) -> Option<i32> {
    let v = v.trim();
    let sign = match v.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let d = &v[1..];
    if d.len() < 4 || !d.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let h: i32 = d[..2].parse().ok()?;
    let m: i32 = d[2..4].parse().ok()?;
    let s: i32 = if d.len() >= 6 { d[4..6].parse().ok()? } else { 0 };
    Some(sign * (h * 3600 + m * 60 + s))
}

/// Wall-clock starts of `rule` from `dtstart` inside `from..=to`, expanded as floating time.
/// `until` replaces the rule's UNTIL (already converted to wall-clock time).
fn expand(
    dtstart: NaiveDateTime,
    rule: &str,
    until: Option<NaiveDateTime>,
    from: NaiveDateTime,
    to: NaiveDateTime,
) -> std::result::Result<Vec<NaiveDateTime>, String> {
    let rest: Vec<&str> = rule
        .split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty() && !p.to_ascii_uppercase().starts_with("UNTIL="))
        .collect();
    let floating = |w: NaiveDateTime| rrule::Tz::UTC.from_utc_datetime(&w);
    let mut r: RRule<Unvalidated> =
        format!("RRULE:{}", rest.join(";")).parse().map_err(|e: rrule::RRuleError| e.to_string())?;
    if let Some(u) = until {
        r = r.until(floating(u.max(dtstart)));
    }
    let set = r.build(floating(dtstart)).map_err(|e| e.to_string())?;
    let dates = set.after(floating(from)).before(floating(to)).all(MAX_INSTANCES).dates;
    Ok(dates.into_iter().map(|d| d.naive_utc()).collect())
}

/// The UNTIL of a rule in wall-clock time of `zone`: UTC values are converted, dates end at 23:59:59.
fn rule_until(rule: &str, zone: &Zone) -> Option<NaiveDateTime> {
    let v = rule.split(';').find_map(|p| {
        let (k, v) = p.split_once('=')?;
        k.trim().eq_ignore_ascii_case("UNTIL").then(|| v.trim().to_owned())
    })?;
    if v.len() == 8 {
        return parse_date(&v).and_then(|d| d.and_hms_opt(23, 59, 59));
    }
    let wall = parse_naive(&v)?;
    Some(if v.ends_with(['Z', 'z']) { zone.to_wall(Utc.from_utc_datetime(&wall)) } else { wall })
}

/// The rules of a `VTIMEZONE` (transitions from 1970 to 2100).
fn zone_rules(c: &Component) -> Option<ZoneRules> {
    let mut transitions = vec![];
    let mut initial = None;
    for part in c.children.iter().filter(|p| p.name == "STANDARD" || p.name == "DAYLIGHT") {
        let (Some(from), Some(to)) = (
            part.prop("TZOFFSETFROM").and_then(|p| parse_offset(&p.value)),
            part.prop("TZOFFSETTO").and_then(|p| parse_offset(&p.value)),
        ) else {
            continue;
        };
        let Some(start) = part.prop("DTSTART").and_then(|p| parse_naive(&p.value)) else { continue };
        if part.name == "STANDARD" && initial.is_none() {
            initial = Some(to);
        }
        let mut walls = vec![start];
        if let Some(rule) = part.prop("RRULE").map(|p| p.value.clone()) {
            // Outlook starts its rules in 1601: begin in 1970 to keep the expansion short.
            let begin = if start.year() < 1970 {
                NaiveDate::from_ymd_opt(1970, start.month(), start.day().min(28)).unwrap().and_time(start.time())
            } else {
                start
            };
            let until = rule_until(
                &rule,
                &Zone::Fixed(chrono::FixedOffset::east_opt(from).unwrap_or(chrono::FixedOffset::east_opt(0).unwrap())),
            );
            let end = NaiveDate::from_ymd_opt(2100, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
            if until.is_none_or(|u| u >= begin)
                && let Ok(more) = expand(begin, &rule, until, begin, end)
            {
                walls.extend(more);
            }
        }
        for rd in part.all("RDATE") {
            walls.extend(rd.value.split(',').filter_map(parse_naive));
        }
        for w in walls {
            transitions.push((Utc.from_utc_datetime(&(w - Duration::seconds(from as i64))), to));
        }
    }
    if transitions.is_empty() {
        return None;
    }
    transitions.sort_by_key(|(t, _)| *t);
    transitions.dedup_by_key(|(t, _)| *t);
    let initial = initial.unwrap_or(transitions[0].1);
    Some(ZoneRules { transitions, initial })
}

/// What an appointment says, before it is placed in time.
struct Details {
    title: String,
    location: String,
    organizer: String,
    attendees: Vec<String>,
    body: Option<String>,
    link: Option<String>,
    busy: Busy,
    private: bool,
    categories: Vec<String>,
}

fn person(p: &Prop) -> String {
    match p.param("CN").map(str::trim).filter(|s| !s.is_empty()) {
        Some(cn) => cn.to_owned(),
        None => {
            let v = p.value.trim();
            v.strip_prefix("mailto:").or_else(|| v.strip_prefix("MAILTO:")).unwrap_or(v).to_owned()
        }
    }
}

fn details(c: &Component) -> Details {
    let body = c.text("DESCRIPTION").filter(|b| !b.is_empty());
    let location = c.text("LOCATION").unwrap_or_default();
    let mut busy = match c.text("X-MICROSOFT-CDO-BUSYSTATUS").unwrap_or_default().to_ascii_uppercase().as_str() {
        "FREE" => Busy::Free,
        "TENTATIVE" => Busy::Tentative,
        "OOF" => Busy::Oof,
        "WORKINGELSEWHERE" => Busy::Elsewhere,
        "BUSY" => Busy::Busy,
        _ if c.text("TRANSP").is_some_and(|t| t.eq_ignore_ascii_case("TRANSPARENT")) => Busy::Free,
        _ => Busy::Busy,
    };
    if busy == Busy::Busy && c.text("STATUS").is_some_and(|s| s.eq_ignore_ascii_case("TENTATIVE")) {
        busy = Busy::Tentative;
    }
    let mut attendees: Vec<String> = vec![];
    for a in c.all("ATTENDEE") {
        let kind = a.param("CUTYPE").unwrap_or("").to_ascii_uppercase();
        if kind == "RESOURCE" || kind == "ROOM" {
            continue;
        }
        let name = person(a);
        if !name.is_empty() && !attendees.contains(&name) {
            attendees.push(name);
        }
    }
    let url_props: Vec<String> =
        ["X-MICROSOFT-SKYPETEAMSMEETINGURL", "X-GOOGLE-CONFERENCE", "URL"].iter().filter_map(|n| c.text(n)).collect();
    let link =
        meeting_link(url_props.iter().map(String::as_str).chain([location.as_str(), body.as_deref().unwrap_or("")]));
    Details {
        title: c.text("SUMMARY").unwrap_or_default(),
        location,
        organizer: c.prop("ORGANIZER").map(person).unwrap_or_default(),
        attendees,
        body,
        link,
        busy,
        private: c
            .text("CLASS")
            .is_some_and(|v| v.eq_ignore_ascii_case("PRIVATE") || v.eq_ignore_ascii_case("CONFIDENTIAL")),
        categories: c.all("CATEGORIES").flat_map(|p| split_list(&p.value)).collect(),
    }
}

fn cancelled(c: &Component) -> bool {
    c.text("STATUS").is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED"))
}

/// Length of an appointment: all-day in days (at least one), otherwise as a duration.
enum Length {
    Days(i64),
    Span(Duration),
}

fn length(c: &Component, start: &When, zones: &Zones) -> Length {
    let dur = c.prop("DURATION").and_then(|p| parse_duration(&p.value));
    match (start, when(c, "DTEND", zones)) {
        (When::Date(d), Some(When::Date(e))) => Length::Days((e - *d).num_days().max(1)),
        (When::Date(_), _) => Length::Days(dur.map_or(1, |d| d.num_days().max(1))),
        (When::Time(..), Some(end)) => {
            Length::Span((end.utc(&zones.default) - start.utc(&zones.default)).max(Duration::zero()))
        }
        (When::Time(..), None) => Length::Span(dur.unwrap_or_else(Duration::zero).max(Duration::zero())),
    }
}

/// One placed instance: start, end and all-day flag.
fn place(start: &When, len: &Length, zones: &Zones) -> (DateTime<Utc>, DateTime<Utc>, bool) {
    match (start, len) {
        (When::Date(d), Length::Days(n)) => {
            let s = zones.default.to_utc(d.and_hms_opt(0, 0, 0).unwrap());
            let e = zones.default.to_utc((*d + Duration::days(*n)).and_hms_opt(0, 0, 0).unwrap());
            (s, e, true)
        }
        (When::Date(d), Length::Span(span)) => {
            let s = zones.default.to_utc(d.and_hms_opt(0, 0, 0).unwrap());
            (s, s + *span, true)
        }
        (When::Time(..), Length::Days(n)) => {
            let s = start.utc(&zones.default);
            (s, s + Duration::days(*n), false)
        }
        (When::Time(..), Length::Span(span)) => {
            let s = start.utc(&zones.default);
            (s, s + *span, false)
        }
    }
}

/// Key of an instance for matching `RECURRENCE-ID`s: the day of an all-day instance, the UTC
/// instant otherwise.
fn instance_key(w: &When, default: &Zone) -> String {
    match w {
        When::Date(d) => d.format("%Y-%m-%d").to_string(),
        When::Time(..) => instant_id(w.utc(default)),
    }
}

/// The appointments of an ICS file that overlap `window`. Floating times and all-day
/// appointments are placed in `local`.
pub fn parse(
    bytes: &[u8],
    window: (DateTime<Utc>, DateTime<Utc>),
    local: &Zone,
    privacy: Privacy,
) -> Result<Vec<NewEvent>> {
    let top = parse_components(bytes);
    let cals: Vec<&Component> = top.iter().filter(|c| c.name == "VCALENDAR").collect();
    if cals.is_empty() {
        return Err(Error::Parse("keine iCalendar-Daten (BEGIN:VCALENDAR fehlt)".into()));
    }
    let mut defined = HashMap::new();
    for tz in cals.iter().flat_map(|c| c.children.iter()).filter(|c| c.name == "VTIMEZONE") {
        if let (Some(id), Some(rules)) = (tz.text("TZID"), zone_rules(tz)) {
            defined.insert(id, Zone::Rules(Arc::new(rules)));
        }
    }
    let zones = Zones { defined, default: local.clone() };

    // Masters and changed instances by UID, in file order.
    let mut order: Vec<String> = vec![];
    let mut groups: HashMap<String, (Option<&Component>, Vec<&Component>)> = HashMap::new();
    for (n, ev) in cals.iter().flat_map(|c| c.children.iter()).filter(|c| c.name == "VEVENT").enumerate() {
        let uid = ev.text("UID").filter(|u| !u.is_empty()).unwrap_or_else(|| {
            let seed = format!(
                "{}|{}",
                ev.text("SUMMARY").unwrap_or_default(),
                ev.prop("DTSTART").map(|p| p.value.as_str()).unwrap_or("")
            );
            format!("annalo-{n}-{:x}", seed.bytes().fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64)))
        });
        let entry = groups.entry(uid.clone()).or_insert_with(|| {
            order.push(uid.clone());
            (None, vec![])
        });
        if ev.prop("RECURRENCE-ID").is_some() {
            entry.1.push(ev);
        } else {
            entry.0 = Some(ev);
        }
    }

    let (from, to) = window;
    let in_window = |s: DateTime<Utc>, e: DateTime<Utc>| s < to && (e > from || (e == s && s >= from));
    let mut out = vec![];
    for uid in order {
        let (master, overrides) = &groups[&uid];
        let mut changed: HashMap<String, &Component> = HashMap::new();
        for o in overrides {
            if let Some(rid) = when(o, "RECURRENCE-ID", &zones) {
                changed.insert(instance_key(&rid, &zones.default), o);
            }
        }
        let mut used: HashSet<String> = HashSet::new();
        let push =
            |c: &Component, start: &When, len: &Length, instance: String, recurring: bool, out: &mut Vec<NewEvent>| {
                let (s, e, all_day) = place(start, len, &zones);
                if !in_window(s, e) {
                    return;
                }
                let d = details(c);
                let mut ev = NewEvent {
                    uid: uid.clone(),
                    instance,
                    recurring,
                    start: s,
                    end: e,
                    all_day,
                    title: d.title,
                    location: d.location,
                    organizer: d.organizer,
                    attendees: d.attendees,
                    body: d.body,
                    link: d.link,
                    busy: d.busy,
                    private: d.private,
                    categories: d.categories,
                };
                ev.redact(privacy);
                out.push(ev);
            };

        if let Some(m) = master.filter(|m| !cancelled(m)) {
            let Some(start) = when(m, "DTSTART", &zones) else { continue };
            let len = length(m, &start, &zones);
            let zone = match &start {
                When::Date(_) => Zone::Utc,
                When::Time(_, z) => z.clone(),
            };
            let start_wall = start.wall_in(&zone);
            let rule = m.prop("RRULE").map(|p| p.value.clone());
            let rdates: Vec<When> = m.all("RDATE").flat_map(|p| whens(p, &zones)).collect();
            let recurring = rule.is_some() || !rdates.is_empty();
            let mut walls = vec![];
            if recurring {
                let span = match &len {
                    Length::Days(n) => Duration::days(*n),
                    Length::Span(s) => *s,
                };
                let lo = zone.to_wall(from) - Duration::days(2) - span;
                let hi = zone.to_wall(to) + Duration::days(2);
                match &rule {
                    Some(r) => match expand(start_wall, r, rule_until(r, &zone), lo, hi) {
                        Ok(w) => walls = w,
                        // A rule this parser cannot expand: at least the first appointment.
                        Err(_) => walls.push(start_wall),
                    },
                    None => walls.push(start_wall),
                }
                walls.extend(rdates.iter().map(|r| r.wall_in(&zone)));
                let ex: Vec<When> = m.all("EXDATE").flat_map(|p| whens(p, &zones)).collect();
                let ex_days: HashSet<NaiveDate> =
                    ex.iter().filter_map(|w| if let When::Date(d) = w { Some(*d) } else { None }).collect();
                let ex_walls: HashSet<NaiveDateTime> =
                    ex.iter().filter(|w| matches!(w, When::Time(..))).map(|w| w.wall_in(&zone)).collect();
                walls.retain(|w| !ex_walls.contains(w) && !ex_days.contains(&w.date()));
                walls.sort();
                walls.dedup();
            } else {
                walls.push(start_wall);
            }
            for w in walls {
                let inst = match &start {
                    When::Date(_) => When::Date(w.date()),
                    When::Time(..) => When::Time(w, zone.clone()),
                };
                let key = instance_key(&inst, &zones.default);
                let id = if recurring { key.clone() } else { String::new() };
                match changed.get(&key) {
                    Some(o) => {
                        used.insert(key);
                        if cancelled(o) {
                            continue;
                        }
                        let os = when(o, "DTSTART", &zones).unwrap_or(inst);
                        let olen = length(o, &os, &zones);
                        push(o, &os, &olen, id, true, &mut out);
                    }
                    None => push(m, &inst, &len, id, recurring, &mut out),
                }
            }
        }
        // Changed instances whose original time is not part of the expansion (or without a master).
        if master.is_none_or(|m| !cancelled(m)) {
            for (key, o) in &changed {
                if used.contains(key) || cancelled(o) {
                    continue;
                }
                let Some(os) = when(o, "DTSTART", &zones) else { continue };
                let olen = length(o, &os, &zones);
                push(o, &os, &olen, key.clone(), true, &mut out);
            }
        }
        if out.len() > MAX_EVENTS {
            out.truncate(MAX_EVENTS);
            break;
        }
    }
    out.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.title.cmp(&b.title)));
    Ok(out)
}

/// The address to fetch: `webcal://` becomes `https://`; only http(s) is allowed.
pub fn fetch_url(url: &str) -> Result<String> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    let fixed = if let Some(rest) = lower.strip_prefix("webcals://").or_else(|| lower.strip_prefix("webcal://")) {
        format!("https://{}", &u[u.len() - rest.len()..])
    } else {
        u.to_owned()
    };
    let ok = fixed.to_ascii_lowercase().starts_with("https://") || fixed.to_ascii_lowercase().starts_with("http://");
    if !ok || fixed.len() < 10 {
        return Err(Error::State("Die Kalender-Adresse muss mit https://, http:// oder webcal:// beginnen".into()));
    }
    Ok(fixed)
}

/// A subscription address for display: scheme and host only (path and query may hold a token).
pub fn display_url(url: &str) -> String {
    match fetch_url(url).ok().and_then(|u| reqwest::Url::parse(&u).ok()) {
        Some(u) => format!("{}://{}/…", u.scheme(), u.host_str().unwrap_or("")),
        None => "…".into(),
    }
}

/// Largest ICS file read (bytes).
pub const MAX_BYTES: usize = 30 * 1024 * 1024;

/// Downloads a subscription. Errors never contain the URL (it may carry a secret token).
pub async fn fetch(http: &reqwest::Client, url: &str, timeout: std::time::Duration) -> Result<Vec<u8>> {
    let target = fetch_url(url)?;
    let resp = http
        .get(&target)
        .header(reqwest::header::ACCEPT, "text/calendar, */*;q=0.5")
        .timeout(timeout.max(std::time::Duration::from_secs(20)))
        .send()
        .await
        .map_err(|e| Error::Http(e.without_url()))?;
    let status = resp.status();
    if !status.is_success() {
        let hint = match status.as_u16() {
            401 | 403 => " – die Adresse ist nicht (mehr) freigegeben oder der Zugriffsschlüssel ist ungültig",
            404 => " – die Adresse gibt es nicht (mehr)",
            _ => "",
        };
        return Err(Error::State(format!("Der Kalender-Server antwortet mit {status}{hint}")));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err(Error::State("Die Kalenderdatei ist größer als 30 MB".into()));
    }
    let bytes = resp.bytes().await.map_err(|e| Error::Http(e.without_url()))?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::State("Die Kalenderdatei ist größer als 30 MB".into()));
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: Privacy = Privacy { private_details: false, include_body: true, meeting_links: true };

    fn berlin() -> Zone {
        Zone::named("Europe/Berlin").unwrap()
    }

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    fn window() -> (DateTime<Utc>, DateTime<Utc>) {
        (utc(2026, 9, 1, 0, 0), utc(2026, 12, 31, 0, 0))
    }

    fn cal(body: &str) -> Vec<u8> {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//DE\r\n{body}END:VCALENDAR\r\n").into_bytes()
    }

    /// Outlook/Exchange writes Windows zone names with a VTIMEZONE that starts in 1601.
    const OUTLOOK_TZ: &str = "BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n";

    #[test]
    fn content_lines_fold_escape_and_quote() {
        let p = parse_line("ATTENDEE;CN=\"Müller, Jörg\";ROLE=REQ-PARTICIPANT:mailto:j@x.de").unwrap();
        assert_eq!(
            (p.name.as_str(), p.param("CN"), p.value.as_str()),
            ("ATTENDEE", Some("Müller, Jörg"), "mailto:j@x.de")
        );
        assert_eq!(
            parse_line("DESCRIPTION:a\\, b\\; c\\nd\\\\e").map(|p| unescape(&p.value)).unwrap(),
            "a, b; c\nd\\e"
        );
        assert_eq!(split_list("A,B\\,C, D"), ["A", "B,C", "D"]);
        assert!(parse_line("kein doppelpunkt").is_none());
        // A fold inside the two bytes of „ü“ heals on the byte level.
        let bytes = [b"SUMMARY:Gr\xC3".as_slice(), b"\r\n \xBC\xC3\x9Fe\r\n".as_slice()].concat();
        let comps = parse_components(&[b"BEGIN:VEVENT\r\n".as_slice(), &bytes, b"END:VEVENT\r\n"].concat());
        assert_eq!(comps[0].text("SUMMARY").unwrap(), "Grüße");
        assert_eq!(parse_duration("P1DT2H30M"), Some(Duration::minutes(26 * 60 + 30)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
        assert_eq!(parse_duration("P2W"), Some(Duration::days(14)));
        assert_eq!(parse_duration("1H"), None);
        assert_eq!(parse_offset("+0530"), Some(19800));
        assert_eq!(parse_offset("-0100"), Some(-3600));
    }

    #[test]
    fn outlook_series_with_windows_zone_exdate_and_changed_instances() {
        // Weekly on Wednesday 10:00 local, from 2 Sep until 4 Nov 2026 (UNTIL in UTC = last start).
        // 30 Sep is excluded, 14 Oct moved to 14:00, 21 Oct cancelled.
        let body = format!(
            "{OUTLOOK_TZ}BEGIN:VEVENT\r\nUID:040000008200E00074C5B7101A82E008000000001\r\nSUMMARY;LANGUAGE=de-DE:Jour fixe Änderungen\r\n\
             DTSTART;TZID=W. Europe Standard Time:20260902T100000\r\nDTEND;TZID=W. Europe Standard Time:20260902T110000\r\n\
             RRULE:FREQ=WEEKLY;UNTIL=20261104T090000Z;INTERVAL=1;BYDAY=WE;WKST=MO\r\n\
             EXDATE;TZID=W. Europe Standard Time:20260930T100000\r\nLOCATION:Raum Zürich\r\n\
             ORGANIZER;CN=Anna Müller:mailto:anna@example.com\r\nATTENDEE;CN=Jörg Weiß;RSVP=TRUE:mailto:j@example.com\r\n\
             ATTENDEE;CUTYPE=RESOURCE;CN=Raum Zürich:mailto:r@example.com\r\n\
             DESCRIPTION:Agenda\\n\\nMicrosoft Teams-Besprechung\\nhttps://teams.microsoft.com/l/meetup-join/19%3a1\r\n\
             X-MICROSOFT-CDO-BUSYSTATUS:BUSY\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:040000008200E00074C5B7101A82E008000000001\r\nRECURRENCE-ID;TZID=W. Europe Standard Time:20261014T100000\r\n\
             SUMMARY:Jour fixe (verschoben)\r\nDTSTART;TZID=W. Europe Standard Time:20261014T140000\r\nDTEND;TZID=W. Europe Standard Time:20261014T150000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:040000008200E00074C5B7101A82E008000000001\r\nRECURRENCE-ID;TZID=W. Europe Standard Time:20261021T100000\r\n\
             STATUS:CANCELLED\r\nDTSTART;TZID=W. Europe Standard Time:20261021T100000\r\nEND:VEVENT\r\n"
        );
        let evs = parse(&cal(&body), window(), &berlin(), ALL).unwrap();
        let starts: Vec<_> = evs.iter().map(|e| e.start).collect();
        assert_eq!(
            starts,
            [
                utc(2026, 9, 2, 8, 0),
                utc(2026, 9, 9, 8, 0),
                utc(2026, 9, 16, 8, 0),
                utc(2026, 9, 23, 8, 0),
                utc(2026, 10, 7, 8, 0),
                utc(2026, 10, 14, 12, 0),
                utc(2026, 10, 28, 9, 0), // after the change to winter time: still 10:00 local
                utc(2026, 11, 4, 9, 0),
            ]
        );
        let first = &evs[0];
        assert_eq!(first.title, "Jour fixe Änderungen");
        assert_eq!((first.location.as_str(), first.organizer.as_str()), ("Raum Zürich", "Anna Müller"));
        assert_eq!(first.attendees, ["Jörg Weiß"], "rooms are no attendees");
        assert_eq!(first.link.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/19%3a1"));
        assert!(first.recurring && first.instance == "2026-09-02T08:00:00Z");
        assert_eq!(first.end - first.start, Duration::hours(1));
        let moved = &evs[5];
        assert_eq!((moved.title.as_str(), moved.instance.as_str()), ("Jour fixe (verschoben)", "2026-10-14T08:00:00Z"));
    }

    #[test]
    fn custom_zone_definitions_are_used_for_unknown_names() {
        let tz = OUTLOOK_TZ
            .replace("W. Europe Standard Time", "(UTC+01:00) Amsterdam\\, Berlin\\, Bern\\, Rom\\, Stockholm\\, Wien");
        let body = format!(
            "{tz}BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Sommer\r\nDTSTART;TZID=\"(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien\":20260915T090000\r\nDURATION:PT30M\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Winter\r\nDTSTART;TZID=\"(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien\":20261115T090000\r\nDURATION:PT30M\r\nEND:VEVENT\r\n"
        );
        // The floating default zone (UTC here) must not be used for these.
        let evs = parse(&cal(&body), window(), &Zone::Utc, ALL).unwrap();
        assert_eq!(evs.iter().map(|e| e.start).collect::<Vec<_>>(), [utc(2026, 9, 15, 7, 0), utc(2026, 11, 15, 8, 0)]);
        assert_eq!(evs[0].end - evs[0].start, Duration::minutes(30));
    }

    #[test]
    fn all_day_floating_and_utc_values() {
        let body = "BEGIN:VEVENT\r\nUID:d1\r\nSUMMARY:Betriebsausflug\r\nDTSTART;VALUE=DATE:20260918\r\nDTEND;VALUE=DATE:20260920\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:d2\r\nSUMMARY:Urlaub\r\nDTSTART;VALUE=DATE:20261005\r\nX-MICROSOFT-CDO-BUSYSTATUS:OOF\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:f\r\nSUMMARY:Schwebend\r\nDTSTART:20260910T083000\r\nDTEND:20260910T090000\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:z\r\nSUMMARY:UTC\r\nDTSTART:20260911T083000Z\r\nDTEND:20260911T090000Z\r\nCLASS:PRIVATE\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:old\r\nSUMMARY:Vorbei\r\nDTSTART:20250101T083000Z\r\nEND:VEVENT\r\n";
        let evs = parse(&cal(body), window(), &berlin(), ALL).unwrap();
        let by = |uid: &str| evs.iter().find(|e| e.uid == uid).unwrap();
        let trip = by("d1");
        assert!(trip.all_day && !trip.recurring && trip.instance.is_empty());
        assert_eq!(
            (trip.start, trip.end),
            (utc(2026, 9, 17, 22, 0), utc(2026, 9, 19, 22, 0)),
            "local midnights, end exclusive"
        );
        assert_eq!(trip.busy, Busy::Free);
        let vac = by("d2");
        assert_eq!((vac.end - vac.start, vac.busy), (Duration::days(1), Busy::Oof));
        assert_eq!(by("f").start, utc(2026, 9, 10, 6, 30), "floating = local zone");
        let private = by("z");
        assert_eq!((private.start, private.title.as_str()), (utc(2026, 9, 11, 8, 30), super::super::PRIVATE_TITLE));
        assert!(evs.iter().all(|e| e.uid != "old"), "outside the window");
    }

    #[test]
    fn google_style_count_rdate_and_all_day_series() {
        let body = "BEGIN:VEVENT\r\nUID:g1@google.com\r\nSUMMARY:Daily\r\nDTSTART;TZID=Europe/Berlin:20260921T091500\r\nDTEND;TZID=Europe/Berlin:20260921T093000\r\n\
                    RRULE:FREQ=DAILY;COUNT=5;BYDAY=MO,TU,WE,TH,FR\r\nRDATE;TZID=Europe/Berlin:20260926T100000\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:bd\r\nSUMMARY:Geburtstag\r\nDTSTART;VALUE=DATE:20200930\r\nRRULE:FREQ=YEARLY\r\nEXDATE;VALUE=DATE:20270930\r\nEND:VEVENT\r\n";
        let evs = parse(&cal(body), (utc(2026, 9, 1, 0, 0), utc(2027, 12, 31, 0, 0)), &berlin(), ALL).unwrap();
        let daily: Vec<_> = evs.iter().filter(|e| e.uid == "g1@google.com").map(|e| e.start).collect();
        assert_eq!(
            daily,
            [
                utc(2026, 9, 21, 7, 15),
                utc(2026, 9, 22, 7, 15),
                utc(2026, 9, 23, 7, 15),
                utc(2026, 9, 24, 7, 15),
                utc(2026, 9, 25, 7, 15),
                utc(2026, 9, 26, 8, 0),
            ]
        );
        let bday: Vec<_> = evs.iter().filter(|e| e.uid == "bd").collect();
        assert_eq!(bday.len(), 1, "2027 excluded");
        assert_eq!((bday[0].instance.as_str(), bday[0].all_day), ("2026-09-30", true));
    }

    #[test]
    fn dst_change_inside_a_daily_series() {
        let body = "BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Standup\r\nDTSTART;TZID=Europe/Berlin:20261023T090000\r\nDURATION:PT15M\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEND:VEVENT\r\n";
        let evs = parse(&cal(body), window(), &Zone::Utc, ALL).unwrap();
        let hours: Vec<u32> = evs.iter().map(|e| chrono::Timelike::hour(&e.start)).collect();
        assert_eq!(hours, [7, 7, 8, 8], "09:00 local before and after 25 Oct");
    }

    #[test]
    fn broken_input_is_tolerated_or_refused() {
        assert!(parse(b"hello", window(), &berlin(), ALL).is_err());
        // Missing END lines, a stray END, an invalid rule and an event without start.
        let body = "BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Kaputte Regel\r\nDTSTART:20260915T080000Z\r\nRRULE:FREQ=SOMETIMES\r\nEND:VEVENT\r\nEND:VTODO\r\n\
                    BEGIN:VEVENT\r\nUID:y\r\nSUMMARY:Ohne Start\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Ohne UID\r\nDTSTART:20260916T080000Z\r\n";
        let evs = parse(format!("BEGIN:VCALENDAR\n{body}").as_bytes(), window(), &berlin(), ALL).unwrap();
        let titles: Vec<_> = evs.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, ["Kaputte Regel", "Ohne UID"]);
        assert!(evs[1].uid.starts_with("annalo-"));
    }

    #[test]
    fn subscription_addresses() {
        assert_eq!(
            fetch_url("webcal://outlook.office365.com/owa/calendar/abc/calendar.ics").unwrap(),
            "https://outlook.office365.com/owa/calendar/abc/calendar.ics"
        );
        assert_eq!(fetch_url(" https://x.de/a.ics ").unwrap(), "https://x.de/a.ics");
        assert!(fetch_url("file:///etc/passwd").is_err());
        assert!(fetch_url("ftp://x").is_err());
        assert_eq!(
            display_url("webcal://calendar.google.com/calendar/ical/private-abc/basic.ics"),
            "https://calendar.google.com/…"
        );
    }

    #[tokio::test]
    async fn fetch_reports_status_without_the_url() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for status in ["403 Forbidden", "200 OK"] {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf).await;
                let body = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
                let resp =
                    format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                s.write_all(resp.as_bytes()).await.unwrap();
            }
        });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("http://127.0.0.1:{port}/cal.ics?token=GEHEIM");
        let err = fetch(&http, &url, std::time::Duration::from_secs(5)).await.unwrap_err().to_string();
        assert!(err.contains("403") && !err.contains("GEHEIM"), "{err}");
        let ok = fetch(&http, &url, std::time::Duration::from_secs(5)).await.unwrap();
        assert!(ok.starts_with(b"BEGIN:VCALENDAR"));
    }
}
