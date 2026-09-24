//! `annalo` – headless access to an Annalo workspace database.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;

use annalo_core::db::EntryFilter;
use annalo_core::export::{self, ExportFormat, ExportOptions};
use annalo_core::model::StatusFlag;
use annalo_core::tracking::{self, AlertLevel, Thresholds};
use annalo_core::{Database, Result, demo, netzplan, search, zeit};
use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "annalo", version, about = "Annalo workspace from the command line")]
struct Cli {
    /// Workspace database file.
    #[arg(long, env = "ANNALO_DB", default_value = "annalo.db", global = true)]
    db: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Seed a sample project, Netzplan and notes.
    Demo,
    /// Book time: `annalo zeit NP-8801/1020 2.5h #DEV 'Systemintegration'`.
    Zeit {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        args: Vec<String>,
    },
    /// Start, stop or show the running timer.
    Timer {
        #[command(subcommand)]
        action: TimerCmd,
    },
    /// Projects and Netzpläne.
    Project {
        #[command(subcommand)]
        action: ProjectCmd,
    },
    /// Budget, booked hours and ETC for a Netzplan.
    Budget { netzplan: String },
    /// Critical path (FAZ/FEZ/SAZ/SEZ/GP/FP) of a Netzplan.
    Schedule { netzplan: String },
    /// Full-text search over notes and time logs.
    Search { query: Vec<String> },
    /// Import an Obsidian vault (folder of Markdown files).
    Import { dir: PathBuf },
    /// Write all pages as Markdown files into a folder.
    ExportVault { dir: PathBuf },
    /// Export time entries.
    Export {
        /// cats | jira | csv | json
        #[arg(long, short)]
        format: String,
        /// First day (inclusive), YYYY-MM-DD.
        #[arg(long)]
        from: Option<NaiveDate>,
        /// Last day (inclusive), YYYY-MM-DD.
        #[arg(long)]
        to: Option<NaiveDate>,
        /// SAP personnel number for CATS.
        #[arg(long)]
        pernr: Option<String>,
        /// JSON file mapping "NP-8801/1020" or "NP-8801" to Jira issue keys.
        #[arg(long)]
        jira_map: Option<PathBuf>,
        /// Flag exported entries as `exported`.
        #[arg(long)]
        mark: bool,
    },
}

#[derive(Subcommand)]
enum TimerCmd {
    /// `annalo timer start NP-8801/1020 [#DEV] [description…]`
    Start {
        target: String,
        rest: Vec<String>,
    },
    /// Stop the timer, optionally subtracting idle minutes.
    Stop {
        #[arg(long, default_value_t = 0)]
        idle: i64,
    },
    Status,
}

#[derive(Subcommand)]
enum ProjectCmd {
    List,
    Add {
        code: String,
        name: String,
    },
    /// Add a Netzplan to a project.
    AddNetzplan {
        project: String,
        netzplan_nr: String,
        wbs_element: String,
        #[arg(long, default_value = "")]
        description: String,
        #[arg(long, default_value_t = 0.0)]
        hours: f64,
    },
    /// Add a Vorgang to a Netzplan.
    AddVorgang {
        netzplan: String,
        vorgang_nr: String,
        #[arg(long, default_value = "")]
        description: String,
        #[arg(long, default_value_t = 1.0)]
        days: f64,
        #[arg(long, default_value_t = 0.0)]
        hours: f64,
        /// Comma-separated predecessor Vorgang numbers.
        #[arg(long, value_delimiter = ',')]
        after: Vec<String>,
    },
}

fn day_start(d: NaiveDate) -> DateTime<Utc> {
    let midnight = d.and_hms_opt(0, 0, 0).unwrap_or_default();
    Local.from_local_datetime(&midnight).earliest().map_or_else(|| midnight.and_utc(), |t| t.with_timezone(&Utc))
}

fn level_icon(l: AlertLevel) -> &'static str {
    match l {
        AlertLevel::Ok => "ok",
        AlertLevel::Warning => "WARN",
        AlertLevel::Critical => "CRIT",
        AlertLevel::Exceeded => "OVER",
    }
}

fn run(cli: Cli) -> Result<()> {
    let db = Database::open(&cli.db)?;
    let now = Utc::now();
    let t = Thresholds::default();

    match cli.cmd {
        Cmd::Demo => {
            if demo::seed_explicit(&db, now)? {
                println!("Demo workspace created in {}", cli.db.display());
            } else {
                println!("Workspace already has data; nothing seeded.");
            }
        }
        Cmd::Zeit { args } => {
            let mut line = args.join(" ");
            if !zeit::is_zeit_command(&line) {
                line = format!("/zeit {line}");
            }
            let out = tracking::log_slash_command(&db, &line, now, &Local, &t)?;
            let e = &out.entry;
            println!(
                "#{} gebucht: {:.2}h auf {}{} – {}",
                e.id,
                e.duration_minutes.unwrap_or(0) as f64 / 60.0,
                db.netzplan_by_id(e.netzplan_id)?.netzplan_nr,
                e.vorgang_nr.as_ref().map(|v| format!("/{v}")).unwrap_or_default(),
                e.description
            );
            for a in out.alerts {
                println!(
                    "  [{}] {}: {:.1}h von {:.1}h gebucht ({:.0}%), ETC {:.1}h, EAC {:.1}h",
                    level_icon(a.level),
                    a.label,
                    a.booked_hours,
                    a.planned_hours,
                    a.consumed * 100.0,
                    a.etc_hours,
                    a.eac_hours
                );
            }
        }
        Cmd::Timer { action } => match action {
            TimerCmd::Start { target, rest } => {
                let (np_ref, vorgang) = match target.split_once('/') {
                    Some((a, b)) => (a.to_owned(), Some(b.to_owned())),
                    None => (target, None),
                };
                let np = db.netzplan_by_ref(&np_ref)?;
                let la = rest.iter().find(|w| w.starts_with('#')).map(|w| w[1..].to_uppercase());
                let desc: Vec<_> = rest.iter().filter(|w| !w.starts_with('#')).cloned().collect();
                let e = db.start_timer(np.id, vorgang.as_deref(), la.as_deref(), &desc.join(" "), now)?;
                println!("Timer #{} läuft seit {}", e.id, e.start_time.with_timezone(&Local).format("%H:%M"));
            }
            TimerCmd::Stop { idle } => {
                let e = db.stop_timer(now, idle)?;
                println!("Timer #{} gestoppt: {} min gebucht", e.id, e.duration_minutes.unwrap_or(0));
            }
            TimerCmd::Status => match db.running_timer()? {
                Some(e) => println!(
                    "Timer #{} läuft seit {} min – {}",
                    e.id,
                    (now - e.start_time).num_minutes(),
                    e.description
                ),
                None => println!("Kein Timer aktiv."),
            },
        },
        Cmd::Project { action } => match action {
            ProjectCmd::List => {
                for p in db.list_projects()? {
                    println!("{}  {}", p.project_code, p.name);
                    for n in db.list_netzplaene(Some(p.id))? {
                        println!("  {}  {}  {} ({:.1}h)", n.netzplan_nr, n.wbs_element, n.description, n.planned_hours);
                        for v in db.list_vorgaenge(n.id)? {
                            println!(
                                "    {}  {} ({:.1}d, {:.1}h)",
                                v.vorgang_nr, v.description, v.duration_days, v.planned_hours
                            );
                        }
                    }
                }
            }
            ProjectCmd::Add { code, name } => {
                let p = db.create_project(&code, &name)?;
                println!("Projekt {} angelegt (#{})", p.project_code, p.id);
            }
            ProjectCmd::AddNetzplan { project, netzplan_nr, wbs_element, description, hours } => {
                let p = db.project_by_code(&project)?;
                let n = db.create_netzplan(p.id, &netzplan_nr, &wbs_element, &description, hours)?;
                println!("Netzplan {} angelegt (#{})", n.netzplan_nr, n.id);
            }
            ProjectCmd::AddVorgang { netzplan, vorgang_nr, description, days, hours, after } => {
                let n = db.netzplan_by_ref(&netzplan)?;
                let existing = db.list_vorgaenge(n.id)?;
                let preds: Vec<i64> = after
                    .iter()
                    .map(|a| {
                        existing
                            .iter()
                            .find(|v| &v.vorgang_nr == a)
                            .map(|v| v.id)
                            .ok_or_else(|| annalo_core::Error::not_found("vorgang", a.clone()))
                    })
                    .collect::<Result<_>>()?;
                let v = db.create_vorgang(n.id, &vorgang_nr, &description, days, hours)?;
                for p in preds {
                    db.link_vorgaenge(p, v.id)?;
                }
                println!("Vorgang {}/{} angelegt", n.netzplan_nr, v.vorgang_nr);
            }
        },
        Cmd::Budget { netzplan } => {
            let n = db.netzplan_by_ref(&netzplan)?;
            println!("{:<16} {:>8} {:>8} {:>8} {:>8} {:>6}  status", "element", "plan", "gebucht", "ETC", "EAC", "%");
            for s in tracking::budget_status(&db, n.id, &t)? {
                println!(
                    "{:<16} {:>8.1} {:>8.1} {:>8.1} {:>8.1} {:>5.0}%  {}",
                    s.label,
                    s.planned_hours,
                    s.booked_hours,
                    s.etc_hours,
                    s.eac_hours,
                    s.consumed * 100.0,
                    level_icon(s.level)
                );
            }
        }
        Cmd::Schedule { netzplan } => {
            let n = db.netzplan_by_ref(&netzplan)?;
            let s = netzplan::schedule(&db.list_vorgaenge(n.id)?)?;
            println!(
                "{:<8} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5}  vorgang",
                "nr", "D", "FAZ", "FEZ", "SAZ", "SEZ", "GP", "FP"
            );
            for x in &s.nodes {
                println!(
                    "{:<8} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5}  {}{}",
                    x.vorgang_nr,
                    x.duration,
                    x.faz,
                    x.fez,
                    x.saz,
                    x.sez,
                    x.gp,
                    x.fp,
                    x.description,
                    if x.critical { "  ◆ kritisch" } else { "" }
                );
            }
            let path: Vec<_> = s
                .critical_path
                .iter()
                .filter_map(|id| s.nodes.iter().find(|x| x.vorgang_id == *id).map(|x| x.vorgang_nr.as_str()))
                .collect();
            println!("\nProjektdauer: {} Tage, kritischer Pfad: {}", s.duration, path.join(" → "));
        }
        Cmd::Search { query } => {
            for hit in search::search(&db, &query.join(" "), 20)? {
                match hit {
                    search::SearchHit::Page { title, .. } => println!("[Seite] {title}"),
                    search::SearchHit::Note { title, snippet, .. } => println!("[Notiz] {title}: {snippet}"),
                    search::SearchHit::TimeEntry { netzplan_nr, vorgang_nr, snippet, .. } => println!(
                        "[Zeit]  {netzplan_nr}{}: {snippet}",
                        vorgang_nr.map(|v| format!("/{v}")).unwrap_or_default()
                    ),
                }
            }
        }
        Cmd::Import { dir } => {
            let r = annalo_core::vault::import_vault(&db, &dir, &attachments_dir(&cli.db))?;
            println!(
                "{} Seiten, {} Ordner, {} Bilder importiert ({} Dateien übersprungen)",
                r.pages, r.folders, r.attachments, r.skipped
            );
        }
        Cmd::ExportVault { dir } => {
            let n = annalo_core::vault::export_vault(&db, &dir, &attachments_dir(&cli.db))?;
            println!("{n} Markdown-Dateien nach {} geschrieben", dir.display());
        }
        Cmd::Export { format, from, to, pernr, jira_map, mark } => {
            let format = ExportFormat::parse(&format).ok_or_else(|| {
                annalo_core::Error::Parse(format!("unknown format '{format}' (cats, jira, csv, json)"))
            })?;
            let jira_issue_map: HashMap<String, String> = match jira_map {
                Some(p) => serde_json::from_str(&std::fs::read_to_string(p)?)?,
                None => HashMap::new(),
            };
            let filter = EntryFilter {
                from: from.map(day_start),
                to: to.and_then(|d| d.succ_opt()).map(day_start),
                ..Default::default()
            };
            let rows = db.list_time_entries(&filter)?;
            let opts = ExportOptions { pernr, jira_issue_map, utc_offset_minutes: None, ..Default::default() };
            let res = export::export(&rows, format, &opts)?;
            print!("{}", res.content);
            for (id, why) in &res.skipped {
                eprintln!("übersprungen #{id}: {why}");
            }
            if mark {
                let n = db.set_entry_status(&res.exported_ids, StatusFlag::Exported)?;
                eprintln!("{n} Einträge als exportiert markiert");
            }
        }
    }
    Ok(())
}

/// Attachments live next to the database, as in the desktop app.
fn attachments_dir(db: &std::path::Path) -> PathBuf {
    annalo_core::attachments::dir(db.parent().unwrap_or(std::path::Path::new(".")))
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Fehler: {e}");
            ExitCode::FAILURE
        }
    }
}
