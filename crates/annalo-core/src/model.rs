//! Plain data types shared by the store, the exporters and the UI.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: i64,
    pub project_code: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Netzplan {
    pub id: i64,
    pub project_id: i64,
    pub netzplan_nr: String,
    pub wbs_element: String,
    pub description: String,
    pub planned_hours: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Vorgang {
    pub id: i64,
    pub netzplan_id: i64,
    pub vorgang_nr: String,
    pub description: String,
    pub duration_days: f64,
    pub planned_hours: f64,
    pub remaining_hours: Option<f64>,
    /// IDs of the direct predecessors.
    pub predecessors: Vec<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusFlag {
    Running,
    Draft,
    Released,
    Exported,
}

impl StatusFlag {
    pub fn as_str(self) -> &'static str {
        match self {
            StatusFlag::Running => "running",
            StatusFlag::Draft => "draft",
            StatusFlag::Released => "released",
            StatusFlag::Exported => "exported",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "running" => StatusFlag::Running,
            "draft" => StatusFlag::Draft,
            "released" => StatusFlag::Released,
            "exported" => StatusFlag::Exported,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntrySource {
    Manual,
    Timer,
    Slash,
    Auto,
}

impl EntrySource {
    pub fn as_str(self) -> &'static str {
        match self {
            EntrySource::Manual => "manual",
            EntrySource::Timer => "timer",
            EntrySource::Slash => "slash",
            EntrySource::Auto => "auto",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "manual" => EntrySource::Manual,
            "timer" => EntrySource::Timer,
            "slash" => EntrySource::Slash,
            "auto" => EntrySource::Auto,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeEntry {
    pub id: i64,
    pub netzplan_id: i64,
    pub vorgang_nr: Option<String>,
    pub leistungsart: Option<String>,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
    pub duration_minutes: Option<i64>,
    pub description: String,
    pub status_flag: StatusFlag,
    pub source: EntrySource,
    /// The page the entry was booked from (`/zeit` in a note).
    #[serde(default)]
    pub page_id: Option<i64>,
}

/// A time entry joined with its full WBS context, as needed by exporters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeEntryRow {
    #[serde(flatten)]
    pub entry: TimeEntry,
    pub project_code: String,
    pub netzplan_nr: String,
    pub wbs_element: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewTimeEntry {
    pub netzplan_id: i64,
    pub vorgang_nr: Option<String>,
    pub leistungsart: Option<String>,
    pub start_time: DateTime<Utc>,
    pub duration_minutes: i64,
    pub description: String,
    pub source: EntrySource,
    #[serde(default)]
    pub page_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Page {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub title: String,
    /// Lucide icon name, e.g. `file-text`.
    pub icon: Option<String>,
    pub position: i64,
    pub updated_at: String,
    pub favorite: bool,
    /// Set for daily notes (`YYYY-MM-DD`).
    pub daily_date: Option<String>,
    /// Set while the page is in the trash.
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// A page with its children, for the sidebar tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageNode {
    #[serde(flatten)]
    pub page: Page,
    pub children: Vec<PageNode>,
}
