// Mirrors of the Rust types that cross the IPC boundary (serde snake_case).

export interface Page {
  id: number;
  parent_id: number | null;
  title: string;
  icon: string | null;
  position: number;
  updated_at: string;
  favorite: boolean;
  daily_date: string | null;
  /** Set while the page is in the trash. */
  deleted_at?: string | null;
}
export interface PageNode extends Page {
  children: PageNode[];
}
export interface Backlink {
  page_id: number;
  title: string;
  icon: string | null;
  context: string;
}
export interface PageDoc extends Page {
  content: string;
  tags: string[];
  backlinks: Backlink[];
  unresolved_links: string[];
}

export type SearchHit =
  | { kind: "page"; page_id: number; title: string; icon: string | null; score: number }
  | { kind: "note"; page_id: number; title: string; icon: string | null; snippet: string; score: number }
  | { kind: "time_entry"; id: number; netzplan_nr: string; vorgang_nr: string | null; snippet: string; score: number };

export type StatusFlag = "running" | "draft" | "released" | "exported";

export interface TimeEntry {
  id: number;
  netzplan_id: number;
  vorgang_nr: string | null;
  leistungsart: string | null;
  start_time: string;
  end_time: string | null;
  duration_minutes: number | null;
  description: string;
  status_flag: StatusFlag;
  source: "manual" | "timer" | "slash" | "auto";
  /** The page the entry was booked from (`/zeit` in a note). */
  page_id?: number | null;
}
export interface TimeEntryRow extends TimeEntry {
  project_code: string;
  netzplan_nr: string;
  wbs_element: string;
}

export interface Vorgang {
  id: number;
  netzplan_id: number;
  vorgang_nr: string;
  description: string;
  duration_days: number;
  planned_hours: number;
  remaining_hours: number | null;
  predecessors: number[];
}
export interface Netzplan {
  id: number;
  project_id: number;
  netzplan_nr: string;
  wbs_element: string;
  description: string;
  planned_hours: number;
}
export interface NetzplanTree extends Netzplan {
  vorgaenge: Vorgang[];
}
export interface Project {
  id: number;
  project_code: string;
  name: string;
  created_at: string;
}
export interface ProjectTree extends Project {
  netzplaene: NetzplanTree[];
}

export type AlertLevel = "ok" | "warning" | "critical" | "exceeded";
export interface BudgetStatus {
  label: string;
  netzplan_id: number;
  vorgang_nr: string | null;
  planned_hours: number;
  booked_hours: number;
  etc_hours: number;
  eac_hours: number;
  consumed: number;
  level: AlertLevel;
}
export interface ScheduleNode {
  vorgang_id: number;
  vorgang_nr: string;
  description: string;
  duration: number;
  faz: number;
  fez: number;
  saz: number;
  sez: number;
  gp: number;
  fp: number;
  critical: boolean;
}
export interface Schedule {
  nodes: ScheduleNode[];
  duration: number;
  critical_path: number[];
}

export interface LogOutcome {
  entry: TimeEntry;
  alerts: BudgetStatus[];
  /** Canonical reference, e.g. `NP-8801/1020`. */
  reference: string;
}
/** Budget and bookings of the Vorgang a page is linked to (`vorgang:` property). */
export interface PageWork {
  reference: string;
  label: string;
  netzplan_id: number | null;
  netzplan: string | null;
  vorgang: string | null;
  title: string;
  planned_hours: number;
  booked_hours: number;
  etc_hours: number;
  eac_hours: number;
  consumed: number;
  level: AlertLevel;
  entries: TimeEntry[];
  page_hours: number;
  error: string | null;
}
export interface TimerStatus {
  entry: TimeEntry;
  idle_minutes: number;
  is_idle: boolean;
}
export interface StopOutcome extends LogOutcome {
  idle_minutes: number;
  discarded: boolean;
}
export type ExportFormat = "sap_cats" | "jira_worklog" | "csv" | "json";
export interface ExportResult {
  content: string;
  exported_ids: number[];
  skipped: [number, string][];
}

export type Tier = "local" | "standard" | "reasoning";
/** A link at the top of the sidebar. */
export interface QuickLink {
  name: string;
  url: string;
  icon: string;
}

export interface RouterConfig {
  local_model: string;
  standard_model: string;
  reasoning_model: string;
  standard_threshold: number;
  reasoning_threshold: number;
  private_markers: string[];
}
export interface Settings {
  litellm_base_url: string;
  router: RouterConfig;
  auto_route: boolean;
  embedding_model: string | null;
  assistant_instructions: string;
  thresholds: { warning: number; critical: number };
  idle_threshold_minutes: number;
  pernr: string | null;
  jira_issue_map: Record<string, string>;
  theme: "system" | "light" | "dark";
  open_daily_on_start: boolean;
  daily_target_hours: number;
  workdays: number[];
  backup_dir: string | null;
  backup_keep: number;
  /** After every backup, write the workspace as Markdown files (+ time entries as CSV). */
  markdown_mirror: boolean;
  /** Mirror folder; null = `markdown` in the backup folder. */
  markdown_mirror_dir: string | null;
  /** Template page for new daily notes. */
  daily_template: number | null;
  /** Closing the main window hides it to the tray. */
  close_to_tray: boolean;
  /** End-of-day reminder `HH:MM`; null = off. */
  reminder_time: string | null;
  /** Global shortcut of the quick-capture window; "" = none. */
  capture_shortcut: string;
  /** Global shortcut of the command palette; null = none (the default). */
  palette_shortcut: string | null;
  /** Global shortcut of the quick-search window; "" = none. */
  search_shortcut: string;
  /** Widgets of the start page. */
  dashboard: Dashboard;
  quick_links: QuickLink[];
  /** Look for new releases at start and every 6 h (builds with an update key only). */
  auto_update_check: boolean;
  /** Developer log: also write debug lines (AI requests, syncs, backups). */
  dev_log_verbose: boolean;
  /** Push the Markdown mirror to a Git remote; the token lives in the credential store. */
  git_sync: GitSyncSettings;
  /** Proxy, extra root CA, timeouts; the proxy password lives in the credential store. */
  network: NetworkSettings;
  appearance: AppearancePrefs;
  editor: EditorPrefs;
  notes: NotesPrefs;
  time: TimePrefs;
  ai: AiPrefs;
  notifications: NotificationPrefs;
  privacy: PrivacyPrefs;
  start: StartPrefs;
  locale: LocalePrefs;
  /** In-app shortcuts that differ from the defaults: command id → "Ctrl+Shift+D" ("" = off). */
  keymap: Record<string, string>;
}
export type ProxyMode = "none" | "system" | "manual" | "pac";
export interface NetworkSettings {
  mode: ProxyMode;
  http_proxy: string;
  https_proxy: string;
  socks_proxy: string;
  no_proxy: string;
  pac_url: string;
  /** FindProxyForURL answers per host ("*" = the LiteLLM host, used for all others). */
  pac_results: Record<string, string>;
  proxy_user: string;
  extra_ca_path: string | null;
  accept_invalid_certs: boolean;
  timeout_secs: number;
  apply_to: { ai: boolean; git: boolean; updates: boolean; tools: boolean };
}
export interface AppearancePrefs {
  accent: string;
  ui_font: "system" | "inter";
  editor_font: "sans" | "serif" | "mono";
  code_font: "jetbrains" | "system";
  ui_scale: number;
  density: "compact" | "normal" | "comfortable";
  line_width: "narrow" | "normal" | "wide" | "full";
  reduce_motion: boolean;
  mica: boolean;
  custom_titlebar: boolean;
  startup_animation: boolean;
}
export interface EditorPrefs {
  spellcheck: "de" | "en" | "de-en" | "off";
  autosave_ms: number;
  smart_quotes: boolean;
  auto_pair: boolean;
  tab_size: number;
  code_line_numbers: boolean;
  hover_preview: boolean;
  hover_delay_ms: number;
  scroll_outline: boolean;
  default_icon: string | null;
  new_page_location: "top" | "current" | "inbox";
  inbox_title: string;
  toolbar: boolean;
}
export interface NotesPrefs {
  daily_title: "iso" | "de" | "long";
  daily_folder: string;
  trash_retention_days: number;
  version_interval_minutes: number;
  max_versions: number;
}
export interface TimePrefs {
  week_start: "monday" | "sunday";
  rounding: { step_minutes: number; mode: "up" | "nearest"; min_minutes: number };
  hours_display: "decimal" | "clock";
  default_leistungsart: Record<string, string>;
  cats_delimiter: "semicolon" | "comma" | "tab";
  cats_columns: "standard" | "without_wbs" | "date_first";
  export_file_pattern: string;
}
export interface AiPresetDef {
  label: string;
  instruction: string;
}
export interface AiPrefs {
  temperature: number;
  max_tokens: number | null;
  /** null = the built-in presets. */
  inline_presets: AiPresetDef[] | null;
  /** null = the built-in instruction. */
  meeting_template: string | null;
  monthly_cost_limit_usd: number | null;
  citations: boolean;
  streaming: boolean;
  allowed_tools: string[];
}
export interface NotificationPrefs {
  end_of_day: boolean;
  late_timer: boolean;
  budget: boolean;
  backup_failed: boolean;
  git_failed: boolean;
  updates: boolean;
  quiet_hours: boolean;
  quiet_from: string;
  quiet_to: string;
}
export interface PrivacyPrefs {
  read_open_page: boolean;
  local_only: boolean;
}
export interface StartPrefs {
  open: "tabs" | "dashboard" | "daily";
  restore_window: boolean;
  minimized: boolean;
}
export interface LocalePrefs {
  language: "de" | "en";
  date_format: "de" | "iso";
}
export interface SystemProxy {
  http: string | null;
  https: string | null;
  socks: string | null;
  bypass: string;
  pac_url: string | null;
  source: string;
}
export interface CaInfo {
  count: number;
  subject: string | null;
  not_after: string | null;
}
export interface NetworkStatus {
  password_set: boolean;
  system: SystemProxy;
  ca: CaInfo | null;
  ca_error: string | null;
  platform: string;
}
export interface NetworkTest {
  ok: boolean;
  url: string;
  /** Proxy used (without credentials); null = direct. */
  proxy: string | null;
  status: number | null;
  latency_ms: number;
  error: string | null;
}
export interface CostStatus {
  spent_usd: number;
  limit_usd: number | null;
  level: "ok" | "warning" | "blocked";
  fraction?: number;
}
export type GitSyncMode = "with_backup" | "hourly";
export interface GitSyncSettings {
  enabled: boolean;
  remote_url: string;
  branch: string;
  author_name: string;
  author_email: string;
  include_database: boolean;
  mode: GitSyncMode;
}
export interface GitSyncStatus {
  enabled: boolean;
  repo_path: string;
  last_at: string | null;
  last_commit: string | null;
  /** Branch of the last push (an `annalo-sync-…` branch after a fallback). */
  last_branch: string | null;
  last_error: string | null;
  pending_changes: number;
  token_set: boolean;
}
export interface GitSyncOutcome {
  commit: string | null;
  committed: boolean;
  changed_files: number;
  branch: string;
  fallback: boolean;
  message: string;
}
export interface GitTest {
  ok: boolean;
  latency_ms: number;
  branches: string[];
  error: string | null;
}
export type WidgetKind = "today" | "week" | "budgets" | "recent" | "favorites" | "timer" | "note" | "calendar";
export type WidgetSize = "s" | "m" | "l";
export interface Widget {
  id: string;
  kind: WidgetKind;
  size: WidgetSize;
}
export interface Dashboard {
  widgets: Widget[];
  /** Scratch text of the „Notiz“ widget. */
  note: string;
}
/** Payload of `search://open`: what the quick search asks the main window to show. */
export type SearchTarget = { kind: "page"; page_id: number; new_tab?: boolean } | { kind: "timesheet" } | { kind: "timer_stop" };
export interface DesktopInfo {
  autostart: boolean;
  autostart_available: boolean;
  tray: boolean;
  capture_shortcut_active: boolean;
  palette_shortcut_active: boolean;
  search_shortcut_active: boolean;
}
export interface CaptureOutcome {
  appended: { page_id: number; tasks: number; notes: number } | null;
  bookings: LogOutcome[];
}
export interface SettingsView {
  settings: Settings;
  api_key_set: boolean;
  api_key_storage: string;
  data_dir: string;
  /** Effective backup folder. */
  backup_dir: string;
  version: string;
}
export interface TrashEntry extends Page {
  deleted_at: string;
  /** Subpages deleted together with this page. */
  descendants: number;
  parent_title: string | null;
}
export interface BackupInfo {
  path: string;
  file_name: string;
  created_at: string;
  size_bytes: number;
}
export type DevLogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";
/** One line of the developer log (`logs/annalo.log`). */
export interface DevLogEntry {
  /** RFC 3339 with offset; "" for lines the app did not write itself. */
  time: string;
  level: DevLogLevel;
  source: string;
  message: string;
}
export interface DevLogStats {
  /** ERROR lines of the last 7 days. */
  errors_week: number;
  /** The log folder. */
  dir: string;
}
export interface MirrorStatus {
  enabled: boolean;
  /** Effective mirror folder. */
  path: string;
  last_at: string | null;
  error: string | null;
}
/** One day of the daily-note calendar. */
export interface DayOverview {
  date: string;
  note_id: number | null;
  has_note: boolean;
  booked_minutes: number;
  open_tasks: number;
}
export interface ConnectionTest {
  ok: boolean;
  latency_ms: number;
  models: string[];
  error: string | null;
}
export interface RouteDecision {
  tier: Tier;
  model: string;
  score: number;
  reasons: string[];
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface UsageRecord {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  ttft_ms: number | null;
  tokens_per_second: number | null;
}
export interface Completion {
  content: string;
  tool_calls: ToolCall[];
  finish_reason: string | null;
  usage: UsageRecord;
  exact_usage: boolean;
}
export interface ContextChunk {
  source: string;
  page_id: number | null;
  text: string;
  score: number;
  block_id: number | null;
  time_entry_id: number | null;
  /** Page title (null for time log entries). */
  title?: string | null;
  /** Headings above the chunk, `Plan › Netzplan`. */
  heading?: string | null;
}
/** A suggested reference for a `/zeit` line without one (smart /zeit). */
export interface ZeitGuess {
  reference: string;
  title: string;
  leistungsart: string | null;
  leistungsart_title: string | null;
  confidence: number;
  reason: string;
  /** The line with the reference inserted; booked on confirmation. */
  line: string;
}
export interface SessionMeter {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  last_ttft_ms: number | null;
  last_tokens_per_second: number | null;
}
export interface ChatOutcome {
  completion: Completion;
  route: RouteDecision;
  context: ContextChunk[];
  meter: SessionMeter;
  /** Share of the monthly cost limit used, once at least 80 %. */
  cost_warning?: number | null;
}
export type StreamEvent =
  | { type: "delta"; text: string; tokens_per_second: number | null }
  | { type: "first_token"; ttft_ms: number };
export type ToolPlan =
  | { risk: "workspace" }
  | { risk: "requires_approval"; call: unknown; summary: string };
export interface ImportReport {
  pages: number;
  folders: number;
  attachments: number;
  skipped: number;
  root_page_id: number;
}
export type TaskStatus = "open" | "done" | "all";
export interface Task {
  page_id: number;
  page_title: string;
  page_icon: string | null;
  /** Index among the page's task items; identifies the task for task_set_done. */
  ordinal: number;
  line: number;
  text: string;
  done: boolean;
  /** YYYY-MM-DD */
  due: string | null;
  /** 0 keine, 1 mittel (!), 2 hoch (!!) */
  priority: number;
  tags: string[];
}
export interface TaskFilter {
  status?: TaskStatus;
  due_before?: string | null;
  tag?: string | null;
  page_id?: number | null;
  /** Only tasks on pages saved since this local day (YYYY-MM-DD) or RFC 3339 time. */
  changed_since?: string | null;
}
export interface SavedAttachment {
  name: string;
  path: string;
  size: number;
  markdown: string;
}
/** A stored earlier state of a page (newest first in lists). */
export interface VersionInfo {
  id: number;
  page_id: number;
  created_at: string;
  /** Bytes. */
  size: number;
  preview: string;
}
export interface DataDirStatus {
  data_dir: string;
  /** Network share or OneDrive/Dropbox folder. */
  synced: boolean;
  /** Folder the workspace moves to on the next start. */
  pending_move: string | null;
  /** Result of a move or a fallback at startup. */
  notice: { kind: "info" | "warning" | "error"; message: string } | null;
}
export interface DataDirTarget {
  /** The folder already holds a workspace. */
  has_workspace: boolean;
  /** Network share or OneDrive/Dropbox folder. */
  synced: boolean;
}
export interface ActivityTick {
  idle_seconds: number | null;
  window: { title: string; process: string } | null;
  timer_idle_minutes: number | null;
  is_idle: boolean;
}

/** A newer release found by the updater. */
export interface UpdateInfo {
  version: string;
  /** Release notes (Markdown). */
  notes: string | null;
  date: string | null;
  /** Release page with the full changelog. */
  url: string;
}
export interface UpdateStatus {
  /** The build has an update key; otherwise updates are not set up. */
  enabled: boolean;
  current_version: string;
  available: UpdateInfo | null;
}
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  percent: number | null;
}
