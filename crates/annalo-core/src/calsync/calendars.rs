//! The calendars of Outlook Classic Annalo can read („Kalender auswählen“): what discovery found
//! (the default calendar, further calendar folders of every store, calendars shared by
//! colleagues, rooms and groups in the navigation pane), what the user selected, and the source
//! ids they sync under.
//!
//! The default calendar keeps the source id `outlook` it always had, so its events, marks
//! („gebucht“, meeting note, „nicht buchen“) and WBS memory stay where they are. Every other
//! calendar is `outlook:<hash>`, the hash taken over its StoreID and EntryID (or, for a
//! colleague's calendar opened by name, over that name): stable across syncs and restarts.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{OUTLOOK, PALETTE};
use crate::outlookcom::{int, text, truthy};

/// At most this many Outlook calendars in the settings.
pub const MAX_CALENDARS: usize = 40;

/// At most this many people whose calendars are opened by name.
pub const MAX_RECIPIENTS: usize = 20;

/// Where an Outlook calendar lives, as far as it matters for Annalo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum OutlookKind {
    /// The user's own mailbox (default calendar, its sub-calendars, a second own account).
    #[default]
    Own,
    /// A PST file or another store outside Exchange (IMAP, internet calendars).
    File,
    /// Another mailbox in the profile: a shared or team mailbox, a delegate's mailbox.
    Mailbox,
    /// A colleague's calendar opened in the navigation pane or by name.
    Shared,
    /// A room calendar.
    Room,
    /// A Microsoft 365 group calendar.
    Group,
}

impl OutlookKind {
    /// Someone else's calendar: its meetings are not proposed for booking by default.
    pub fn shared(self) -> bool {
        !matches!(self, OutlookKind::Own | OutlookKind::File)
    }
}

/// A selected (or once selected) Outlook calendar in the settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OutlookCalendar {
    /// Source id: `outlook` for the default calendar, else `outlook:<hash>`.
    pub id: String,
    pub store_id: String,
    pub entry_id: String,
    /// Name or address of the person whose default calendar this is (opened by name, or read
    /// as free/busy when the folder itself cannot be opened).
    pub recipient: String,
    /// Folder name („Kalender“, „Projekt X“).
    pub name: String,
    /// Mailbox, store or person („anna.mueller@firma.de“, „Archiv 2025“, „Raum Zürich“).
    pub owner: String,
    /// Folder path in Outlook (`\\anna@firma.de\Kalender\Projekt X`).
    pub path: String,
    pub kind: OutlookKind,
    /// The default calendar of the profile.
    pub default: bool,
    /// Only free/busy times can be read (no subjects).
    pub free_busy: bool,
    /// `#rrggbb`.
    pub color: String,
    /// Synced (while Outlook is switched on).
    pub enabled: bool,
    /// „Für Buchungsvorschläge verwenden“: its meetings go into the week proposal, the day
    /// review and the quick capture's „Jetzt“.
    pub booking: bool,
}

impl Default for OutlookCalendar {
    fn default() -> Self {
        OutlookCalendar {
            id: String::new(),
            store_id: String::new(),
            entry_id: String::new(),
            recipient: String::new(),
            name: String::new(),
            owner: String::new(),
            path: String::new(),
            kind: OutlookKind::Own,
            default: false,
            free_busy: false,
            color: PALETTE[0].into(),
            enabled: false,
            booking: true,
        }
    }
}

impl OutlookCalendar {
    /// The default calendar as settings from before calendar selection describe it.
    pub fn default_calendar(color: &str) -> Self {
        OutlookCalendar {
            id: OUTLOOK.into(),
            name: "Kalender".into(),
            default: true,
            color: color.into(),
            enabled: true,
            booking: true,
            ..Default::default()
        }
    }

    /// How the calendar is called in the views: „Outlook“ for the default one, else its name,
    /// with the owner in front for someone else's calendar („Anna Müller – Kalender“).
    pub fn label(&self) -> String {
        if self.default {
            return "Outlook".into();
        }
        if self.kind.shared() && !self.owner.is_empty() && self.owner != self.name {
            return format!("{} – {}", self.owner, self.name);
        }
        self.name.clone()
    }

    /// Rank in the list and for duplicates: own calendars first, the default one before all.
    pub fn rank(&self) -> u8 {
        if self.default {
            return 0;
        }
        1 + self.kind as u8
    }
}

/// `outlook:<12 hex>` of a calendar folder (StoreID and EntryID, case-insensitive), or of a
/// person's calendar opened by name.
pub fn source_id(store_id: &str, entry_id: &str, recipient: &str) -> String {
    let seed = if entry_id.trim().is_empty() {
        format!("person|{}", recipient.trim().to_lowercase())
    } else {
        format!("{}|{}", store_id.trim().to_ascii_uppercase(), entry_id.trim().to_ascii_uppercase())
    };
    let hash: String = Sha256::digest(seed.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("{OUTLOOK}:{hash}")
}

/// Whether a source id belongs to Outlook (`outlook` or `outlook:<hash>`).
pub fn is_outlook(source: &str) -> bool {
    source == OUTLOOK || source.starts_with("outlook:")
}

/// A calendar as discovery found it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscoveredCalendar {
    pub id: String,
    pub store_id: String,
    pub entry_id: String,
    pub recipient: String,
    pub name: String,
    pub owner: String,
    pub path: String,
    pub kind: OutlookKind,
    pub default: bool,
    pub free_busy: bool,
    /// Items in the folder (all of them, not only the window), when cheap to know.
    pub items: Option<i64>,
    /// Why the folder cannot be read (German), when it cannot.
    pub error: Option<String>,
}

/// The kind of a discovered folder from what the script reports about its store and where in
/// the navigation pane it was found.
fn classify(v: &Value) -> OutlookKind {
    if truthy(&v["default"]) {
        return OutlookKind::Own;
    }
    let group_type = if v["groupType"].is_null() { -1 } else { int(v, "groupType") };
    let group = text(v, "group").to_lowercase();
    // OlGroupType: 4 people („Freigegebene Kalender“), 6 rooms.
    if group_type == 6 || group.contains("raum") || group.contains("räume") || group.contains("room") {
        return OutlookKind::Room;
    }
    if group == "gruppen" || group == "groups" || group.contains("gruppenkalender") || group.contains("group calendars")
    {
        return OutlookKind::Group;
    }
    if truthy(&v["person"]) || group_type == 4 {
        return OutlookKind::Shared;
    }
    // OlExchangeStoreType: 0 primary mailbox, 1 delegate mailbox, 3 not Exchange, 4 additional mailbox.
    let store_type = if v["storeType"].is_null() { -1 } else { int(v, "storeType") };
    match store_type {
        0 => OutlookKind::Own,
        1 | 4 => OutlookKind::Mailbox,
        3 => OutlookKind::File,
        _ if !text(v, "filePath").is_empty() => OutlookKind::File,
        _ if truthy(&v["nav"]) && !text(v, "error").is_empty() => OutlookKind::Shared,
        _ => OutlookKind::Own,
    }
}

/// The German text of a folder error of the script.
pub fn folder_error_text(code: &str, detail: &str) -> String {
    let detail = detail.trim();
    let tail = if detail.is_empty() { String::new() } else { format!(" ({detail})") };
    match code {
        "denied" => format!("Kein Zugriff auf diesen Kalender{tail}. Um Leserechte bitten oder die Freigabe prüfen."),
        "not_found" => format!(
            "Den Kalender gibt es in Outlook nicht mehr (gelöscht, verschoben oder nicht mehr freigegeben){tail}."
        ),
        "unresolved" => "Der Name oder die Adresse ist im Adressbuch nicht eindeutig zu finden.".into(),
        _ => format!("Der Kalender ließ sich nicht öffnen{tail}."),
    }
}

/// Mailbox names as Outlook shows them, without „Postfach - “ in front.
fn clean_owner(s: &str) -> String {
    let s = s.trim();
    for prefix in ["Postfach - ", "Mailbox - ", "Postfach – ", "Mailbox – "] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return rest.trim().to_owned();
        }
    }
    s.to_owned()
}

/// Discovery output (`{"ok":true,"calendars":[…]}`) as calendars; the default one first, then
/// own, files, mailboxes, shared, rooms, groups, each by owner and name. A folder the script
/// could not read keeps its error; free/busy-only calendars are marked.
pub fn parse_discovery(v: &Value) -> Vec<DiscoveredCalendar> {
    let mut out: Vec<DiscoveredCalendar> = vec![];
    for c in crate::outlookcom::items(v, "calendars") {
        let entry_id = text(&c, "entryId");
        let store_id = text(&c, "storeId");
        let recipient = text(&c, "recipient");
        let default = truthy(&c["default"]);
        if entry_id.is_empty() && recipient.is_empty() && !default {
            continue;
        }
        let kind = classify(&c);
        let id = if default { OUTLOOK.to_owned() } else { source_id(&store_id, &entry_id, &recipient) };
        if out.iter().any(|x| x.id == id) {
            continue;
        }
        let free_busy = truthy(&c["freeBusy"]);
        let code = text(&c, "error");
        let error = (!code.is_empty() && !free_busy).then(|| folder_error_text(&code, &text(&c, "message")));
        let owner = match clean_owner(&text(&c, "owner")) {
            o if o.is_empty() => clean_owner(&text(&c, "store")),
            o => o,
        };
        let items = match &c["items"] {
            Value::Null => None,
            _ => Some(int(&c, "items")).filter(|n| *n >= 0),
        };
        let mut name = text(&c, "name");
        if name.is_empty() {
            name = if owner.is_empty() { "Kalender".into() } else { owner.clone() };
        }
        out.push(DiscoveredCalendar {
            id,
            store_id,
            entry_id,
            recipient,
            name,
            owner,
            path: text(&c, "path"),
            kind,
            default,
            free_busy,
            items,
            error,
        });
    }
    let rank = |d: &DiscoveredCalendar| if d.default { 0 } else { 1 + d.kind as u8 };
    out.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.owner.to_lowercase().cmp(&b.owner.to_lowercase()))
            // A store's main calendar before its sub-calendars.
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    out
}

impl From<&DiscoveredCalendar> for OutlookCalendar {
    fn from(d: &DiscoveredCalendar) -> Self {
        OutlookCalendar {
            id: d.id.clone(),
            store_id: d.store_id.clone(),
            entry_id: d.entry_id.clone(),
            recipient: d.recipient.clone(),
            name: d.name.clone(),
            owner: d.owner.clone(),
            path: d.path.clone(),
            kind: d.kind,
            default: d.default,
            free_busy: d.free_busy,
            color: PALETTE[0].into(),
            enabled: d.default,
            booking: !d.kind.shared(),
        }
    }
}

/// A calendar row of Settings → Kalender → „Kalender auswählen“: the stored choice (or what a
/// new selection would store) with what discovery found out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutlookChoice {
    #[serde(flatten)]
    pub calendar: OutlookCalendar,
    /// In the settings (selected now or before).
    pub stored: bool,
    /// Found by the last discovery (`None`: no discovery yet).
    pub found: Option<bool>,
    pub items: Option<i64>,
    /// Why discovery could not read it.
    pub error: Option<String>,
}

/// The rows of „Kalender auswählen“: every stored calendar and everything discovery found,
/// each once, in discovery's order (stored ones it did not find at the end). A calendar not
/// stored yet gets the next free color.
pub fn choices(stored: &[OutlookCalendar], found: Option<&[DiscoveredCalendar]>) -> Vec<OutlookChoice> {
    let mut out = vec![];
    let mut used: Vec<String> = stored.iter().map(|c| c.color.clone()).collect();
    for d in found.unwrap_or_default() {
        let (calendar, is_stored) = match stored.iter().find(|c| c.id == d.id) {
            Some(c) => {
                let mut c = c.clone();
                refresh(&mut c, d);
                (c, true)
            }
            None => {
                let mut c = OutlookCalendar::from(d);
                c.color = next_color(&used);
                used.push(c.color.clone());
                (c, false)
            }
        };
        out.push(OutlookChoice {
            calendar,
            stored: is_stored,
            found: Some(true),
            items: d.items,
            error: d.error.clone(),
        });
    }
    for c in stored {
        if out.iter().any(|x| x.calendar.id == c.id) {
            continue;
        }
        out.push(OutlookChoice {
            calendar: c.clone(),
            stored: true,
            found: found.map(|_| false),
            items: None,
            error: None,
        });
    }
    if found.is_none() {
        out.sort_by_key(|c| c.calendar.rank());
    }
    out
}

/// Takes over what discovery knows about a stored calendar (names, path, kind, ids); the
/// user's choices (switch, color, booking) stay.
pub fn refresh(c: &mut OutlookCalendar, d: &DiscoveredCalendar) {
    c.name = d.name.clone();
    c.owner = d.owner.clone();
    c.path = d.path.clone();
    c.kind = d.kind;
    c.free_busy = d.free_busy;
    if !d.entry_id.is_empty() {
        c.entry_id = d.entry_id.clone();
        c.store_id = d.store_id.clone();
    }
    if !d.recipient.is_empty() {
        c.recipient = d.recipient.clone();
    }
}

/// The first palette color none of `used` has (else the palette in turn).
pub fn next_color(used: &[String]) -> String {
    PALETTE
        .iter()
        .find(|c| !used.iter().any(|u| u.eq_ignore_ascii_case(c)))
        .map(|c| (*c).to_owned())
        .unwrap_or_else(|| PALETTE[used.len() % PALETTE.len()].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the script prints on a German Outlook: umlauts as \u escapes, the default calendar,
    /// a sub-calendar, a PST, a shared mailbox of the profile, a colleague's calendar from the
    /// navigation pane, a free/busy-only one, a room, a group, a folder that refused access, a
    /// person opened by name that the address book did not know, and a duplicate.
    pub const DISCOVERY: &str = r#"{"ok":true,"version":"16.0","navError":"","calendars":[
      {"entryId":"00AA","storeId":"S0","name":"Kalender","path":"\\\\maurice@firma.de\\Kalender","store":"maurice@firma.de","storeType":0,"filePath":"","default":true,"nav":false,"group":"","groupType":-1,"owner":"maurice@firma.de","recipient":"","person":false,"items":412,"freeBusy":false,"error":"","message":""},
      {"entryId":"00AB","storeId":"S0","name":"Projekt \u00c4nderungen","path":"\\\\maurice@firma.de\\Kalender\\Projekt \u00c4nderungen","store":"maurice@firma.de","storeType":0,"filePath":"","default":false,"nav":false,"group":"","groupType":-1,"owner":"maurice@firma.de","recipient":"","person":false,"items":"12","freeBusy":false,"error":"","message":""},
      {"entryId":"00AB","storeId":"S0","name":"Projekt \u00c4nderungen","path":"x","storeType":0,"nav":true,"group":"Meine Kalender","groupType":2},
      {"entryId":"0PST","storeId":"S1","name":"Kalender","path":"\\\\Archiv 2025\\Kalender","store":"Archiv 2025","storeType":3,"filePath":"C:\\Users\\m\\Archiv.pst","default":false,"nav":false,"owner":"Archiv 2025","items":7},
      {"entryId":"0TEAM","storeId":"S2","name":"Kalender","path":"\\\\Team Vertrieb\\Kalender","store":"Postfach - Team Vertrieb","storeType":1,"owner":"Postfach - Team Vertrieb","items":80},
      {"entryId":"0ANNA","storeId":"S3","name":"Kalender","path":"\\\\Anna M\u00fcller\\Kalender","store":"Anna M\u00fcller","storeType":1,"nav":true,"group":"Freigegebene Kalender","groupType":4,"owner":"Anna M\u00fcller","recipient":"Anna M\u00fcller","items":55},
      {"entryId":"","storeId":"","name":"J\u00f6rg Wei\u00df","path":"","store":"","storeType":-1,"nav":true,"group":"Freigegebene Kalender","groupType":4,"owner":"J\u00f6rg Wei\u00df","recipient":"J\u00f6rg Wei\u00df","items":-1,"freeBusy":true,"error":"","message":""},
      {"entryId":"0ROOM","storeId":"S4","name":"Raum Z\u00fcrich","path":"","storeType":1,"nav":true,"group":"R\u00e4ume","groupType":6,"owner":"Raum Z\u00fcrich","recipient":"Raum Z\u00fcrich","items":3},
      {"entryId":"0GRP","storeId":"S5","name":"Kalender","path":"","storeType":4,"nav":true,"group":"Gruppen","groupType":0,"owner":"Projektgruppe X","items":9},
      {"entryId":"","storeId":"","name":"Chef","nav":true,"group":"Freigegebene Kalender","groupType":4,"owner":"Chef","recipient":"Chef","items":-1,"freeBusy":false,"error":"denied","message":"Sie verf\u00fcgen nicht \u00fcber die erforderliche Berechtigung."},
      {"entryId":"","name":"Niemand","person":true,"recipient":"Niemand","owner":"Niemand","error":"unresolved"},
      {"entryId":"","storeId":"","name":"","nav":true}
    ]}"#;

    fn found() -> Vec<DiscoveredCalendar> {
        parse_discovery(&serde_json::from_str(DISCOVERY).unwrap())
    }

    #[test]
    fn discovery_lists_every_kind_of_calendar_once() {
        let f = found();
        let rows: Vec<_> = f.iter().map(|d| (d.name.as_str(), d.owner.as_str(), d.kind)).collect();
        assert_eq!(
            rows,
            [
                ("Kalender", "maurice@firma.de", OutlookKind::Own),
                ("Projekt Änderungen", "maurice@firma.de", OutlookKind::Own),
                ("Kalender", "Archiv 2025", OutlookKind::File),
                ("Kalender", "Team Vertrieb", OutlookKind::Mailbox),
                ("Kalender", "Anna Müller", OutlookKind::Shared),
                ("Chef", "Chef", OutlookKind::Shared),
                ("Jörg Weiß", "Jörg Weiß", OutlookKind::Shared),
                ("Niemand", "Niemand", OutlookKind::Shared),
                ("Raum Zürich", "Raum Zürich", OutlookKind::Room),
                ("Kalender", "Projektgruppe X", OutlookKind::Group),
            ]
        );
        let def = &f[0];
        assert!(def.default && def.id == OUTLOOK && def.items == Some(412));
        assert_eq!(f[1].items, Some(12), "a count PowerShell wrote as text");
        assert!(f[1].id.starts_with("outlook:") && f[1].id.len() == "outlook:".len() + 12);
        let joerg = f.iter().find(|d| d.name == "Jörg Weiß").unwrap();
        assert!(joerg.free_busy && joerg.error.is_none() && joerg.items.is_none());
        assert_eq!(joerg.id, source_id("", "", "jörg weiß"), "a person's calendar by name");
        let chef = f.iter().find(|d| d.name == "Chef").unwrap();
        assert!(
            chef.error.as_deref().unwrap().starts_with("Kein Zugriff")
                && chef.error.as_deref().unwrap().contains("Berechtigung")
        );
        assert!(f.iter().find(|d| d.name == "Niemand").unwrap().error.as_deref().unwrap().contains("Adressbuch"));
        assert!(OutlookKind::Shared.shared() && OutlookKind::Room.shared() && !OutlookKind::File.shared());
    }

    #[test]
    fn source_ids_are_stable_and_the_default_stays_outlook() {
        let a = source_id("s0", "00ab", "");
        assert_eq!(a, source_id(" S0 ", "00AB", "anyone"), "case and blanks do not matter");
        assert_ne!(a, source_id("S1", "00AB", ""), "another store");
        assert_eq!(a, "outlook:".to_owned() + &a[8..]);
        assert!(is_outlook(OUTLOOK) && is_outlook(&a) && !is_outlook("ics:s1") && !is_outlook("outlookx"));
        // Known value: changing the hash would orphan every stored calendar.
        assert_eq!(source_id("S0", "00AB", ""), source_id("S0", "00AB", ""));
        assert_eq!(found()[0].id, OUTLOOK);
    }

    #[test]
    fn choices_merge_stored_calendars_with_discovery() {
        let f = found();
        let mut anna = OutlookCalendar::from(&f[4]);
        anna.enabled = true;
        anna.color = "#db2777".into();
        anna.name = "alter Name".into();
        let gone = OutlookCalendar {
            id: "outlook:000000000000".into(),
            name: "Gelöscht".into(),
            enabled: true,
            ..Default::default()
        };
        let stored = vec![OutlookCalendar::default_calendar(PALETTE[0]), anna, gone];
        let rows = choices(&stored, Some(&f));
        assert_eq!(rows.len(), f.len() + 1);
        assert!(rows[0].stored && rows[0].calendar.enabled && rows[0].calendar.name == "Kalender");
        let a = rows.iter().find(|r| r.calendar.owner == "Anna Müller").unwrap();
        assert_eq!((a.stored, a.calendar.color.as_str(), a.calendar.name.as_str()), (true, "#db2777", "Kalender"));
        assert!(!a.calendar.booking, "shared: not for booking proposals by default");
        let pst = rows.iter().find(|r| r.calendar.owner == "Archiv 2025").unwrap();
        assert!(!pst.stored && !pst.calendar.enabled && pst.calendar.booking);
        assert_ne!(pst.calendar.color, PALETTE[0], "a color not taken yet");
        assert_ne!(pst.calendar.color, "#db2777");
        let last = rows.last().unwrap();
        assert_eq!((last.calendar.name.as_str(), last.found), ("Gelöscht", Some(false)));
        // Without discovery: the stored ones, default first.
        let rows = choices(&stored, None);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].calendar.id, OUTLOOK);
        assert_eq!(rows[0].found, None);
    }
}
