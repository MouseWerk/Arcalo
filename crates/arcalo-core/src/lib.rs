//! # arcalo-core
//!
//! The platform-independent core of Arcalo. Everything the UI shell needs
//! lives here so it can be tested headless and reused by the CLI:
//!
//! * [`db`] – embedded SQLite store (FTS5 full-text search, embeddings as BLOBs)
//! * [`notes`] – Markdown documents, backlinks, tags, daily notes
//! * [`properties`] – typed page properties: the schema child pages share, typed values, filters
//! * [`pagework`] – pages linked to a Vorgang (`vorgang:` property): budget and bookings
//! * [`filing`] – folders & filing: where new pages go, rules, tidy-up, smart folders
//! * [`trash`] – page trash (restore, purge, 30-day expiry)
//! * [`versions`] – page version history (snapshots, restore)
//! * [`backup`] – database snapshots (`VACUUM INTO`) with rotation
//! * [`mirror`] – Markdown mirror of the workspace (+ time entries as CSV), refreshed with each backup
//! * [`network`] – proxy (manual, system, PAC), extra root CA and timeouts for all connections
//! * [`prefs`] – user preferences (appearance, editor, notes, time, AI, notifications, …)
//! * [`gitsync`] – pushes the Markdown mirror to a Git remote (system `git`, token via environment)
//! * [`merge`] – three-way merge of notes by blocks (Git sync conflicts)
//! * [`calendar`] – month overview for the daily-note calendar (notes, booked time, due tasks)
//! * [`dashboard`] – the start page's widgets: their data in one call, saved queries
//! * [`calsync`] – calendar sync: Outlook Classic (COM via PowerShell) and ICS files/subscriptions
//! * [`mail`] – „E-Mail als Aufgabe / Notiz“: Outlook, .eml/.msg and pasted mails, links back to the mail
//! * [`outlookcom`] – runs the bundled Outlook scripts (hidden PowerShell, timeout, JSON)
//! * [`mail`] – „E-Mail als Aufgabe / Notiz“: Outlook, .eml/.msg and pasted mails, links back to the mail
//! * [`outlookcom`] – runs the bundled Outlook scripts (hidden PowerShell, timeout, JSON)
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
//! * [`identity`] – the old internal names (Annalo, 1.14 and earlier): folder copy, fallbacks
//! * [`update`] – auto-update gating (compiled-in key), release links, download progress
//! * [`activity`] – idle detection and active window probing (Win32 on Windows)
//! * [`feed`] – activity feed („Aktivität“): what happened when (pages, tasks, bookings, files)
//! * [`focus`] – focus sessions (Pomodoro) booked on a Vorgang
//! * [`dayreview`] – „Tagesrückblick“: one day's pages, bookings, tasks, meetings, focus and files
//! * [`weekplan`] – „Woche vorschlagen“: a timesheet draft of the week from meetings, focus and page edits
//! * [`issues`] – issue trackers (Jira Cloud and Server): offline cache, keys in notes, worklogs
//! * [`ai`] – LiteLLM client, model router, token/cost metrics, local RAG

pub mod activity;
pub mod ai;
pub mod applock;
pub mod attachment_manager;
pub mod attachments;
pub mod backup;
pub mod backupdest;
pub mod bookmarks;
pub mod briefing;
pub mod calendar;
pub mod calsync;
pub mod canvas;
pub mod capture;
pub mod chats;
pub mod chips;
pub mod cipher;
pub mod companion;
pub mod dashboard;
pub mod datadir;
pub mod dayreview;
pub mod db;
pub mod demo;
pub mod desktop;
pub mod drawings;
pub mod duplicates;
pub mod embeds;
pub mod error;
pub mod export;
pub mod feed;
pub mod filing;
pub mod focus;
pub mod gitsync;
pub mod graph;
pub mod i18n;
pub mod identity;
pub mod issues;
pub mod linktitle;
pub mod mail;
pub mod meetwork;
pub mod mentions;
pub mod merge;
pub mod mirror;
pub mod model;
pub mod network;
pub mod netzplan;
pub mod nfc;
pub mod notes;
pub mod onboarding;
pub mod outlookcom;
pub mod pagework;
pub mod pdfmarks;
pub mod prefs;
pub mod properties;
pub mod rebrand;
pub mod recurrence;
pub mod report;
pub mod search;
pub mod semantic;
pub mod settings;
pub mod settings_layers;
pub mod settings_migrate;
pub mod settings_sync;
pub mod tagsuggest;
pub mod taskedit;
pub mod tasks;
pub mod templates;
pub mod timeblocks;
pub mod timer;
pub mod tracking;
pub mod trash;
pub mod update;
pub mod update_feed;
pub mod update_policy;
pub mod update_state;
pub mod vault;
pub mod versions;
pub mod voice;
pub mod weekplan;
pub mod weekreview;
pub mod worktime;
pub mod zeit;

pub use db::Database;
pub use error::{Error, Result};
