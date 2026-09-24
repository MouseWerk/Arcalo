// Typed wrappers around the Tauri IPC commands (see src-tauri/src/lib.rs).

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as T from "./types";

const call = <R>(cmd: string, args?: Record<string, unknown>) => invoke<R>(cmd, args);

export const api = {
  // pages
  tree: () => call<T.PageNode[]>("workspace_tree"),
  page: (id: number) => call<T.PageDoc>("page_get", { id }),
  /** Saves the Markdown; returns what the save derived (tags, unresolved links, time), not the content. */
  savePage: (id: number, content: string) => call<T.SavedPage>("page_save", { id, content }),
  /** The child pages of a page with their typed properties (table and board views). */
  pageCollection: (parentId: number) => call<T.PageCollection>("page_collection", { parentId }),
  /** The schema a page's properties follow (its parent's), with the parent's id. */
  pageSchema: (pageId: number) => call<[number, T.PropSchema] | null>("page_schema", { pageId }),
  /** Names for person properties: person values and @mentions, most used first. */
  knownPersons: () => call<string[]>("known_persons"),
  versions: (pageId: number) => call<T.VersionInfo[]>("page_versions", { pageId }),
  versionContent: (versionId: number) => call<string>("page_version_content", { versionId }),
  /** Stores the page's current content as a version; null when it equals the newest one. */
  snapshotPage: (pageId: number) => call<number | null>("page_snapshot", { pageId }),
  restoreVersion: (pageId: number, versionId: number) => call<T.PageDoc>("page_version_restore", { pageId, versionId }),
  createPage: (title: string, parentId: number | null = null, icon: string | null = "file-text", content?: string) =>
    call<T.Page>("page_create", { parentId, title, icon, content: content ?? null }),
  renamePage: (id: number, title: string, updateLinks = true) => call<number>("page_rename", { id, title, updateLinks }),
  /** Moves the page and its subpages to the trash. */
  deletePage: (id: number) => call<number>("page_delete", { id }),
  restorePage: (id: number) => call<T.Page>("page_restore", { id }),
  purgePage: (id: number) => call<number>("page_purge", { id }),
  trash: () => call<T.TrashEntry[]>("trash_list"),
  emptyTrash: () => call<number>("trash_empty"),
  movePage: (id: number, parentId: number | null, position: number) => call<void>("page_move", { id, parentId, position }),
  setFavorite: (id: number, favorite: boolean) => call<void>("page_set_favorite", { id, favorite }),
  setIcon: (id: number, icon: string | null) => call<void>("page_set_icon", { id, icon }),
  resolvePage: (title: string, create: boolean) => call<T.Page | null>("page_resolve", { title, create }),
  recentPages: (limit = 8) => call<T.Page[]>("recent_pages", { limit }),
  dailyNote: (date?: string) => call<T.Page>("daily_note", { date: date ?? null }),
  /** Per day `from..=to` (YYYY-MM-DD, local): daily note, booked minutes, open tasks due. */
  dailyOverview: (from: string, to: string) => call<T.DayOverview[]>("daily_overview", { from, to }),
  tags: () => call<[string, number][]>("tags_list"),
  tagPages: (tag: string) => call<T.Page[]>("tag_pages", { tag }),
  tasks: (filter: T.TaskFilter = {}) => call<T.Task[]>("tasks_list", { filter }),
  setTaskDone: (pageId: number, ordinal: number, done: boolean, expectedText?: string) =>
    call<void>("task_set_done", { pageId, ordinal, done, expectedText: expectedText ?? null }),
  search: (query: string, limit = 30) => call<T.SearchHit[]>("search_workspace", { query, limit }),
  importVault: (path: string) => call<T.ImportReport>("vault_import", { path }),
  cancelVaultImport: () => call<void>("vault_import_cancel"),
  exportVault: (path: string) => call<number>("vault_export", { path }),

  // templates + attachments
  templates: () => call<T.Page[]>("templates_list"),
  templatesRoot: () => call<T.Page>("templates_root"),
  renderTemplate: (id: number, title?: string) => call<string>("template_render", { id, title: title ?? null }),
  pageFromTemplate: (templateId: number, title: string, parentId: number | null = null) =>
    call<T.Page>("page_from_template", { templateId, title, parentId }),
  saveAttachment: (data: string, name: string, mime: string) => call<T.SavedAttachment>("attachment_save", { data, name, mime }),
  /** Copies a file (path from the file dialog) into the attachments folder, keeping its name. */
  importAttachment: (path: string) => call<T.SavedAttachment>("attachment_import", { path }),
  /** An attachment's bytes (PDF preview and viewer). */
  readAttachment: (name: string) => call<ArrayBuffer>("attachment_read", { name }),
  /** Size in bytes, `null` when the file is missing. */
  attachmentSize: (name: string) => call<number | null>("attachment_size", { name }),
  /** Creates an empty `<title>.excalidraw` drawing (a free name: `title 2`, …). */
  createDrawing: (title: string) => call<T.SavedAttachment>("drawing_create", { title }),
  /** Attachment manager: every file with type, size, date and usage. */
  attachments: () => call<T.AttachmentList>("attachments_list"),
  /** Renames a file and rewrites its embeds in all pages. */
  renameAttachment: (name: string, newName: string) => call<T.RenameOutcome>("attachment_rename", { name, newName }),
  /** Moves files into the file trash. */
  trashAttachments: (names: string[]) => call<string[]>("attachment_trash", { names }),
  trashedAttachments: () => call<T.TrashedFile[]>("attachments_trashed"),
  restoreAttachment: (id: string, name: string) => call<void>("attachment_restore", { id, name }),
  purgeAttachment: (id: string, name: string) => call<void>("attachment_purge", { id, name }),
  /** Excalidraw scene JSON of a drawing. */
  readDrawing: (name: string) => call<string>("drawing_read", { name }),
  /** Stores the scene and its SVG preview (`null`: empty drawing, no preview). */
  saveDrawing: (name: string, scene: string, svg: string | null) => call<void>("drawing_save", { name, scene, svg }),

  // WBS
  wbs: () => call<T.ProjectTree[]>("wbs_tree"),
  createProject: (code: string, name: string) => call<T.Project>("project_create", { code, name }),
  updateProject: (id: number, name: string) => call<void>("project_update", { id, name }),
  deleteProject: (id: number) => call<void>("project_delete", { id }),
  createNetzplan: (projectId: number, netzplanNr: string, wbsElement: string, description: string, plannedHours: number) =>
    call<T.Netzplan>("netzplan_create", { projectId, netzplanNr, wbsElement, description, plannedHours }),
  updateNetzplan: (id: number, wbsElement: string, description: string, plannedHours: number) =>
    call<void>("netzplan_update", { id, wbsElement, description, plannedHours }),
  deleteNetzplan: (id: number) => call<void>("netzplan_delete", { id }),
  createVorgang: (netzplanId: number, vorgangNr: string, description: string, durationDays: number, plannedHours: number, predecessors: string[]) =>
    call<T.Vorgang>("vorgang_create", { netzplanId, vorgangNr, description, durationDays, plannedHours, predecessors }),
  updateVorgang: (id: number, description: string, durationDays: number, plannedHours: number, remainingHours: number | null) =>
    call<void>("vorgang_update", { id, description, durationDays, plannedHours, remainingHours }),
  deleteVorgang: (id: number) => call<void>("vorgang_delete", { id }),
  leistungsarten: () => call<[string, string][]>("leistungsarten_list"),
  saveLeistungsart: (code: string, description: string) => call<void>("leistungsart_save", { code, description }),
  deleteLeistungsart: (code: string) => call<void>("leistungsart_delete", { code }),

  // time
  logTime: (line: string, pageId: number | null = null) => call<T.LogOutcome>("log_time", { line, pageId }),
  /** Smart `/zeit`: suggests a reference for a line without one; null when the page has a linked Vorgang. */
  zeitSuggestAi: (line: string, pageId: number | null = null) => call<T.ZeitGuess | null>("zeit_suggest_ai", { line, pageId }),
  pageWork: (pageId: number) => call<T.PageWork | null>("page_work", { pageId }),
  timerStatus: () => call<T.TimerStatus | null>("timer_status"),
  timerStart: (netzplanId: number, vorgangNr: string | null, leistungsart: string | null, description: string) =>
    call<T.TimeEntry>("timer_start", { netzplanId, vorgangNr, leistungsart, description }),
  timerStop: (subtractIdle: boolean) => call<T.StopOutcome>("timer_stop", { subtractIdle }),
  timerDiscard: () => call<void>("timer_discard"),
  entries: (from?: string, to?: string) => call<T.TimeEntryRow[]>("time_entries", { from: from ?? null, to: to ?? null }),
  createEntry: (e: { netzplanId: number; vorgangNr: string | null; leistungsart: string | null; startTime: string; durationMinutes: number; description: string }) =>
    call<T.LogOutcome>("time_entry_create", e),
  updateEntry: (e: { id: number; vorgangNr: string | null; leistungsart: string | null; startTime: string; durationMinutes: number; description: string }) =>
    call<T.TimeEntry>("time_entry_update", e),
  setStatus: (ids: number[], status: T.StatusFlag) => call<number>("set_entry_status", { ids, status }),
  deleteEntry: (id: number) => call<void>("delete_time_entry", { id }),
  budget: (netzplanId: number) => call<T.BudgetStatus[]>("budget", { netzplanId }),
  schedule: (netzplanId: number) => call<T.Schedule>("schedule", { netzplanId }),
  /** Budget and schedule of every Netzplan in one call (Projekte). */
  netzplanOverview: () => call<T.NetzplanOverview[]>("netzplan_overview"),
  /** The budget rows of every Netzplan (each: the total first, then its Vorgänge) in one call. */
  budgetsAll: () => call<T.BudgetStatus[]>("budgets_all"),
  /** Open-task counts and the most critical budget for the assistant's suggestions; `today` is the local day. */
  suggestionFacts: (today: string, pageId: number | null) => call<T.SuggestionFacts>("suggestion_facts", { today, pageId }),
  exportEntries: (a: { format: T.ExportFormat; from: string | null; to: string | null; onlyReleased: boolean; markExported: boolean; path: string | null }) =>
    call<T.ExportResult>("export_entries", a),

  // settings
  settings: () => call<T.SettingsView>("settings_get"),
  saveSettings: (settings: T.Settings) => call<T.SettingsView>("settings_save", { settings }),
  setApiKey: (key: string | null) => call<T.SettingsView>("api_key_set", { key }),
  testConnection: (baseUrl: string | null, apiKey: string | null) => call<T.ConnectionTest>("ai_test_connection", { baseUrl, apiKey }),
  /** Stores (null: removes) the key of an AI provider in the credential store. */
  setProviderKey: (id: string, key: string | null) => call<T.SettingsView>("provider_key_set", { id, key }),
  /** Models of a provider (saved or not); an unsaved key can be tried. */
  providerModels: (provider: T.AiProvider, key: string | null = null) => call<T.ConnectionTest>("ai_provider_models", { provider, key }),
  /** Reachability, key, chat, tools and embeddings of a provider. */
  testProvider: (provider: T.AiProvider, key: string | null = null, model: string | null = null) => call<T.ProviderTest>("ai_provider_test", { provider, key, model }),
  detectOllama: (baseUrl: string | null = null) => call<T.OllamaDetect>("ollama_detect", { baseUrl }),
  /** Downloads a model into Ollama; progress arrives as `ai://pull` events. */
  pullOllama: (requestId: string, provider: T.AiProvider, model: string) => call<void>("ollama_pull", { requestId, provider, model }),
  removeDemo: () => call<number>("demo_remove"),
  onboardingNeeded: () => call<boolean>("onboarding_needed"),
  finishOnboarding: (samples: boolean) => call<void>("onboarding_finish", { samples }),
  backupNow: () => call<T.BackupInfo>("backup_now"),
  backups: () => call<T.BackupInfo[]>("backup_list"),
  mirrorStatus: () => call<T.MirrorStatus>("mirror_status"),
  openMirror: () => call<void>("mirror_open"),
  gitSyncNow: (allowDeletions = false) => call<T.GitSyncOutcome>("git_sync_now", { allowDeletions }),
  gitSyncStatus: () => call<T.GitSyncStatus>("git_sync_status"),
  /** Stores (or with null removes) the Git access token; it is never sent back. */
  setGitToken: (token: string | null) => call<T.GitSyncStatus>("git_token_set", { token }),
  gitSyncTest: (url: string | null, token: string | null) => call<T.GitTest>("git_sync_test", { url, token }),
  gitRestoreImport: (url: string) => call<T.ImportReport>("git_restore_import", { url }),
  /** Pages with an undecided Git sync conflict. */
  gitConflicts: () => call<T.GitConflictInfo[]>("git_conflicts"),
  gitConflict: (pageId: number) => call<T.GitConflictView>("git_conflict_get", { pageId }),
  /** Saves the merged content, closes the conflict and syncs again. */
  resolveGitConflict: (pageId: number, content: string) =>
    call<{ doc: T.PageDoc; sync: T.GitSyncOutcome | null; sync_error: string | null }>("git_conflict_resolve", { pageId, content }),
  appInfo: () => call<{ version: string; data_dir: string; platform: string; portable: boolean }>("app_info"),
  dataDirStatus: () => call<T.DataDirStatus>("data_dir_status"),
  inspectDataDir: (path: string) => call<T.DataDirTarget>("data_dir_inspect", { path }),
  /** Takes effect at the next start; `useExisting` opens a workspace already in `path`. */
  setDataDir: (path: string, useExisting = false) => call<T.DataDirStatus>("data_dir_set", { path, useExisting }),
  cancelDataDirMove: () => call<T.DataDirStatus>("data_dir_cancel"),
  restart: () => call<void>("app_restart"),
  updateStatus: () => call<T.UpdateStatus>("update_status"),
  /** Asks the release feed; null when this is the newest version. Never installs. */
  updateCheck: () => call<T.UpdateInfo | null>("update_check"),
  /** Downloads and installs the found update, then restarts (`update://progress` events). */
  updateInstall: () => call<void>("update_install"),

  // developer log (Settings → Protokoll)
  devlogWrite: (level: T.DevLogLevel, source: string, message: string) => call<void>("devlog_write", { level, source, message }),
  /** Newest first. */
  devlogRead: (limit = 500) => call<T.DevLogEntry[]>("devlog_read", { limit }),
  devlogStats: () => call<T.DevLogStats>("devlog_stats"),
  devlogClear: () => call<void>("devlog_clear"),
  devlogOpenFolder: () => call<void>("devlog_open_folder"),

  // network
  networkStatus: () => call<T.NetworkStatus>("network_status"),
  /** Requests LiteLLM's model list with unsaved network settings; reports the proxy used. */
  networkTest: (network: T.NetworkSettings | null, baseUrl: string | null, password: string | null) =>
    call<T.NetworkTest>("network_test", { network, baseUrl, password }),
  fetchPac: (url: string, network: T.NetworkSettings | null = null) => call<string>("network_fetch_pac", { url, network }),
  caInfo: (path: string) => call<T.CaInfo>("network_ca_info", { path }),
  setProxyPassword: (password: string | null) => call<T.NetworkStatus>("proxy_password_set", { password }),

  // settings files and defaults
  exportSettings: (path: string) => call<void>("settings_export", { path }),
  readSettingsFile: (path: string) => call<string>("settings_file_read", { path }),
  exportTheme: (path: string, theme: T.CustomTheme) => call<void>("theme_export", { path, theme }),
  /** A checked theme file (without id). */
  readThemeFile: (path: string) => call<T.CustomTheme>("theme_file_read", { path }),
  /** Current settings with one section (or, with null, everything but the connections) at its defaults. */
  settingsDefaults: (section: string | null) => call<T.Settings>("settings_defaults", { section }),
  saveWindowState: () => call<void>("window_state_save"),

  // desktop
  desktopInfo: () => call<T.DesktopInfo>("desktop_info"),
  setAutostart: (enabled: boolean) => call<T.DesktopInfo>("autostart_set", { enabled }),
  /** Hides the main window to the tray. */
  hideWindow: () => call<void>("window_hide"),
  quit: () => call<void>("app_quit"),
  captureSubmit: (text: string) => call<T.CaptureOutcome>("capture_submit", { text }),
  captureHide: () => call<void>("capture_hide"),
  searchHide: () => call<void>("search_hide"),
  /** Hides the quick search and lets the main window open `target` (`search://open`). */
  searchOpen: (target: T.SearchTarget) => call<void>("search_open", { target }),
  /** Starts a timer on the most recently booked Netzplan/Vorgang. */
  timerResumeLast: () => call<void>("timer_resume_last"),
  /** Saves the start page's widgets and scratch note only. */
  saveDashboard: (dashboard: T.Dashboard) => call<T.SettingsView>("dashboard_save", { dashboard }),
  saveQuickLinks: (links: T.QuickLink[]) => call<T.SettingsView>("quick_links_save", { links }),
  openQuickLink: (index: number) => call<void>("quick_link_open", { index }),
  openAttachment: (name: string, reveal = false) => call<void>("attachment_open", { name, reveal }),
  /** Title of a web page (smart paste of a URL); the URL itself when there is none. */
  linkTitle: (url: string) => call<string>("link_title", { url }),
  /** Writes a page shared as a single HTML file to `path` (from the save dialog). */
  writeHtmlFile: (path: string, html: string) => call<void>("html_file_write", { path, html }),

  // focus sessions
  /** The current phase; completes a session that ran out meanwhile. */
  focusState: () => call<T.FocusState | null>("focus_state"),
  /** `minutes` may be fractional (tests use 0.05). */
  focusStart: (start: { reference: string; minutes: number; break_minutes: number; goal: string }) => call<T.FocusState>("focus_start", { start }),
  focusFinish: () => call<T.FocusDone>("focus_finish"),
  focusAbort: (book: boolean) => call<T.FocusDone>("focus_abort", { book }),
  focusEndBreak: () => call<void>("focus_end_break"),
  /** Local days `from..=to` (YYYY-MM-DD). */
  focusReport: (from: string, to: string) => call<T.FocusReport>("focus_report", { from, to }),
  /** Writes „Fokus heute: …“ into the daily note; returns its page id. */
  focusDailyLine: (date?: string) => call<number>("focus_daily_line", { date: date ?? null }),
  focusEntryIds: () => call<number[]>("focus_entry_ids"),

  // activity feed
  activity: (filter: T.FeedFilter) => call<T.Activity[]>("activity_list", { filter }),
  activitySummary: (from: string, to: string) => call<T.FeedSummary>("activity_summary", { from, to }),
  activityPeople: () => call<string[]>("activity_people"),

  // presentation
  presentationBegin: () => call<{ monitors: number }>("presentation_begin"),
  presentationEnd: () => call<void>("presentation_end"),
  /** Opens the presenter window with two monitors; false with one (overlay instead). */
  presenterOpen: () => call<boolean>("presenter_open"),
  presenterClose: () => call<void>("presenter_close"),

  // AI
  routePreview: (prompt: string, useTools: boolean, tier: T.Tier | null) => call<T.RouteDecision>("ai_route_preview", { prompt, useTools, tier }),
  meter: () => call<T.SessionMeter>("ai_meter"),
  chat: (a: { requestId: string; messages: T.ChatMessage[]; useTools: boolean; tier: T.Tier | null; pageId: number | null; overrideLimit?: boolean }) =>
    call<T.ChatOutcome>("ai_chat", { overrideLimit: false, ...a }),
  /** Rewrites `text` by `instruction` (inline AI, meeting summary); streams like `chat`. */
  transform: (a: { requestId: string; instruction: string; text: string; pageId: number | null; tier?: T.Tier | null; overrideLimit?: boolean }) =>
    call<T.ChatOutcome>("ai_transform", { tier: null, overrideLimit: false, ...a }),
  costStatus: () => call<T.CostStatus>("ai_cost_status"),
  cancelChat: (requestId: string) => call<void>("ai_cancel", { requestId }),
  planTool: (name: string, args: string) => call<T.ToolPlan>("ai_plan_tool", { name, arguments: args }),
  runWorkspaceTool: (name: string, args: string) => call<string>("ai_run_workspace_tool", { name, arguments: args }),
  runSystemTool: (callSpec: unknown) => call<string>("ai_run_system_tool", { call: callSpec }),
  indexPending: () => call<number>("ai_index_pending"),
};

export function on<P>(event: string, handler: (payload: P) => void): Promise<UnlistenFn> {
  return listen<P>(event, (e) => handler(e.payload));
}

/** URL of a stored attachment (served by the shell's `annalo-asset:` protocol); folders in `![[a/b.png]]` are ignored. */
export function attachmentUrl(name: string) {
  const base = name.split(/[\\/]/).pop() ?? name;
  try {
    return convertFileSrc(base, "annalo-asset");
  } catch {
    return `attachments/${encodeURIComponent(base)}`;
  }
}

/** Reads a file as base64 (without the `data:` prefix) and stores it as an attachment. */
export async function uploadAttachment(file: File): Promise<T.SavedAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  return api.saveAttachment(dataUrl.slice(dataUrl.indexOf(",") + 1), file.name || "bild", file.type);
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Stores any file under its own name: the raw bytes as the IPC body (no base64), the name as a header. */
export async function storeFile(file: File): Promise<T.SavedAttachment> {
  // Same limit as the core (attachments::MAX_FILE_BYTES), checked before the file is read into memory.
  if (file.size > MAX_FILE_BYTES) throw new Error(`Datei ist größer als ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<T.SavedAttachment>("attachment_store", bytes, { headers: { "x-annalo-name": encodeURIComponent(file.name || "Datei") } });
}

/** Errors from Rust arrive as plain strings. */
const KINDS: Record<string, string> = {
  netzplan: "Netzplan",
  vorgang: "Vorgang",
  leistungsart: "Leistungsart",
  page: "Seite",
  project: "Projekt",
  task: "Aufgabe",
  tool: "Werkzeug",
  entry: "Eintrag",
  backup: "Sicherung",
  version: "Version",
  attachment: "Anhang",
};

/** Backend errors in German: `netzplan 'NP-1' not found` → `Netzplan „NP-1“ nicht gefunden`. */
export const errorText = (e: unknown) => {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
  const nf = /^(\w+) '(.+)' not found$/.exec(raw);
  if (nf) return `${KINDS[nf[1]] ?? nf[1]} „${nf[2]}“ nicht gefunden`;
  // The core writes German messages; older texts (and re-wrapped ones) may still carry prefixes.
  return raw
    .replace(/^(invalid state: )+/, "")
    .replace(/^could not parse command: /, "Eingabe nicht verstanden: ")
    .replace(/^i\/o error: /, "Dateifehler: ")
    .replace(/^database error: /, "Datenbankfehler: ")
    .replace(/^http error: /, "Verbindungsfehler: ")
    .replace(/^AI provider error \((\d+)\): /, "KI-Server meldet Fehler $1: ");
};
