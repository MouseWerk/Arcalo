//! `arcalo` – the Arcalo workspace from the command line, for people, scripts and AI agents
//! (docs/cli.md). Every command calls the functions the app uses; it works on the app's workspace
//! (found as the app finds it) while the app runs: writes wait for the app's, run in one
//! transaction, and are recorded for the app, which shows them without a restart
//! (`arcalo_core::external`). `--json` prints one JSON value per command; exit codes in
//! [`output::Failure`].

mod keystore;
mod misc;
mod model;
mod output;
mod pages;
mod tasks;
mod time;
mod wbs;
mod workspace;

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

use crate::output::{Failure, Out, Outcome};
use crate::workspace::Workspace;

#[derive(Parser)]
#[command(
    name = "arcalo",
    version,
    about = "Arcalo from the command line: pages, tasks, daily notes, time and settings of the app's workspace",
    after_help = "Pages are named by id (id:42), exact title or path (Projekte/Alpha). With --json every command prints one JSON value; errors go to stderr. Exit codes: 0 ok, 1 usage, 2 not found, 3 conflict or locked, 4 other. See docs/cli.md."
)]
struct Cli {
    /// Workspace database file (default: the app's workspace).
    #[arg(long, env = "ARCALO_DB", global = true)]
    db: Option<PathBuf>,
    /// The app's data folder (default: where the app keeps it; also ARCALO_DATA_DIR).
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    /// Print one JSON value instead of text; errors as a JSON object on stderr.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// The workspace: where it is, its version and what it holds.
    Info,
    /// Pages: list, show, create, change, move, trash, versions, links.
    #[command(subcommand, alias = "page")]
    Pages(PagesCmd),
    /// The daily note of a day.
    #[command(subcommand)]
    Daily(DailyCmd),
    /// Tasks (`- [ ]` items) of all pages.
    #[command(subcommand, alias = "task")]
    Tasks(TasksCmd),
    /// Tags and the pages that carry them.
    #[command(subcommand, alias = "tag")]
    Tags(TagsCmd),
    /// Full-text search over notes and time logs.
    Search {
        query: Vec<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Appointments of the synced calendars.
    #[command(subcommand)]
    Calendar(CalendarCmd),
    /// Time entries: list, change, delete, the week.
    #[command(subcommand)]
    Time(TimeCmd),
    /// Absence days (vacation, sick, …).
    #[command(subcommand, alias = "absence")]
    Absences(AbsenceCmd),
    /// Files in the attachments folder.
    #[command(subcommand, alias = "attachment")]
    Attachments(AttachCmd),
    /// The trash of pages.
    #[command(subcommand)]
    Trash(TrashCmd),
    /// Settings, read and changed by key (`editor.autosave_ms`).
    #[command(subcommand)]
    Settings(SettingsCmd),
    /// Seed a sample project, Netzplan and notes.
    Demo,
    /// Book time: `arcalo zeit NP-8801/1020 2.5h #DEV 'Systemintegration'`.
    Zeit {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        args: Vec<String>,
    },
    /// Start, stop or show the running timer.
    Timer {
        #[command(subcommand)]
        action: TimerCmd,
    },
    /// Projects, Netzpläne and Vorgänge.
    Project {
        #[command(subcommand)]
        action: ProjectCmd,
    },
    /// Budget, booked hours and ETC for a Netzplan.
    Budget { netzplan: String },
    /// Critical path (FAZ/FEZ/SAZ/SEZ/GP/FP) of a Netzplan.
    Schedule { netzplan: String },
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
        from: Option<chrono::NaiveDate>,
        /// Last day (inclusive), YYYY-MM-DD.
        #[arg(long)]
        to: Option<chrono::NaiveDate>,
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

/// Markdown given on the command line, from a file or from standard input.
#[derive(Args, Default)]
pub struct Body {
    /// The Markdown text.
    #[arg(long, short = 'b', allow_hyphen_values = true, conflicts_with_all = ["file", "stdin"])]
    pub body: Option<String>,
    /// Read the Markdown from a file.
    #[arg(long, short = 'f', conflicts_with = "stdin")]
    pub file: Option<PathBuf>,
    /// Read the Markdown from standard input.
    #[arg(long)]
    pub stdin: bool,
}

#[derive(Subcommand)]
pub enum PagesCmd {
    /// Pages as a flat list (tree order).
    List {
        /// Only the pages directly below this one.
        #[arg(long)]
        parent: Option<String>,
        /// The pages in the trash instead.
        #[arg(long)]
        trash: bool,
    },
    /// The page tree (from a page or the top level).
    Tree { root: Option<String> },
    /// A page's Markdown (with --json: the page, its content, tags and links).
    Show {
        page: String,
        /// Title, path and tags above the Markdown.
        #[arg(long)]
        meta: bool,
    },
    /// Create a page (a taken title gets a number, as in the app).
    Create {
        title: String,
        /// The page (folder) to create it in; default: the top level.
        #[arg(long, short = 'p', visible_alias = "folder")]
        parent: Option<String>,
        #[command(flatten)]
        body: Body,
        /// Lucide icon name (default: the one of Settings → Editor).
        #[arg(long)]
        icon: Option<String>,
    },
    /// Append Markdown at the end of a page.
    Append {
        page: String,
        /// The Markdown, quoted (instead of --body, --file or --stdin).
        #[arg(allow_hyphen_values = true)]
        text: Option<String>,
        #[command(flatten)]
        body: Body,
    },
    /// Replace a page's text (its properties stay unless --whole).
    Replace {
        page: String,
        #[command(flatten)]
        body: Body,
        /// Replace the whole Markdown, properties (frontmatter) included.
        #[arg(long)]
        whole: bool,
    },
    /// A page's properties (frontmatter).
    Props { page: String },
    /// Set a property: `arcalo pages set Projekt status erledigt`, a list as `[a, b]`.
    Set { page: String, key: String, value: String },
    /// Remove a property.
    Unset { page: String, key: String },
    /// Rename a page; links to it in other pages follow (as in the app).
    Rename {
        page: String,
        title: String,
        /// Leave the links in other pages as they are.
        #[arg(long)]
        keep_links: bool,
    },
    /// Move a page below another one (`--to /` for the top level).
    Move {
        page: String,
        #[arg(long)]
        to: String,
        /// Place among the new siblings (0 = first; default: last).
        #[arg(long)]
        position: Option<i64>,
    },
    /// Copy a page next to it.
    Duplicate {
        page: String,
        /// Title of the copy (default: „<title> (Kopie)“).
        #[arg(long)]
        title: Option<String>,
    },
    /// Move a page and its subpages to the trash.
    Delete { page: String },
    /// Put a page from the trash back.
    Restore { page: String },
    /// Delete a page for good (from the trash; with --now also a page outside it).
    Purge {
        page: String,
        #[arg(long)]
        now: bool,
    },
    /// Earlier versions of a page.
    Versions { page: String },
    /// The Markdown of a version.
    Version { id: i64 },
    /// Put a version back (the current text is kept as a version first).
    RestoreVersion { page: String, version: i64 },
    /// The pages a page links to.
    Links { page: String },
    /// The pages that link to a page.
    Backlinks { page: String },
}

#[derive(Subcommand)]
pub enum DailyCmd {
    /// The daily note's Markdown (created when missing, as when the app opens it).
    Show {
        /// YYYY-MM-DD, today, yesterday or tomorrow (default: today).
        #[arg(long, short = 'd')]
        date: Option<String>,
    },
    /// Create the daily note (returns the existing one).
    Create {
        #[arg(long, short = 'd')]
        date: Option<String>,
    },
    /// Append Markdown below „Notizen“ of the daily note (like quick capture), else at its end.
    Append {
        /// The Markdown, quoted (instead of --body, --file or --stdin).
        #[arg(allow_hyphen_values = true)]
        text: Option<String>,
        #[command(flatten)]
        body: Body,
        #[arg(long, short = 'd')]
        date: Option<String>,
        /// Another section (`## Name`) to append to.
        #[arg(long)]
        section: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum TasksCmd {
    /// Tasks of all pages: open first, by due date and priority.
    List {
        /// open, done or all.
        #[arg(long, default_value = "open")]
        status: String,
        /// Due on this day (YYYY-MM-DD, today, tomorrow).
        #[arg(long)]
        due: Option<String>,
        /// Due on or before this day.
        #[arg(long)]
        due_before: Option<String>,
        /// Due before today.
        #[arg(long)]
        overdue: bool,
        #[arg(long)]
        tag: Option<String>,
        #[arg(long)]
        page: Option<String>,
        #[arg(long)]
        limit: Option<usize>,
    },
    /// Add a task to a page or a daily note.
    Add {
        /// The task's text, quoted.
        #[arg(allow_hyphen_values = true)]
        text: String,
        /// The page (default: today's daily note).
        #[arg(long, conflicts_with = "daily")]
        page: Option<String>,
        /// The daily note of this day (YYYY-MM-DD, today, tomorrow).
        #[arg(long)]
        daily: Option<String>,
        /// Due date (YYYY-MM-DD, today, tomorrow).
        #[arg(long)]
        due: Option<String>,
        /// 0 none, 1 medium, 2 high.
        #[arg(long)]
        priority: Option<u8>,
    },
    /// Check a task off (a repeating one gets its next occurrence, as in the app).
    Done(TaskAt),
    /// Open a done task again.
    Undone(TaskAt),
    /// Change a task's text, due date, priority or repeat rule, or move it to another page.
    Edit {
        #[command(flatten)]
        at: TaskAt,
        /// New text (due date, priority and repeat rule stay unless given).
        #[arg(long)]
        text: Option<String>,
        /// YYYY-MM-DD, today, tomorrow, or none.
        #[arg(long)]
        due: Option<String>,
        #[arg(long)]
        priority: Option<u8>,
        /// A repeat rule (`weekly`, `every:monthly`) or none.
        #[arg(long)]
        repeat: Option<String>,
        /// Move the task (with its subtasks) to this page.
        #[arg(long)]
        move_to: Option<String>,
    },
    /// Delete a task (with its subtasks).
    Delete(TaskAt),
}

/// A task: its page and its number among the page's tasks (`ordinal` of `tasks list`).
#[derive(Args)]
pub struct TaskAt {
    pub page: String,
    pub ordinal: i64,
    /// The task's text as last seen: refuses when the task changed meanwhile.
    #[arg(long)]
    pub expect: Option<String>,
}

#[derive(Subcommand)]
pub enum TagsCmd {
    /// All tags with the number of pages.
    List,
    /// The pages with a tag.
    Pages { tag: String },
}

#[derive(Subcommand)]
pub enum CalendarCmd {
    /// Appointments from one day to another (default: today and the next 6 days).
    Events {
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
    },
    /// Today's appointments.
    Today,
}

#[derive(Subcommand)]
pub enum TimeCmd {
    /// Time entries of a range (default: this week).
    List {
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
    },
    /// Change a time entry.
    Edit {
        id: i64,
        /// Duration: 1.5h, 90m, 1:30.
        #[arg(long)]
        duration: Option<String>,
        /// Start: YYYY-MM-DDTHH:MM (local time) or HH:MM on its day.
        #[arg(long)]
        start: Option<String>,
        #[arg(long)]
        description: Option<String>,
        /// Vorgang number (none to remove).
        #[arg(long)]
        vorgang: Option<String>,
        /// Leistungsart (none to remove).
        #[arg(long)]
        activity_type: Option<String>,
    },
    /// Delete a time entry (its chip in the note is marked as deleted).
    Delete { id: i64 },
    /// Booked and target hours per day of a week.
    Week {
        /// A day of the week (default: today).
        #[arg(long, short = 'd')]
        date: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum AbsenceCmd {
    /// Absences and public holidays of a range (default: this year).
    List {
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
    },
    /// Enter an absence (a range gets the working days).
    Add {
        from: String,
        to: Option<String>,
        /// vacation, sick, comp or other.
        #[arg(long, default_value = "vacation")]
        kind: String,
        /// A half day.
        #[arg(long)]
        half: bool,
        #[arg(long, default_value = "")]
        note: String,
    },
    /// Remove the absences of a range.
    Delete { from: String, to: Option<String> },
}

#[derive(Subcommand)]
pub enum AttachCmd {
    /// Files with size and the pages that use them.
    List,
    /// Copy a file into the attachments folder; with --page also embed it there.
    Add {
        file: PathBuf,
        #[arg(long)]
        page: Option<String>,
    },
    /// Copy an attachment out to a file or folder.
    Export { name: String, to: PathBuf },
}

#[derive(Subcommand)]
pub enum TrashCmd {
    /// Pages in the trash.
    List,
    /// Delete everything in the trash for good.
    Empty,
}

#[derive(Subcommand)]
pub enum SettingsCmd {
    /// All settings, or one key (`notes.trash_retention_days`).
    Get { key: Option<String> },
    /// Change one key (the value as JSON, or as text); checked like a save in the app.
    Set { key: String, value: String },
}

#[derive(Subcommand)]
pub enum TimerCmd {
    /// `arcalo timer start NP-8801/1020 [#DEV] [description…]`
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
pub enum ProjectCmd {
    /// Projects with their Netzpläne and Vorgänge.
    List,
    Add {
        code: String,
        name: String,
    },
    /// Rename a project.
    Edit {
        code: String,
        #[arg(long)]
        name: String,
    },
    /// Delete a project (refused while it has bookings).
    Delete {
        code: String,
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
    /// Change a Netzplan.
    EditNetzplan {
        netzplan: String,
        #[arg(long)]
        wbs_element: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        hours: Option<f64>,
    },
    /// Delete a Netzplan (refused while it has bookings).
    DeleteNetzplan {
        netzplan: String,
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
    /// Change a Vorgang (`NP-8801/1020`).
    EditVorgang {
        vorgang: String,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        days: Option<f64>,
        #[arg(long)]
        hours: Option<f64>,
        /// Remaining hours estimated by hand (none to remove).
        #[arg(long)]
        remaining: Option<String>,
    },
    /// Delete a Vorgang (`NP-8801/1020`).
    DeleteVorgang {
        vorgang: String,
    },
}

/// What a command needs: the workspace and how to print.
pub struct Ctx {
    pub ws: Workspace,
    pub out: Out,
}

fn run(cli: Cli, out: Out) -> Outcome<()> {
    // `demo` and `import` start a workspace where none is yet; the others need one.
    let create = matches!(cli.cmd, Cmd::Demo | Cmd::Import { .. });
    let ws = Workspace::open(workspace::locate(cli.db, cli.data_dir), create)?;
    let ctx = Ctx { ws, out };
    match cli.cmd {
        Cmd::Info => misc::info(&ctx),
        Cmd::Pages(c) => pages::run(&ctx, c),
        Cmd::Daily(c) => pages::daily(&ctx, c),
        Cmd::Tasks(c) => tasks::run(&ctx, c),
        Cmd::Tags(c) => pages::tags(&ctx, c),
        Cmd::Search { query, limit } => misc::search(&ctx, &query.join(" "), limit),
        Cmd::Calendar(c) => misc::calendar(&ctx, c),
        Cmd::Time(c) => time::run(&ctx, c),
        Cmd::Absences(c) => time::absences(&ctx, c),
        Cmd::Attachments(c) => misc::attachments(&ctx, c),
        Cmd::Trash(c) => pages::trash(&ctx, c),
        Cmd::Settings(c) => misc::settings(&ctx, c),
        Cmd::Demo => misc::demo(&ctx),
        Cmd::Zeit { args } => time::zeit(&ctx, &args),
        Cmd::Timer { action } => time::timer(&ctx, action),
        Cmd::Project { action } => wbs::project(&ctx, action),
        Cmd::Budget { netzplan } => wbs::budget(&ctx, &netzplan),
        Cmd::Schedule { netzplan } => wbs::schedule(&ctx, &netzplan),
        Cmd::Import { dir } => misc::import(&ctx, &dir),
        Cmd::ExportVault { dir } => misc::export_vault(&ctx, &dir),
        Cmd::Export { format, from, to, pernr, jira_map, mark } => {
            time::export(&ctx, time::ExportArgs { format, from, to, pernr, jira_map, mark })
        }
    }
}

/// The first words of the command line that make the app's program (`arcalo`, `Arcalo.exe`) the
/// command line instead of starting the app: the commands and the options of [`Cli`].
pub fn is_command_line(args: &[OsString]) -> bool {
    use clap::CommandFactory;
    let Some(first) = args.get(1).and_then(|a| a.to_str()) else { return false };
    let cmd = Cli::command();
    let command = cmd.get_subcommands().any(|c| c.get_name() == first || c.get_all_aliases().any(|a| a == first));
    let option = ["--json", "--db", "--data-dir", "--help", "-h", "--version", "-V", "help"]
        .iter()
        .any(|o| first == *o || first.starts_with(&format!("{o}=")));
    command || option
}

/// Runs the command line with `args` (the program name first).
pub fn main_with(args: Vec<OsString>) -> ExitCode {
    // `ANNALO_DB` of 1.14 and earlier still names the database when `ARCALO_DB` is not set.
    if std::env::var_os("ARCALO_DB").is_none()
        && let Some(db) = arcalo_core::identity::env_os("ARCALO_DB")
    {
        // SAFETY: still single-threaded, before anything else reads the environment.
        unsafe { std::env::set_var("ARCALO_DB", db) };
    }
    workspace::init_language();
    let json = args.iter().any(|a| a == "--json");
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(e) if !e.use_stderr() => {
            // --help, --version
            let _ = e.print();
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            if json {
                return Out { json }.fail(&Failure::Usage(e.render().to_string().trim().to_owned()));
            }
            let _ = e.print();
            return ExitCode::from(1);
        }
    };
    let out = Out { json: cli.json };
    match run(cli, out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(f) => out.fail(&f),
    }
}

/// The command line (`arcalo`, and `annalo` as the name of 1.14 and earlier).
pub fn main() -> ExitCode {
    main_with(std::env::args_os().collect())
}
