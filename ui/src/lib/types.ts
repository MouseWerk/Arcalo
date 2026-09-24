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

/** Typed page properties (`properties.rs`); `kind` and `value` as in lib/collection.ts. */
export interface PropSchema {
  props: { key: string; kind: import("./collection").PropKind; options: { name: string; color: string }[] }[];
}
/** What `page_save` returns: what the save derived (the content is the caller's). */
export interface SavedPage {
  id: number;
  updated_at: string;
  tags: string[];
  unresolved_links: string[];
}
export interface CollectionRow extends Page {
  /** The frontmatter block with its `---` lines (the views derive the cells from it). */
  frontmatter: string;
}
export interface PageCollection {
  parent_id: number;
  schema: PropSchema | null;
  rows: CollectionRow[];
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
/** Budget and schedule of one Netzplan (`netzplan_overview`); `schedule` is null for a cycle. */
export interface NetzplanOverview {
  netzplan_id: number;
  budget: BudgetStatus[];
  schedule: Schedule | null;
}
/** What the assistant's suggestions are built from (`suggestion_facts`). */
export interface SuggestionFacts {
  open_tasks: number;
  overdue: number;
  due_today: number;
  page_open_tasks: number;
  worst_budget: string | null;
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
  /** Provider ids of the tiers ("" = the first provider). */
  local_provider: string;
  standard_provider: string;
  reasoning_provider: string;
  standard_threshold: number;
  reasoning_threshold: number;
  private_markers: string[];
}
/** litellm: LiteLLM proxy; openai: any OpenAI-compatible API; azure: Azure OpenAI (deployments, api-version, api-key); ollama: local Ollama. */
export type ProviderKind = "litellm" | "openai" | "azure" | "ollama";
/** An AI provider (Settings → KI). Its key lives in the credential store under its id. */
export interface AiProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  /** May receive private content; costs nothing. */
  local: boolean;
  enabled: boolean;
  /** Connect directly, not through the proxy of Settings → Netzwerk. */
  bypass_proxy: boolean;
  /** Azure OpenAI: api-version. */
  api_version: string;
  /** Model (Azure: deployment) names added by hand. */
  models: string[];
}
/** Price per 1M tokens in USD for a model (`*` at the end = prefix) on one provider or any (""). */
export interface PriceRule {
  provider: string;
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
}
export interface Settings {
  litellm_base_url: string;
  providers: AiProvider[];
  router: RouterConfig;
  auto_route: boolean;
  embedding_model: string | null;
  /** Provider of the embedding model. */
  embedding_provider: string;
  prices: PriceRule[];
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
/** The main colors of a color theme (`#rrggbb`); lib/themes.ts derives the other tokens. */
export interface ThemeColors {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}
export interface CustomTheme {
  /** `custom-…`; empty for a new one (the core assigns it when saving). */
  id: string;
  name: string;
  dark: boolean;
  colors: ThemeColors;
}
export interface AppearancePrefs {
  /** `theme` (the color theme's accent), a preset id or `#rrggbb`. */
  accent: string;
  theme_light: string;
  theme_dark: string;
  custom_themes: CustomTheme[];
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
  /** The last sync stopped before deleting this many notes on the server ("Löschungen übertragen"). */
  blocked_deletions?: number | null;
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
export type WidgetKind = "today" | "week" | "budgets" | "recent" | "favorites" | "timer" | "note" | "calendar" | "focus";
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
  /** Portable mode: no autostart entry. */
  portable?: boolean;
}
export interface CaptureOutcome {
  appended: { page_id: number; tasks: number; notes: number } | null;
  bookings: LogOutcome[];
}
export interface SettingsView {
  settings: Settings;
  api_key_set: boolean;
  api_key_storage: string;
  /** Ids of the providers with a stored key. */
  provider_keys: string[];
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
  /** Why the log file cannot be written, if it cannot (full or read-only disk). */
  write_error?: string | null;
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
/** One step of a provider's connection test; ok null = skipped. */
export interface ProviderTestStep {
  id: "reach" | "auth" | "chat" | "tools" | "embed";
  ok: boolean | null;
  detail: string;
  latency_ms: number;
}
export interface ProviderTest {
  steps: ProviderTestStep[];
  models: string[];
  model: string | null;
}
export interface OllamaDetect {
  found: boolean;
  url: string;
  version: string | null;
  models: string[];
}
export interface PullProgress {
  request_id: string;
  status: string;
  total: number | null;
  completed: number | null;
}
export interface RouteDecision {
  tier: Tier;
  /** Id of the provider the request went to. */
  provider?: string;
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
  /** Notes cut because of their size, files read as Windows-1252. */
  warnings?: string[];
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
  notice: { kind: "info" | "warning" | "error"; message: string; title?: string } | null;
  /** Portable mode: the data folder is fixed next to the executable. */
  portable?: boolean;
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
  /** Portable copy: new versions are downloaded from the release page, not installed. */
  portable?: boolean;
}
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  percent: number | null;
}

// ---- focus sessions ----
export interface FocusSession {
  id: number;
  netzplan_id: number | null;
  vorgang_nr: string | null;
  /** `NP-8801/1020`; "" without Vorgang. */
  reference: string;
  goal: string;
  started_at: string;
  planned_minutes: number;
  break_minutes: number;
  ended_at: string | null;
  status: "running" | "done" | "aborted";
  worked_minutes: number;
  booked_minutes: number;
  entry_id: number | null;
  break_until: string | null;
}
export interface FocusOutcome {
  session: FocusSession;
  entry: TimeEntry | null;
  extended: boolean;
}
/** A desktop notification held back during a session. */
export interface HeldNotification {
  title: string;
  body: string;
}
export interface FocusState {
  session: FocusSession;
  phase: "work" | "break";
  ends_at: string;
  /** The session ran out meanwhile (app closed) and was completed by this call. */
  completed: FocusOutcome | null;
  held?: HeldNotification[];
}
export interface FocusDone extends FocusOutcome {
  held: HeldNotification[];
}
export interface FocusShare {
  reference: string;
  sessions: number;
  minutes: number;
}
export interface FocusReport {
  sessions: number;
  minutes: number;
  by_reference: FocusShare[];
}

// ---- activity feed ----
export type ActivityKind =
  | "page_created"
  | "page_edited"
  | "task_added"
  | "task_done"
  | "entry_created"
  | "entry_changed"
  | "entry_released"
  | "entry_exported"
  | "file_added"
  | "focus_session"
  | "backup"
  | "sync";
export interface Activity {
  id: number;
  at: string;
  kind: ActivityKind;
  page_id: number | null;
  page_title: string | null;
  page_icon: string | null;
  entry_id: number | null;
  netzplan_id: number | null;
  reference: string | null;
  project_code: string | null;
  title: string;
  detail: string;
  amount: number;
  count: number;
  people: string[];
}
export interface FeedFilter {
  from?: string | null;
  to?: string | null;
  kinds?: ActivityKind[];
  project_id?: number | null;
  netzplan_id?: number | null;
  vorgang_nr?: string | null;
  person?: string | null;
  query?: string | null;
  limit?: number | null;
}
export interface FeedSummary {
  pages_edited: number;
  tasks_done: number;
  tasks_added: number;
  booked_minutes: number;
  focus_sessions: number;
  focus_minutes: number;
}

// ---- attachment manager ----
export type AttachmentKind = "image" | "drawing" | "pdf" | "other";
export interface PageUse {
  id: number;
  title: string;
  /** The page is in the trash. */
  trashed: boolean;
}
export interface AttachmentInfo {
  name: string;
  kind: AttachmentKind;
  /** Bytes; a drawing counts scene and preview. */
  size: number;
  modified: string | null;
  /** SVG preview of a drawing. */
  preview: string | null;
  used_in: PageUse[];
}
export interface AttachmentList {
  files: AttachmentInfo[];
  total_size: number;
}
export interface RenameOutcome {
  name: string;
  /** Pages whose embeds were rewritten. */
  pages: number[];
}
export interface TrashedFile {
  id: string;
  name: string;
  size: number;
  deleted_at: string;
}

// ---- git sync conflicts ----
export interface GitConflictInfo {
  page_id: number;
  title: string;
  path: string;
  at: string;
}
export type MergeChunk =
  | { kind: "stable"; text: string }
  | { kind: "merged"; text: string; from: "mine" | "theirs" | "both" }
  | { kind: "conflict"; base: string | null; mine: string; theirs: string };
export interface GitConflictView {
  page_id: number;
  title: string;
  at: string;
  base: string | null;
  mine: string;
  theirs: string;
  merge: { chunks: MergeChunk[]; conflicts: number };
}
export interface GitPulled {
  pages: number[];
  created: number[];
  trashed: number[];
  conflicts: number[];
  /** Pages the server deleted, kept here because there were too many at once. */
  kept?: number[];
}
