// Mirrors of the Rust types that cross the IPC boundary (serde snake_case).

import type { BackupTargets } from "./backupdest";

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
  /** `canvas` for a canvas page (JSON Canvas content); absent for a note. */
  kind?: string | null;
}
export interface PageNode extends Page {
  children: PageNode[];
  created_at?: string;
  /** A folder of the filing (its type, or `rule`). */
  system?: string | null;
  /** Sort and color of the folder's children (Ordner & Ablage). */
  style?: import("./filing").FolderStyle | null;
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
  /** Address or path; empty for a group. */
  url: string;
  icon: string;
  /** Missing on links (and on everything saved before 1.5). */
  kind?: "link" | "app" | "group";
  /** A group's icon color (`blau`, `grün`, …). */
  color?: string;
  /** A group's links and programs. */
  items?: QuickLink[];
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
  /** Version of the stored shape (written by the core). */
  version?: number;
  /** Shareable sections this workspace decided for (see `SettingsView.scopes`). */
  workspace_scopes?: Record<string, SettingsScope>;
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
  /** Further folders (network shares, cloud folders) that receive a copy of every backup. */
  backup_targets: BackupTargets;
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
  /** Calendar sync; subscription addresses live in the credential store. */
  calendar: CalendarSettings;
  /** Quick capture: default target, inbox page, „Auswahl übernehmen“, auto-hide. */
  capture: CapturePrefs;
  /** „E-Mail als Aufgabe / Notiz“ (Settings → Kalender → E-Mail). */
  mail: MailSettings;
  /** Sprachnotizen: Whisper model and source, language, input device, summary, audio. */
  voice?: VoiceSettings;
  /** First-run intro and setup (saved by its own commands, kept by `settings_save`). */
  onboarding: OnboardingState;
  /** Jira sites, saved JQL searches and the sync (tokens live in the credential store). */
  jira?: import("./jira").IssueSettings;
  /** Morgen-Briefing (briefing.rs); missing in settings of older versions. */
  briefing?: BriefingSettings;
  /** Ordner & Ablage: folder and granularity per page type, rules. */
  filing?: import("./filing").FilingSettings;
  /** Look for new releases at start and every 6 h (builds with an update key only). */
  auto_update_check: boolean;
  /** Settings → Über → Updates (an organization's policy can override them). */
  updates?: UpdatePrefs;
  /** Developer log: also write debug lines (AI requests, syncs, backups). */
  dev_log_verbose: boolean;
  /** Developer log level (`error` … `trace`); "": `dev_log_verbose` decides. */
  dev_log_level?: string;
  /** Developer log: also JSON lines in `logs/annalo.jsonl`. */
  dev_log_json?: boolean;
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
export interface OnboardingState {
  /** The intro version completed (e.g. "1.6.0"). */
  completed_version: string | null;
  completed_at: string | null;
}
export interface OnboardingStatus extends OnboardingState {
  /** Play the intro and the setup (fresh install). */
  intro: boolean;
  /** One-time hint for a workspace from before the intro. */
  whats_new: boolean;
  /** One-time notice of the rename to Arcalo (a workspace from before 1.7). */
  rebrand_notice?: boolean;
  existing: boolean;
}
export type ProxyMode = "none" | "system" | "manual" | "pac";
/** A named way out (Settings → Netzwerk): proxy, exceptions, extra root CAs, timeouts. */
export interface ProxyProfile {
  /** `[a-z0-9-]`, stable; `standard` is the default profile. Empty for a new one (the core assigns it). */
  id: string;
  name: string;
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
  connect_timeout_secs: number;
  /** 0 = the service's own (downloads 60 s). */
  read_timeout_secs: number;
  /** The global "accept invalid certificates" of 1.9, kept until converted ("unsicher"). */
  legacy_accept_invalid_certs: boolean;
}
/** „Diesem Server vertrauen“: host plus SHA-256 of its certificate. */
export interface TrustedHost {
  host: string;
  sha256: string;
  spki_sha256: string;
  subject: string | null;
  not_after: string | null;
}
export interface NetworkSettings {
  profiles: ProxyProfile[];
  /** Service key (`ai:<id>`, `jira:<id>`, `updates`, …) or group → profile id; missing = default profile. */
  routes: Record<string, string>;
  trusted_hosts: TrustedHost[];
}
export interface RouteInfo {
  profile_id: string;
  profile_name: string;
  mode: ProxyMode;
  proxy: string | null;
  pac_answer: string | null;
  bypassed: boolean;
  insecure: boolean;
}
export type ServiceGroup = "updates" | "release_notes" | "voice_models" | "ai" | "jira" | "git_sync" | "ics" | "link_preview" | "http_tool";
export interface ServiceRow {
  key: string;
  group: ServiceGroup;
  /** Provider, site or calendar name. */
  name: string;
  /** Scheme and host of the target; null = no fixed target. */
  target: string | null;
  route: RouteInfo;
  locked: boolean;
}
export interface CertDetails {
  host: string;
  sha256: string;
  spki_sha256: string;
  subject: string | null;
  issuer: string | null;
  not_after: string | null;
  self_signed: boolean;
}
export interface LegacyProbe {
  host: string;
  valid: boolean;
  certificate: CertDetails | null;
  error: string | null;
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
  /** Window backdrop (Windows 11); elsewhere the window stays opaque. */
  window_effect: "none" | "mica" | "acrylic";
  /** How much the theme covers the backdrop, in percent (40–100). */
  window_opacity: number;
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
  link_suggestions: boolean;
  mention_hints: boolean;
  tag_suggestions: boolean;
  duplicate_hints: boolean;
}
export interface NotesPrefs {
  daily_title: "iso" | "de" | "long";
  daily_folder: string;
  trash_retention_days: number;
  version_interval_minutes: number;
  max_versions: number;
}
export interface TimePrefs {
  /** „Zeiterfassung verwenden“: off hides the timesheet, projects and their commands. */
  enabled: boolean;
  week_start: "monday" | "sunday";
  rounding: { step_minutes: number; mode: "up" | "nearest"; min_minutes: number };
  hours_display: "decimal" | "clock";
  default_leistungsart: Record<string, string>;
  cats_delimiter: "semicolon" | "comma" | "tab";
  cats_columns: "standard" | "without_wbs" | "date_first";
  export_file_pattern: string;
  /** Overtime balance, vacation account and public holidays (1.7). */
  balance?: BalancePrefs;
  /** Working hours `HH:MM` (1.11): free slots for focus blocks lie inside them. */
  work_start?: string;
  work_end?: string;
}
export interface BalancePrefs {
  /** Target hours Monday..Sunday; empty: the daily target on the workdays. */
  weekday_hours: number[];
  /** YYYY-MM-DD; null: 1 January of the current year. */
  start: string | null;
  opening_hours: number;
  vacation_days: number;
  carry_over: number;
  /** BY, NW, …; empty: no public holidays. */
  state: string;
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
  /** How long the assistant's chats are kept. */
  chat_history?: ChatRetention;
}
export interface NotificationPrefs {
  end_of_day: boolean;
  late_timer: boolean;
  budget: boolean;
  backup_failed: boolean;
  git_failed: boolean;
  updates: boolean;
  week_proposal: boolean;
  /** „Tagesrückblick ansehen“ once a workday at `day_review_time`. */
  day_review: boolean;
  day_review_time: string;
  /** Tasks due today, from 09:00 (with „Erledigt“, „Schlummern“, „Öffnen“). */
  task_due?: boolean;
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
  date_format: "de" | "iso" | "en-gb" | "en-us";
  /** Decimal separator: comma (1.234,5) or point (1,234.5). */
  /** Unset: as the display language writes numbers. */
  number_format?: "comma" | "point";
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
  /** The default profile has a stored password. */
  password_set: boolean;
  /** Ids of the profiles with a stored password. */
  passwords: string[];
  system: SystemProxy;
  platform: string;
  /** What an organization's policy fixes: service key or group → profile id, locked profiles. */
  policy: { routes: Record<string, string>; lock_profiles: boolean; origins: string[] };
}
export interface NetworkTest {
  ok: boolean;
  url: string;
  /** Proxy used (without credentials); null = direct. */
  proxy: string | null;
  route: RouteInfo | null;
  status: number | null;
  latency_ms: number;
  error: string | null;
  /** The server's certificate when the error is about it. */
  certificate: CertDetails | null;
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
  /** Also sync the settings (no secrets, nothing machine-specific). */
  sync_settings?: boolean;
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
/** A widget of the start page before 1.6 (one list, three widths). */
export interface LegacyWidget {
  id: string;
  kind: string;
  size: "s" | "m" | "l";
}
/** A widget on a board: place and size in the 12-column grid, own title and settings. */
export interface GridWidget {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  config?: Record<string, unknown>;
}
export interface Board {
  id: string;
  name: string;
  widgets: GridWidget[];
}
export interface Dashboard {
  /** 2 since 1.6 (boards); 0 before. */
  version: number;
  boards: Board[];
  active: string;
  /** Texts of the „Notiz“ widgets by widget id. */
  notes: Record<string, string>;
  /** Before 1.6 (moved onto a board by the start page); missing when never saved. */
  widgets?: LegacyWidget[] | null;
  note?: string;
}
/** Payload of `search://open`: what the quick search asks the main window to show. */
export type SearchTarget = { kind: "page"; page_id: number; new_tab?: boolean } | { kind: "timesheet" } | { kind: "timer_stop" } | { kind: "issues" } | { kind: "issue"; key: string } | { kind: "graph" };
export interface DesktopInfo {
  autostart: boolean;
  autostart_available: boolean;
  tray: boolean;
  capture_shortcut_active: boolean;
  palette_shortcut_active: boolean;
  search_shortcut_active: boolean;
  selection_shortcut_active?: boolean;
  /** Milliseconds from the last quick-capture request to its first frame. */
  capture_open_ms?: number | null;
  mail_shortcut_active?: boolean;
  voice_shortcut_active?: boolean;
  /** Portable mode: no autostart entry. */
  portable?: boolean;
  /** The Microsoft Store build: autostart is the package's startup task. */
  store?: boolean;
}
export interface CaptureOutcome {
  appended: { page_id: number; tasks: number; notes: number; title: string; created: boolean } | null;
  bookings: LogOutcome[];
  /** Id in the recent captures (undo). */
  id?: number | null;
  /** The database could not take it now: stored and retried. */
  queued?: boolean;
}
/** Where a quick capture goes (`annalo_core::capture::CaptureTarget`). */
export type CaptureTarget =
  | { kind: "daily" }
  | { kind: "inbox" }
  | { kind: "page"; page_id: number }
  | { kind: "new_page"; title: string }
  | { kind: "meeting"; key: string };
export interface CapturePrefs {
  default_target: "daily" | "inbox" | "last";
  inbox_title: string;
  /** Global shortcut „Auswahl übernehmen“; "" = off. */
  selection_shortcut: string;
  auto_hide_ms: number;
  meeting_target: boolean;
}
export interface RecentCapture {
  id: number;
  at: string;
  page_id: number | null;
  title: string;
  preview: string;
  bookings: number;
  undo_until: string;
}
export interface CaptureContext {
  meeting: { key: string; title: string; start: string; end: string; note_page_id: number | null } | null;
  recent: RecentCapture[];
  queued: number;
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
  /** Per shareable section (appearance, ai, filing, jira, dashboard): shared or own. */
  scopes?: Record<string, SettingsScope>;
  /** Whether sections can be shared with the other workspaces on this computer. */
  shared?: boolean;
  /** The last settings sync that changed settings here. */
  sync_last?: SettingsSyncMerge | null;
}
/** „Für alle Arbeitsbereiche“ or „Nur dieser Arbeitsbereich“. */
export type SettingsScope = "global" | "workspace";
export interface SettingsSyncMerge {
  /** ms since the epoch. */
  at: number;
  host: string;
  changes: { key: string; before: unknown; after: unknown }[];
  undone: boolean;
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
export type DevLogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
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
  /** The level lines are written at now. */
  level?: DevLogLevel;
  /** `ANNALO_LOG`, when it overrides the setting. */
  level_env?: string | null;
}
/** Where the secrets are kept (Settings → Datenschutz). */
export interface SecretStoreStatus {
  /** `native`: Windows Credential Manager / macOS keychain; `secret_service`: Linux keyring; `file`: secrets.json. */
  kind: "native" | "secret_service" | "file";
  label: string;
  /** Why the file is used (the system's words), when it is. */
  reason?: string | null;
  /** secrets.json still exists next to a credential store. */
  file_left: boolean;
  migration?: { moved: number; kept: string[]; error?: string | null } | null;
  portable: boolean;
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
  /** The models that compute embeddings (by the provider's word, else by name). */
  embedding_models: string[];
  error: string | null;
}
/** Whether the configured embedding model is used by the assistant's search, and why not. */
export interface EmbeddingStatus {
  model: string | null;
  provider: string;
  usable: boolean;
  reason: string | null;
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
  /** The turn touched private content (marker, „Nur lokal“, private chat). */
  private?: boolean;
}
export type StreamEvent =
  | { type: "delta"; text: string; tokens_per_second: number | null }
  | { type: "first_token"; ttft_ms: number }
  /** The server is briefly busy (cooldown): the same model is asked again after `seconds`. */
  | { type: "waiting"; seconds: number; model: string };
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
  /** Where `latest.json` came from („GitHub“, an internal server or share). */
  source?: string;
}
export interface UpdateStatus {
  /** The build has an update key; otherwise updates are not set up. */
  enabled: boolean;
  current_version: string;
  available: UpdateInfo | null;
  /** Portable copy: new versions are downloaded from the release page, not installed. */
  portable?: boolean;
  /** Installed as .deb/.rpm: the package manager updates it, the release page has the package. */
  package?: boolean;
  /** The Microsoft Store build: the Store updates it (`enabled` is false, no rollback). */
  store?: boolean;
  /** Reported once after a start that followed an update: the version, and whether it runs now. */
  restarted?: { version: string; installed: boolean; from?: string } | null;
  /** What applies: the organization's policy over the settings (`managed` lists the locked fields). */
  policy?: UpdatePolicy;
  policy_origins?: string[];
  /** The install window allows installing now. */
  install_now?: boolean;
  skipped?: string | null;
  remind_after?: string | null;
  bad_versions?: string[];
  whats_new_seen?: string | null;
  download?: UpdateDownload;
  /** A downloaded, verified update that installs when Arcalo quits. */
  ready?: string | null;
  /** „Zur vorherigen Version zurückkehren“ is possible. */
  rollback?: { from: string; to: string; created: string } | null;
  /** Reported once after a rollback. */
  rolled_back?: { from: string; to: string; database: boolean } | null;
}
export type UpdateMode = "auto" | "notify" | "off";
export type UpdateManagedField = "mode" | "source" | "github" | "pinned" | "window" | "interval";
export interface UpdatePolicy {
  mode: UpdateMode;
  /** The organization switched updates off: not even a manual check. */
  disabled: boolean;
  source_url: string | null;
  allow_github_fallback: boolean;
  pinned_version: string | null;
  /** `18:00–07:00` */
  install_window: string | null;
  check_interval_hours: number;
  managed: UpdateManagedField[];
}
export interface UpdateDownload {
  phase: "idle" | "downloading" | "paused" | "ready" | "failed";
  downloaded: number;
  total: number | null;
  percent: number | null;
  error: string | null;
}
export interface UpdatePrefs {
  mode: UpdateMode;
  source_url: string;
  allow_github_fallback: boolean;
  check_interval_hours: number;
  restore_session: boolean;
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
  /** The focus block it was started from. */
  block_id?: number | null;
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
  /** A canvas: decided as a whole (mine, theirs or both), never merged by text. */
  canvas?: boolean;
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

// ---- calendar sync (Kalender)

export interface IcsSource {
  id: string;
  name: string;
  kind: "url" | "file";
  path: string;
  color: string;
  enabled: boolean;
}
/** Settings → Sprachnotizen. */
export interface VoiceSettings {
  /** `base`, `small` or `large-v3-turbo-q5`. */
  model: string;
  /** Admin source tried first: an address or a network folder with the model files ("" = none). */
  source_url: string;
  /** `auto`, `de` or `en`. */
  language: string;
  /** Input device name ("" = system default). */
  input_device: string;
  /** Windows: record the system audio too. */
  system_audio: boolean;
  auto_summary: boolean;
  keep_audio: boolean;
  /** Global shortcut that starts or stops a recording; "" = off. */
  shortcut: string;
}

/** Settings → Kalender → E-Mail (Outlook). */
export interface MailSettings {
  /** Top-level page of new mail notes. */
  notes_parent: string;
  /** Global shortcut of „Aktuelle E-Mail übernehmen“; "" = off. */
  shortcut: string;
  /** Attachments are ticked when the dialog opens. */
  save_attachments: boolean;
  /** Mail notes get the first privacy marker as tag (they stay on the local model). */
  private_notes: boolean;
  /** What the dialog offers first. */
  default_action: "task" | "note" | "both";
  /** The user's own addresses and names: left out of follow-up mails. */
  own_addresses?: string[];
}
/** Where an Outlook calendar lives. */
export type OutlookKind = "own" | "file" | "mailbox" | "shared" | "room" | "group";
/** An Outlook calendar chosen once in „Kalender auswählen“. */
export interface OutlookCalendar {
  /** `outlook` (default calendar) or `outlook:<hash>`. */
  id: string;
  store_id: string;
  entry_id: string;
  recipient: string;
  name: string;
  /** Mailbox, store or person. */
  owner: string;
  path: string;
  kind: OutlookKind;
  default: boolean;
  /** Only free/busy times are readable. */
  free_busy: boolean;
  color: string;
  enabled: boolean;
  /** „Für Buchungsvorschläge verwenden“. */
  booking: boolean;
}
/** A row of „Kalender auswählen“ (stored or only discovered). */
export interface OutlookCalendarRow extends OutlookCalendar {
  stored: boolean;
  /** Found by the last discovery; null before one. */
  found: boolean | null;
  items: number | null;
  error: string | null;
  shared: boolean;
  status: CalendarSyncStatus | null;
  syncing: boolean;
}
export interface OutlookDiscovery {
  running: boolean;
  at: string | null;
  error: string | null;
}
export interface CalendarSettings {
  /** Read Outlook Classic (Windows): the selected calendars. */
  outlook: boolean;
  /** Color of the default calendar. */
  outlook_color: string;
  outlook_calendars?: OutlookCalendar[];
  /** People whose calendars discovery opens by name. */
  outlook_recipients?: string[];
  sources: IcsSource[];
  sync_minutes: number;
  past_days: number;
  future_days: number;
  /** Keep subject, place and attendees of private appointments. */
  private_details: boolean;
  /** Keep the text of appointments. */
  include_body: boolean;
  /** Keep a Teams/Zoom/Webex link found in the text. */
  meeting_links: boolean;
  /** Write focus blocks to the default Outlook calendar. */
  blocks_outlook?: boolean;
  /** Length of a block dropped into the Kalender (minutes). */
  block_minutes?: number;
}
export type Busy = "free" | "tentative" | "busy" | "oof" | "elsewhere";
export interface CalendarEvent {
  /** `source|uid|instance`. */
  key: string;
  source: string;
  uid: string;
  instance: string;
  recurring: boolean;
  /** RFC 3339 (UTC). */
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  location: string;
  organizer: string;
  attendees: string[];
  body: string | null;
  link: string | null;
  busy: Busy;
  private: boolean;
  categories: string[];
  /** Marked „nicht buchen“. */
  skip: boolean;
  note_page_id: number | null;
  /** The time entry booked from this appointment. */
  entry_id: number | null;
  /** Other selected calendars with the same meeting (shown once). */
  also_in?: string[];
}
export interface CalendarSyncStatus {
  source: string;
  synced_at: string | null;
  attempted_at: string | null;
  error: string | null;
  events: number;
}
export interface CalendarSourceInfo {
  /** `outlook`, `outlook:<hash>` or `ics:<id>`. */
  id: string;
  name: string;
  kind: "outlook" | "url" | "file";
  /** Mailbox or person of an Outlook calendar. */
  owner: string;
  /** Someone else's calendar. */
  shared: boolean;
  free_busy: boolean;
  /** Its meetings are proposed for booking. */
  booking: boolean;
  color: string;
  enabled: boolean;
  /** Scheme and host of a subscription. */
  address: string;
  url_set: boolean;
  path: string;
  status: CalendarSyncStatus | null;
  syncing: boolean;
}
export interface CalendarStatus {
  outlook_available: boolean;
  sources: CalendarSourceInfo[];
  secret_storage: string;
  /** „Kalender auswählen“. */
  outlook_calendars: OutlookCalendarRow[];
  discovery: OutlookDiscovery;
}
export interface WbsHint {
  netzplan_id: number;
  vorgang_nr: string | null;
  leistungsart: string | null;
  reference: string;
}

// ---- Woche vorschlagen
export type ProposalSourceKind = "calendar" | "focus" | "block" | "page";
export type ProposalConfidence = "none" | "low" | "medium" | "high";
export interface ProposalSource {
  kind: ProposalSourceKind;
  /** Event key, focus session id or page id. */
  id: string;
  label: string;
}
export interface WbsGuess {
  netzplan_id: number;
  vorgang_nr: string | null;
  leistungsart: string | null;
  reference: string;
  confidence: ProposalConfidence;
  basis: "learned" | "link" | "history" | "similar";
  reason: string;
}
export interface Proposal {
  id: string;
  /** Local day, YYYY-MM-DD. */
  date: string;
  start: string;
  minutes: number;
  text: string;
  kind: ProposalSourceKind;
  wbs: WbsGuess | null;
  confidence: ProposalConfidence;
  reason: string;
  sources: ProposalSource[];
}
export interface ProposalDay {
  date: string;
  workday: boolean;
  target_minutes: number;
  booked_minutes: number;
  proposed_minutes: number;
  gap_minutes: number;
  capped_minutes: number;
  started: boolean;
}
export interface WeekProposal {
  week_start: string;
  days: ProposalDay[];
  proposals: Proposal[];
  until: string;
  step_minutes: number;
}
export interface AcceptedProposal {
  start: string;
  minutes: number;
  text: string;
  netzplan_id: number;
  vorgang_nr: string | null;
  leistungsart: string | null;
  sources: ProposalSource[];
  wbs_changed: boolean;
  original_text: string;
}
export interface AppliedProposals {
  entry_ids: number[];
  alerts: BudgetStatus[];
}

// ---- Tagesrückblick (dayreview.rs)
export interface DayReview {
  date: string;
  from: string;
  to: string;
  daily_note_id: number | null;
  pages: ReviewPage[];
  time: ReviewTime;
  tasks: ReviewTasks;
  meetings: ReviewMeeting[];
  focus: { minutes: number; sessions: ReviewFocusSession[] };
  files: ReviewFile[];
  /** Time tracking is off: no time section, gaps or booking states (meetings over are `done`). */
  without_time?: boolean;
}
export interface ReviewPage {
  page_id: number | null;
  title: string;
  icon: string | null;
  gone: boolean;
  created: boolean;
  daily: boolean;
  edits: number;
  chars: number;
  minutes: number;
  first_at: string;
  last_at: string;
  word_delta: number | null;
}
export interface ReviewTime {
  target_minutes: number;
  workday: boolean;
  booked_minutes: number;
  running_minutes: number;
  missing_minutes: number;
  items: ReviewWbs[];
  entries: ReviewEntry[];
  gaps: { start: string; end: string; minutes: number }[];
}
export interface ReviewWbs {
  label: string;
  project_code: string;
  netzplan_id: number;
  vorgang_nr: string | null;
  title: string;
  minutes: number;
  entries: number;
  descriptions: string[];
}
export interface ReviewEntry {
  id: number;
  label: string;
  start: string;
  end: string;
  minutes: number;
  description: string;
  status: string;
}
export interface ReviewTasks {
  done: ReviewTask[];
  added: ReviewTask[];
  due: ReviewTask[];
  overdue: ReviewTask[];
  done_total: number;
  added_total: number;
  due_total: number;
  overdue_total: number;
}
export interface ReviewTask {
  page_id: number | null;
  page_title: string;
  text: string;
  at: string | null;
  due: string | null;
  done: boolean;
}
export type MeetingState = "booked" | "skipped" | "open" | "upcoming" | "free" | "done";
export interface ReviewMeeting {
  key: string;
  source: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  minutes: number;
  state: MeetingState;
  entry_id: number | null;
  note_page_id: number | null;
}
export interface ReviewFocusSession {
  id: number;
  reference: string;
  goal: string;
  started_at: string;
  worked_minutes: number;
  status: string;
  entry_id: number | null;
}
export interface ReviewFile {
  name: string;
  kind: string;
  at: string;
}

// ---- assistant chat history ----
export type ChatRetention = "all" | "90" | "30" | "off";
export interface ChatConversation {
  id: number;
  title: string;
  title_custom: boolean;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  archived: boolean;
  private: boolean;
  provider: string;
  model: string;
  tier: string;
  page_ids: number[];
  messages: number;
  /** Search hit, the match between \u0002 and \u0003. */
  snippet: string | null;
}
/** A message to save (and as saved, with `id`, `seq`, `created_at`). */
export interface ChatRecord {
  role: "user" | "assistant" | "tool";
  content: string;
  display?: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
  tool?: { name: string; label: string; status: string; summary?: string; output?: string } | null;
  citations?: ContextChunk[] | null;
  provider?: string;
  model?: string;
  tier?: string;
  reasons?: string[] | null;
  meta?: { model: string; ttft: number | null; tps: number | null; exact: boolean } | null;
  tokens?: number;
  cost_usd?: number;
  error?: string | null;
  cancelled?: boolean;
  in_context?: boolean;
  page_title?: string | null;
}
export interface StoredChatRecord extends ChatRecord {
  id: number;
  seq: number;
  created_at: string;
}
export interface ChatConversationDoc {
  conversation: ChatConversation;
  messages: StoredChatRecord[];
}

// ---- focus blocks (time blocking)

/** What a focus block is for. */
export type BlockLink =
  | { kind: "none" }
  | { kind: "task"; page_id: number; ordinal: number; text: string }
  | { kind: "issue"; key: string }
  | { kind: "page"; page_id: number };

export interface FocusBlock {
  id: number;
  title: string;
  start: string;
  end: string;
  link: BlockLink;
  netzplan_id: number | null;
  vorgang_nr: string | null;
  /** Set on the block (`NP-8801/1020`), "" without one. */
  reference: string;
  /** The block's reference, else the issue's mapped WBS or the page's `vorgang:`. */
  suggested_reference: string | null;
  page_title: string | null;
  task_done: boolean | null;
  issue_summary: string | null;
  issue_status: string | null;
  issue_url: string | null;
  outlook: "none" | "pending" | "written";
  outlook_error: string | null;
  outlook_entry_id: string | null;
  entry_id: number | null;
  focus_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface NewBlock {
  title?: string;
  start: string;
  end: string;
  link?: BlockLink;
  reference?: string;
}

export interface BlockPatch {
  title?: string;
  start?: string;
  end?: string;
  reference?: string;
}
// ---- Morgen-Briefing (briefing.rs)
export type BriefingMode = "off" | "start" | "notify";
export type BriefingSectionId = "ai" | "meetings" | "tasks" | "jira" | "time";
export interface BriefingSection {
  id: BriefingSectionId;
  on: boolean;
}
export interface BriefingSettings {
  mode: BriefingMode;
  /** HH:MM; empty: at the first start of the day. */
  notify_time: string;
  sections: BriefingSection[];
  /** „Besprechung vorbereiten“ by itself before meetings with two or more attendees. */
  prep_auto?: boolean;
  /** Minutes before the start (5 to 240). */
  prep_minutes?: number;
}
export interface BriefingPrep {
  page_id: number;
  title: string;
  kind: "own" | "series" | "subject";
  at: string;
}
export interface BriefingMeeting {
  key: string;
  source: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  link: string | null;
  free: boolean;
  past: boolean;
  note_page_id: number | null;
  prep: BriefingPrep | null;
  /** The page of „Besprechung vorbereiten“. */
  prep_page?: number | null;
}
export interface BriefingIssue {
  site: string;
  key: string;
  summary: string;
  status: string;
  priority: string;
  due_date: string | null;
  url: string;
  blocked: boolean;
}
export interface BriefingJira {
  overdue: BriefingIssue[];
  due: BriefingIssue[];
  blocked: BriefingIssue[];
  overdue_total: number;
  due_total: number;
  blocked_total: number;
}
export interface BriefingTask {
  page_id: number;
  page_title: string;
  ordinal: number;
  text: string;
  due: string | null;
  priority: number;
}
export interface BriefingTasks {
  overdue: BriefingTask[];
  today: BriefingTask[];
  overdue_total: number;
  today_total: number;
}
export interface BriefingTime {
  date: string;
  target_minutes: number;
  booked_minutes: number;
  missing_minutes: number;
  holiday: string | null;
  absence: "vacation" | "sick" | "comp" | "other" | null;
  half: boolean;
}
export interface BriefingSummary {
  date: string;
  text: string;
  model: string;
  at: string;
  local: boolean;
}
export interface Briefing {
  date: string;
  workday: boolean;
  sections: BriefingSectionId[];
  meetings: BriefingMeeting[];
  next_meeting: string | null;
  jira: BriefingJira | null;
  tasks: BriefingTasks;
  time: BriefingTime | null;
  private: boolean;
  summary: BriefingSummary | null;
  ai_ready: boolean;
}
export type BriefingStart = "none" | "open" | "notify";

/** What a page embed `![[Seite#Abschnitt]]` shows (annalo_core::embeds::EmbedView). */
export interface EmbedView {
  page_id: number | null;
  title: string;
  icon: string | null;
  updated_at: string | null;
  /** The embedded Markdown; null when the page or the section is missing. */
  content: string | null;
  missing: "page" | "section" | null;
}

// ---- link and tag suggestions, duplicates, PDF highlights (1.10)

/** An unlinked mention: `text` at `start..end` (UTF-8 bytes of the page's Markdown). */
export interface Mention {
  start: number;
  end: number;
  text: string;
  page_id: number;
  title: string;
  before: string;
  after: string;
}

export interface MentionGroup {
  page_id: number;
  title: string;
  icon: string | null;
  mentions: Mention[];
}

export interface MentionReport {
  /** Pages named in the open page without a link. */
  outgoing: MentionGroup[];
  /** Pages that name the open page without linking it. */
  incoming: MentionGroup[];
}

export interface TagSuggestion {
  tag: string;
  score: number;
  pages: number;
  /** Proposed by the AI, not used anywhere yet. */
  new: boolean;
}

export interface DuplicateHint {
  page_id: number;
  title: string;
  icon: string | null;
  score: number;
  text_score: number;
  title_score: number;
}

export interface DuplicatePair {
  a: number;
  a_title: string;
  b: number;
  b_title: string;
  score: number;
  text_score: number;
  title_score: number;
}

export interface MergeOutcome {
  keep: number;
  other: number;
  relinked: number;
  changed: number[];
}

export type PdfRect = [number, number, number, number];

export interface PdfHighlight {
  id: number;
  attachment: string;
  page: number;
  rects: PdfRect[];
  text: string;
  color: string;
  note: string;
  created_at: string;
}

export interface NewPdfHighlight {
  attachment: string;
  page: number;
  rects: PdfRect[];
  text: string;
  color: string;
  note?: string;
}
