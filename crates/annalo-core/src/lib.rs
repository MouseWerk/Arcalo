//! # annalo-core
//!
//! The platform-independent core of Annalo. Everything the UI shell needs
//! lives here so it can be tested headless and reused by the CLI:
//!
//! * [`db`] – embedded SQLite store (FTS5 full-text search, embeddings as BLOBs)
//! * [`notes`] – Markdown documents, backlinks, tags, daily notes
//! * [`properties`] – typed page properties: the schema child pages share, typed values, filters
//! * [`pagework`] – pages linked to a Vorgang (`vorgang:` property): budget and bookings
//! * [`trash`] – page trash (restore, purge, 30-day expiry)
//! * [`versions`] – page version history (snapshots, restore)
//! * [`backup`] – database snapshots (`VACUUM INTO`) with rotation
//! * [`mirror`] – Markdown mirror of the workspace (+ time entries as CSV), refreshed with each backup
//! * [`network`] – proxy (manual, system, PAC), extra root CA and timeouts for all connections
//! * [`prefs`] – user preferences (appearance, editor, notes, time, AI, notifications, …)
//! * [`gitsync`] – pushes the Markdown mirror to a Git remote (system `git`, token via environment)
//! * [`merge`] – three-way merge of notes by blocks (Git sync conflicts)
//! * [`calendar`] – month overview for the daily-note calendar (notes, booked time, due tasks)
//! * [`calsync`] – calendar sync: Outlook Classic (COM via PowerShell) and ICS files/subscriptions
//! * [`vault`] – Obsidian vault import / Markdown export
//! * [`linktitle`] – titles of web pages for pasted links
//! * [`attachments`] – pasted and imported images
//! * [`attachment_manager`] – the attachment manager: usage, safe renames, file trash
//! * [`drawings`] – Excalidraw drawings (scene + SVG preview) embedded in notes
//! * [`templates`] – page templates with `{{datum}}`-style placeholders
//! * [`settings`] – application settings
//! * [`tasks`] – task items across all notes (due dates, priorities)
//! * [`zeit`] – the `/zeit` slash-command parser
//! * [`tracking`] – timers, manual logging, budget/ETC alerts
//! * [`report`] – time summaries per Netzplan/Vorgang and day (status reports)
//! * [`netzplan`] – critical path method (CPM) over Vorgänge
//! * [`export`] – SAP PS (CATS), Jira worklog, CSV and JSON exports
//! * [`desktop`] – quick capture into the daily note, end-of-day reminders
//! * [`datadir`] – data folder location (`location.json`), synced-folder check
//! * [`update`] – auto-update gating (compiled-in key), release links, download progress
//! * [`activity`] – idle detection and active window probing (Win32 on Windows)
//! * [`feed`] – activity feed („Aktivität“): what happened when (pages, tasks, bookings, files)
//! * [`focus`] – focus sessions (Pomodoro) booked on a Vorgang
//! * [`weekplan`] – „Woche vorschlagen“: a timesheet draft of the week from meetings, focus and page edits
//! * [`ai`] – LiteLLM client, model router, token/cost metrics, local RAG

pub mod activity;
pub mod ai;
pub mod attachment_manager;
pub mod attachments;
pub mod backup;
pub mod calendar;
pub mod calsync;
pub mod datadir;
pub mod db;
pub mod demo;
pub mod desktop;
pub mod drawings;
pub mod error;
pub mod export;
pub mod feed;
pub mod focus;
pub mod gitsync;
pub mod linktitle;
pub mod merge;
pub mod mirror;
pub mod model;
pub mod network;
pub mod netzplan;
pub mod notes;
pub mod pagework;
pub mod prefs;
pub mod properties;
pub mod report;
pub mod search;
pub mod settings;
pub mod tasks;
pub mod templates;
pub mod tracking;
pub mod trash;
pub mod update;
pub mod vault;
pub mod versions;
pub mod weekplan;
pub mod zeit;

pub use db::Database;
pub use error::{Error, Result};
