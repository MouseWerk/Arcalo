//! Time sheet exports: SAP PS (CATS), Jira worklogs, CSV and JSON.
//!
//! Exporters are pure functions over [`TimeEntryRow`]s; callers select rows
//! with [`crate::Database::list_time_entries`] and, after a successful
//! upload, flag them with `set_entry_status(.., StatusFlag::Exported)`.

use std::collections::HashMap;
use std::fmt::Write as _;

use chrono::{DateTime, FixedOffset, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::{StatusFlag, TimeEntryRow};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    /// SAP CATS upload file (semicolon separated, German decimals).
    SapCats,
    /// Jira worklog payloads (`POST /rest/api/3/issue/{key}/worklog`).
    JiraWorklog,
    Csv,
    Json,
}

impl ExportFormat {
    pub fn file_extension(self) -> &'static str {
        match self {
            ExportFormat::SapCats | ExportFormat::Csv => "csv",
            ExportFormat::JiraWorklog | ExportFormat::Json => "json",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.to_ascii_lowercase().as_str() {
            "cats" | "sap" | "sap_cats" | "sap-cats" => ExportFormat::SapCats,
            "jira" | "jira_worklog" | "jira-worklog" => ExportFormat::JiraWorklog,
            "csv" => ExportFormat::Csv,
            "json" => ExportFormat::Json,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExportOptions {
    /// SAP personnel number (PERNR) written into every CATS row.
    pub pernr: Option<String>,
    /// Maps `NP-8801/1020` (Vorgang) or `NP-8801` (Netzplan) to a Jira issue key.
    pub jira_issue_map: HashMap<String, String>,
    /// Fixed UTC offset in minutes for dates in CATS/CSV and Jira `started`.
    /// `None` uses the system time zone per entry, so daylight saving time is honoured.
    #[serde(default)]
    pub utc_offset_minutes: Option<i32>,
    /// Separator of the CATS file (Settings → Zeiterfassung).
    #[serde(default)]
    pub cats_delimiter: crate::prefs::CatsDelimiter,
    /// Column order of the CATS file.
    #[serde(default)]
    pub cats_columns: crate::prefs::CatsColumns,
}

impl ExportOptions {
    fn local(&self, t: DateTime<Utc>) -> DateTime<FixedOffset> {
        match self.utc_offset_minutes.and_then(|m| FixedOffset::east_opt(m * 60)) {
            Some(off) => t.with_timezone(&off),
            None => t.with_timezone(&Local).fixed_offset(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub content: String,
    pub exported_ids: Vec<i64>,
    /// Entries left out, with the reason.
    pub skipped: Vec<(i64, String)>,
}

pub fn export(rows: &[TimeEntryRow], format: ExportFormat, opts: &ExportOptions) -> Result<ExportResult> {
    let mut skipped = vec![];
    let rows: Vec<&TimeEntryRow> = rows
        .iter()
        .filter(|r| {
            let ok = r.entry.status_flag != StatusFlag::Running && r.entry.duration_minutes.is_some();
            if !ok {
                skipped.push((r.entry.id, "timer still running".to_owned()));
            }
            ok
        })
        .collect();

    let (content, exported_ids) = match format {
        ExportFormat::SapCats => sap_cats(&rows, opts),
        ExportFormat::Csv => csv(&rows, opts),
        ExportFormat::Json => (serde_json::to_string_pretty(&rows)?, rows.iter().map(|r| r.entry.id).collect()),
        ExportFormat::JiraWorklog => jira(&rows, opts, &mut skipped)?,
    };
    Ok(ExportResult { content, exported_ids, skipped })
}

fn hours(r: &TimeEntryRow) -> f64 {
    r.entry.duration_minutes.unwrap_or(0) as f64 / 60.0
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Quotes a field for a delimiter-separated file (RFC 4180 rules). Text that a
/// spreadsheet would run as a formula (`=`, `+`, `-`, `@`, …) is prefixed with `'`.
pub(crate) fn field(s: &str, delim: char) -> String {
    let s = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{s}") } else { s.to_owned() };
    if s.contains([delim, '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s }
}

fn sap_cats(rows: &[&TimeEntryRow], opts: &ExportOptions) -> (String, Vec<i64>) {
    // Field names follow the CATS data structure (CATSDB / BAPICATS1).
    let d = opts.cats_delimiter.char();
    let cols = opts.cats_columns.columns();
    let sep = d.to_string();
    let mut out = cols.join(&sep);
    out.push_str("\r\n");
    let pernr = opts.pernr.as_deref().unwrap_or("");
    for r in rows {
        let date = opts.local(r.entry.start_time).format("%Y%m%d").to_string();
        let hrs = format!("{:.2}", hours(r)).replace('.', ",");
        let values: Vec<String> = cols
            .iter()
            .map(|c| match *c {
                "PERNR" => field(pernr, d),
                "WORKDATE" => date.clone(),
                "RPROJ" => field(&r.wbs_element, d),
                "RNPLNR" => field(&r.netzplan_nr, d),
                "VORNR" => field(r.entry.vorgang_nr.as_deref().unwrap_or(""), d),
                "LSTAR" => field(r.entry.leistungsart.as_deref().unwrap_or(""), d),
                "CATSHOURS" => field(&hrs, d),
                "MEINH" => "H".to_owned(),
                // LTXA1 is CHAR 40 in SAP.
                _ => field(&truncate_chars(&r.entry.description.replace(['\r', '\n'], " "), 40), d),
            })
            .collect();
        let _ = write!(out, "{}\r\n", values.join(&sep));
    }
    (out, rows.iter().map(|r| r.entry.id).collect())
}

fn csv(rows: &[&TimeEntryRow], opts: &ExportOptions) -> (String, Vec<i64>) {
    let mut out = String::from(
        "id,project,netzplan,wbs_element,vorgang,leistungsart,start,end,duration_minutes,hours,description,status\r\n",
    );
    let fmt = |t: chrono::DateTime<chrono::Utc>| opts.local(t).to_rfc3339_opts(SecondsFormat::Secs, true);
    for r in rows {
        let e = &r.entry;
        let cols = [
            e.id.to_string(),
            r.project_code.clone(),
            r.netzplan_nr.clone(),
            r.wbs_element.clone(),
            e.vorgang_nr.clone().unwrap_or_default(),
            e.leistungsart.clone().unwrap_or_default(),
            fmt(e.start_time),
            e.end_time.map(fmt).unwrap_or_default(),
            e.duration_minutes.unwrap_or(0).to_string(),
            format!("{:.2}", hours(r)),
            e.description.clone(),
            e.status_flag.as_str().to_owned(),
        ];
        let line: Vec<String> = cols.iter().map(|c| field(c, ',')).collect();
        out.push_str(&line.join(","));
        out.push_str("\r\n");
    }
    (out, rows.iter().map(|r| r.entry.id).collect())
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JiraWorklog {
    pub issue_key: String,
    /// Jira expects `yyyy-MM-dd'T'HH:mm:ss.SSSZ`.
    pub started: String,
    pub time_spent_seconds: i64,
    pub comment: String,
}

fn jira(rows: &[&TimeEntryRow], opts: &ExportOptions, skipped: &mut Vec<(i64, String)>) -> Result<(String, Vec<i64>)> {
    let mut logs = vec![];
    let mut ids = vec![];
    for r in rows {
        let specific = r.entry.vorgang_nr.as_ref().map(|v| format!("{}/{v}", r.netzplan_nr));
        let key = specific
            .as_ref()
            .and_then(|k| opts.jira_issue_map.get(k))
            .or_else(|| opts.jira_issue_map.get(&r.netzplan_nr));
        let Some(key) = key else {
            skipped
                .push((r.entry.id, format!("no Jira issue mapped for {}", specific.unwrap_or(r.netzplan_nr.clone()))));
            continue;
        };
        logs.push(JiraWorklog {
            issue_key: key.clone(),
            started: opts.local(r.entry.start_time).format("%Y-%m-%dT%H:%M:%S%.3f%z").to_string(),
            time_spent_seconds: r.entry.duration_minutes.unwrap_or(0) * 60,
            comment: r.entry.description.clone(),
        });
        ids.push(r.entry.id);
    }
    Ok((serde_json::to_string_pretty(&logs)?, ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, TimeEntry};
    use chrono::{TimeZone, Utc};

    fn row(id: i64, vorgang: Option<&str>, minutes: Option<i64>, desc: &str) -> TimeEntryRow {
        let start = Utc.with_ymd_and_hms(2026, 9, 22, 23, 30, 0).unwrap();
        TimeEntryRow {
            entry: TimeEntry {
                id,
                netzplan_id: 1,
                vorgang_nr: vorgang.map(Into::into),
                leistungsart: Some("DEV".into()),
                start_time: start,
                end_time: minutes.map(|m| start + chrono::Duration::minutes(m)),
                duration_minutes: minutes,
                description: desc.into(),
                status_flag: if minutes.is_some() { StatusFlag::Draft } else { StatusFlag::Running },
                source: EntrySource::Slash,
                page_id: None,
            },
            project_code: "PRJ-2026-X".into(),
            netzplan_nr: "NP-8801".into(),
            wbs_element: "NP-8801-1020".into(),
        }
    }

    #[test]
    fn cats_uses_local_date_and_german_decimals() {
        let rows = [row(1, Some("1020"), Some(150), "Systemintegration; Phase 1"), row(2, None, None, "running")];
        let opts =
            ExportOptions { pernr: Some("00012345".into()), utc_offset_minutes: Some(120), ..Default::default() };
        let r = export(&rows, ExportFormat::SapCats, &opts).unwrap();
        let line = r.content.lines().nth(1).unwrap();
        assert_eq!(line, "00012345;20260923;NP-8801-1020;NP-8801;1020;DEV;2,50;H;\"Systemintegration; Phase 1\"");
        assert_eq!(r.exported_ids, vec![1]);
        assert_eq!(r.skipped.len(), 1);
    }

    #[test]
    fn cats_delimiter_and_column_presets() {
        let rows = [row(1, Some("1020"), Some(90), "Abstimmung")];
        let opts = ExportOptions {
            pernr: Some("7".into()),
            utc_offset_minutes: Some(120),
            cats_delimiter: crate::prefs::CatsDelimiter::Tab,
            cats_columns: crate::prefs::CatsColumns::DateFirst,
            ..Default::default()
        };
        let r = export(&rows, ExportFormat::SapCats, &opts).unwrap();
        let mut lines = r.content.lines();
        assert_eq!(lines.next().unwrap(), "WORKDATE\tPERNR\tRNPLNR\tVORNR\tLSTAR\tCATSHOURS\tMEINH\tLTXA1\tRPROJ");
        assert_eq!(lines.next().unwrap(), "20260923\t7\tNP-8801\t1020\tDEV\t1,50\tH\tAbstimmung\tNP-8801-1020");
        // A comma separator quotes the German decimal.
        let opts = ExportOptions {
            cats_delimiter: crate::prefs::CatsDelimiter::Comma,
            cats_columns: crate::prefs::CatsColumns::WithoutWbs,
            utc_offset_minutes: Some(120),
            ..Default::default()
        };
        let r = export(&rows, ExportFormat::SapCats, &opts).unwrap();
        assert!(r.content.starts_with("PERNR,WORKDATE,RNPLNR,VORNR,LSTAR,CATSHOURS,MEINH,LTXA1\r\n"));
        assert!(r.content.contains(",\"1,50\",H,"), "{}", r.content);
    }

    #[test]
    fn jira_maps_vorgang_before_netzplan_and_skips_unmapped() {
        let rows =
            [row(1, Some("1020"), Some(90), "a"), row(2, Some("1030"), Some(30), "b"), row(3, None, Some(15), "c")];
        let mut opts = ExportOptions::default();
        opts.jira_issue_map.insert("NP-8801/1020".into(), "AET-12".into());
        let r = export(&rows, ExportFormat::JiraWorklog, &opts).unwrap();
        let logs: Vec<JiraWorklog> = serde_json::from_str(&r.content).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].started, "2026-09-22T23:30:00.000+0000");
        assert_eq!(logs[0].time_spent_seconds, 5400);
        assert_eq!(r.skipped.len(), 2);

        opts.jira_issue_map.insert("NP-8801".into(), "AET-1".into());
        let r = export(&rows, ExportFormat::JiraWorklog, &opts).unwrap();
        let logs: Vec<JiraWorklog> = serde_json::from_str(&r.content).unwrap();
        assert_eq!(logs.iter().map(|l| l.issue_key.as_str()).collect::<Vec<_>>(), ["AET-12", "AET-1", "AET-1"]);
    }

    #[test]
    fn formulas_are_defused() {
        let r =
            export(&[row(1, None, Some(60), "=HYPERLINK(\"x\")")], ExportFormat::SapCats, &ExportOptions::default())
                .unwrap();
        assert!(r.content.lines().nth(1).unwrap().ends_with(";\"'=HYPERLINK(\"\"x\"\")\""), "{}", r.content);
    }

    #[test]
    fn csv_quotes_fields() {
        let r =
            export(&[row(1, None, Some(60), "say \"hi\", ok")], ExportFormat::Csv, &ExportOptions::default()).unwrap();
        assert!(r.content.lines().nth(1).unwrap().ends_with(",1.00,\"say \"\"hi\"\", ok\",draft"));
    }
}
