// Typed wrappers around the Tauri IPC commands (see src-tauri/src/lib.rs).

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as T from "./types";
import { noteSystemLang, t, type TKey } from "./i18n";
import type * as B from "./backupdest";
import type * as G from "./graph";
import { fromGraphTable } from "./graph";
import { fromPageRows, type PageRow } from "./tree";
import { fromTaskTable, type TaskTable } from "./tasks";

// App-Sperre: a command refused while locked never settles (the app behind the lock screen is
// unmounted; its last requests are simply dropped instead of showing errors).
const call = <R>(cmd: string, args?: Record<string, unknown>) =>
  invoke<R>(cmd, args).catch((e: unknown) => (e === "app-locked" ? new Promise<R>(() => {}) : Promise.reject(e)));

/** Every window learns the system language („Wie das System“) with the settings. */
function withSystemLang(v: T.SettingsView): T.SettingsView {
  noteSystemLang(v.system_language);
  return v;
}

export const api = {
  // pages
  tree: () => call<PageRow[]>("workspace_tree_compact").then(fromPageRows),
  page: (id: number) => call<T.PageDoc>("page_get", { id }),
  /** What `![[target#anchor]]` shows (page, heading section or block). */
  pageEmbed: (target: string, anchor: string | null) => call<T.EmbedView>("page_embed", { target, anchor }),
  // graph view
  graphData: (filter: G.GraphFilter) => call<G.GraphTable>("graph_compact", { filter }).then(fromGraphTable),
  graphPatch: (ids: number[], filter: G.GraphFilter) => call<G.GraphData>("graph_patch", { ids, filter }),
  /** `layout`, `presets` or `view`, stored per workspace. */
  graphStateGet: (key: "layout" | "presets" | "view") => call<unknown>("graph_state_get", { key }),
  graphStateSet: (key: "layout" | "presets" | "view", value: unknown) => call<void>("graph_state_set", { key, value }),
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
  /** A new canvas below `parentId`, or filed into the canvas folder (Ordner & Ablage). */
  createCanvas: (title: string, parentId: number | null = null) => call<T.Page>("canvas_create", { parentId, title }),
  /** A page's file in the Markdown mirror, as a canvas note card stores it. */
  canvasNotePath: (pageId: number) => call<string>("canvas_note_path", { pageId }),
  recentPages: (limit = 8) => call<T.Page[]>("recent_pages", { limit }),
  dailyNote: (date?: string) => call<T.Page>("daily_note", { date: date ?? null }),
  /** Per day `from..=to` (YYYY-MM-DD, local): daily note, booked minutes, open tasks due. */
  dailyOverview: (from: string, to: string) => call<T.DayOverview[]>("daily_overview", { from, to }),
  tags: () => call<[string, number][]>("tags_list"),
  tagPages: (tag: string) => call<T.Page[]>("tag_pages", { tag }),
  /** The tasks of `filter`, sent compactly (each page once; `tasks_list` answers the same objects). */
  tasks: (filter: T.TaskFilter = {}) => call<TaskTable>("tasks_compact", { filter }).then(fromTaskTable),
  setTaskDone: (pageId: number, ordinal: number, done: boolean, expectedText?: string) =>
    call<void>("task_set_done", { pageId, ordinal, done, expectedText: expectedText ?? null }),
  /** Changes tasks of any pages at once; the result undoes it with `tasksUndo`. */
  tasksEdit: (refs: T.TaskRef[], edit: T.TaskEdit) => call<T.TaskChange>("tasks_edit", { refs, edit }),
  tasksUndo: (change: T.TaskChange) => call<void>("tasks_undo", { change }),
  /** Next due date of a repeating task done today (its Markdown after the checkbox), or null. */
  taskNextDue: (text: string) => call<string | null>("task_next_due", { text }),
  taskRecurPreview: (recur: T.Recurrence, due: string | null) => call<string[]>("task_recur_preview", { recur, due }),
  search: (query: string, limit = 30) => call<T.SearchHit[]>("search_workspace", { query, limit }),
  /** Exact and meaning hits (Suche nach Bedeutung); exact only when it is off or offline. */
  searchSemantic: (query: string, limit = 30) => call<T.SemanticResult>("search_semantic", { query, limit }),
  semanticStatus: () => call<T.SemanticStatus>("semantic_status"),
  semanticRebuild: () => call<T.SemanticStatus>("semantic_rebuild"),
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
  /** Pauses (true) or continues the running timer; the paused time is not booked. */
  timerPause: (paused: boolean) => call<void>("timer_pause", { paused }),
  /** `/zeit` chips of a note: linked to their booking, a copy, or without booking. */
  chipStates: (pageId: number, chips: { id: number; target: string }[]) => call<T.ChipState[]>("time_chip_states", { pageId, chips }),
  /** The chip was removed from its note: its booking goes too; returns it for an undo. */
  chipDelete: (id: number) => call<T.TimeEntry>("time_chip_delete", { id }),
  /** The removed chip came back: its booking is put back (same id when free). */
  chipRestore: (entry: T.TimeEntry) => call<T.TimeEntry>("time_chip_restore", { entry }),
  /** Books the values of a chip without booking (deleted, a copy, from another device). */
  chipBook: (a: { pageId: number; target: string; minutes: number; leistungsart: string | null; date: string | null; text: string; previous: number | null }) =>
    call<T.LogOutcome>("time_chip_book", a),
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

  // calendar sync (Kalender)
  calendarStatus: () => call<T.CalendarStatus>("calendar_status"),
  /** Appointments of the active sources overlapping `from..to` (ISO instants). */
  calendarEvents: (from: string, to: string) => call<T.CalendarEvent[]>("calendar_events", { from, to }),
  /** Adds a subscription (the URL goes to the credential store) or an .ics file, and syncs it. */
  calendarSourceAdd: (name: string, source: { url?: string; path?: string }) =>
    call<T.CalendarStatus>("calendar_source_add", { name, url: source.url ?? null, path: source.path ?? null }),
  calendarSourceUpdate: (id: string, patch: { name?: string; color?: string; enabled?: boolean; url?: string; path?: string }) =>
    call<T.CalendarStatus>("calendar_source_update", { id, name: patch.name ?? null, color: patch.color ?? null, enabled: patch.enabled ?? null, url: patch.url ?? null, path: patch.path ?? null }),
  calendarSourceRemove: (id: string) => call<T.CalendarStatus>("calendar_source_remove", { id }),
  /** Syncs one source (its error is thrown) or all active ones now. */
  calendarSyncNow: (source?: string) => call<T.CalendarStatus>("calendar_sync_now", { source: source ?? null }),
  /** Lists the calendars of Outlook (default, other folders and stores, shared, rooms, groups). */
  calendarOutlookDiscover: () => call<T.CalendarStatus>("calendar_outlook_discover"),
  calendarOutlookUpdate: (id: string, patch: { enabled?: boolean; color?: string; booking?: boolean }) =>
    call<T.CalendarStatus>("calendar_outlook_update", { id, enabled: patch.enabled ?? null, color: patch.color ?? null, booking: patch.booking ?? null }),
  /** People whose calendars discovery opens by name; discovers again. */
  calendarOutlookPeople: (people: string[]) => call<T.CalendarStatus>("calendar_outlook_people", { people }),
  calendarSetSkip: (key: string, skip: boolean) => call<void>("calendar_set_skip", { key, skip }),
  calendarLinkEntry: (key: string, entryId: number) => call<void>("calendar_link_entry", { key, entryId }),
  /** The WBS last booked for this series or subject. */
  calendarWbsHint: (key: string) => call<T.WbsHint | null>("calendar_wbs_hint", { key }),
  /** The meeting note of an appointment (created on first use). */
  calendarMeetingNote: (key: string) => call<{ page: T.Page; created: boolean }>("calendar_meeting_note", { key }),

  // Woche vorschlagen
  /** The timesheet draft for the week starting at `weekStart` (YYYY-MM-DD, local). */
  // focus blocks (time blocking)
  blocks: (from: string, to: string) => call<T.FocusBlock[]>("blocks_list", { from, to }),
  blockCreate: (block: T.NewBlock) => call<T.FocusBlock>("block_create", { block }),
  blockUpdate: (id: number, patch: T.BlockPatch) => call<T.FocusBlock>("block_update", { id, patch }),
  blockDelete: (id: number) => call<void>("block_delete", { id }),
  blockTaskDone: (id: number) => call<void>("block_task_done", { id }),
  /** Free starts on a day for a block of `minutes`. */
  blockFreeSlots: (date: string, minutes: number) => call<string[]>("block_free_slots", { date, minutes }),
  blocksOutlookRetry: () => call<void>("blocks_outlook_retry"),
  weekProposal: (weekStart: string, restOfToday = false) => call<T.WeekProposal>("week_proposal", { weekStart, restOfToday }),
  /** Books the accepted proposals as drafts in one go and links their sources. */
  weekProposalApply: (items: T.AcceptedProposal[]) => call<T.AppliedProposals>("week_proposal_apply", { items }),

  // Tagesrückblick
  /** „Tagesrückblick“ of a local day (YYYY-MM-DD). */
  dayReview: (date: string) => call<T.DayReview>("day_review", { date }),
  /** Summary of a day by a local model only; streams like `chat`. */
  dayReviewSummary: (requestId: string, date: string) => call<T.ChatOutcome>("day_review_summary", { requestId, date }),

  // Morgen-Briefing
  /** Today's briefing in one call; `hidden`: calendars the views hide. */
  briefing: (hidden: string[]) => call<T.Briefing>("briefing", { hidden }),
  /** „Was heute wichtig ist“: cached for the day unless `refresh`. */
  briefingSummary: (requestId: string, hidden: string[], refresh: boolean) => call<T.BriefingSummary>("briefing_summary", { requestId, hidden, refresh }),
  /** The first start of the day: open the briefing, notify, or nothing (stored per day). */
  briefingStart: () => call<T.BriefingStart>("briefing_start"),

  // settings
  settings: () => call<T.SettingsView>("settings_get").then(withSystemLang),
  saveSettings: (settings: T.Settings) => call<T.SettingsView>("settings_save", { settings }).then(withSystemLang),
  setSettingsScope: (section: string, scope: T.SettingsScope) => call<T.SettingsView>("settings_scope_set", { section, scope }),
  undoSettingsSync: () => call<T.SettingsView>("settings_sync_undo"),
  /** The operating system's locale tag (e.g. „de-DE“), or null when unknown. */
  osLocale: () => call<string | null>("os_locale"),
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
  /** First-run intro: play it (fresh install) or show the upgrade hint. */
  onboardingStatus: () => call<T.OnboardingStatus>("onboarding_status"),
  /** Stores `onboarding.completed_version` / `completed_at`. */
  onboardingComplete: () => call<T.SettingsView>("onboarding_complete"),
  onboardingHintShown: () => call<void>("onboarding_hint_shown"),
  /** The notice of the rename to Arcalo was shown (once per workspace). */
  rebrandNoticeShown: () => call<void>("rebrand_notice_shown"),
  /** Resets the first-run flags only (never data). */
  onboardingReset: () => call<T.SettingsView>("onboarding_reset"),
  backupNow: () => call<T.BackupInfo>("backup_now"),
  backups: () => call<T.BackupInfo[]>("backup_list"),
  backupDestinations: () => call<B.DestView[]>("backup_destinations"),
  /** „Jetzt testen“: write, read back and delete a probe file in `path`. */
  testBackupDestination: (path: string) => call<B.DestTest>("backup_destination_test", { path }),
  retryBackupDestinations: () => call<void>("backup_destination_retry"),
  /** Backups in the active destinations (unreachable ones listed in `offline`). */
  remoteBackups: () => call<B.RemoteBackups>("backup_remote_list"),
  /** Copies and checks the backup; the next start puts it in place (restart right after). */
  restoreBackup: (path: string) => call<B.RestoreStaged>("backup_restore", { path }),
  mirrorStatus: () => call<T.MirrorStatus>("mirror_status"),
  openMirror: () => call<void>("mirror_open"),
  gitSyncNow: (allowDeletions = false, afterRestore: T.AfterRestore | null = null) => call<T.GitSyncOutcome>("git_sync_now", { allowDeletions, afterRestore }),
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
  /** A canvas conflict: this computer's version stays, the server's becomes a canvas next to it. */
  keepBothGitConflict: (pageId: number) =>
    call<{ doc: T.PageDoc; sync: T.GitSyncOutcome | null; sync_error: string | null }>("git_conflict_keep_both", { pageId }),
  appInfo: () => call<{ version: string; data_dir: string; platform: string; portable: boolean; os_name: string }>("app_info"),
  dataDirStatus: () => call<T.DataDirStatus>("data_dir_status"),
  inspectDataDir: (path: string) => call<T.DataDirTarget>("data_dir_inspect", { path }),
  /** Takes effect at the next start; `useExisting` opens a workspace already in `path`. */
  setDataDir: (path: string, useExisting = false) => call<T.DataDirStatus>("data_dir_set", { path, useExisting }),
  cancelDataDirMove: () => call<T.DataDirStatus>("data_dir_cancel"),
  restart: () => call<void>("app_restart"),
  updateStatus: () => call<T.UpdateStatus>("update_status"),
  /** Asks the release feed; null when this is the newest version. Never installs. */
  updateCheck: (manual = false) => call<T.UpdateInfo | null>("update_check", { manual }),
  /** Downloads and installs the found update, then restarts (`update://progress` events). */
  updateInstall: () => call<void>("update_install"),
  /** Background download: continue after a pause or a failure, or pause it (`update://state` events). */
  updateDownload: () => call<void>("update_download"),
  updatePause: () => call<void>("update_pause"),
  /** Installs the downloaded update now and restarts. */
  updateRestartNow: () => call<void>("update_restart_now"),
  updateSkip: (version: string) => call<void>("update_skip", { version }),
  /** Undoes a skipped version and „Später erinnern“. */
  updateUnskip: () => call<void>("update_unskip"),
  updateRemind: (days: number) => call<string>("update_remind", { days }),
  updateWhatsNewSeen: (version: string) => call<void>("update_whats_new_seen", { version }),
  /** „Zur vorherigen Version zurückkehren“: restores the database of before the update and the previous program. */
  updateRollback: () => call<void>("update_rollback"),
  /** Release notes (Markdown) of a version the app does not bundle, from the repository. */
  updateReleaseNotes: (version: string) => call<string>("update_release_notes", { version }),
  /** The Microsoft Store build: opens the Store's page of downloads and updates. */
  storeOpenUpdates: () => call<void>("store_open_updates"),

  // developer log (Settings → Protokoll)
  devlogWrite: (level: T.DevLogLevel, source: string, message: string) => call<void>("devlog_write", { level, source, message }),
  /** Newest first. */
  devlogRead: (limit = 500) => call<T.DevLogEntry[]>("devlog_read", { limit }),
  devlogStats: () => call<T.DevLogStats>("devlog_stats"),
  devlogClear: () => call<void>("devlog_clear"),
  devlogOpenFolder: () => call<void>("devlog_open_folder"),
  diagnosticsBundle: (path: string) => call<string>("diagnostics_bundle", { path }),
  secretsStatus: () => call<T.SecretStoreStatus>("secrets_status"),

  // network
  networkStatus: () => call<T.NetworkStatus>("network_status"),
  /** Requests LiteLLM's model list with unsaved network settings; reports the proxy used. */
  networkTest: (network: T.NetworkSettings | null, baseUrl: string | null, password: string | null) =>
    call<T.NetworkTest>("network_test", { network, baseUrl, password }),
  fetchPac: (url: string, profile: T.ProxyProfile | null = null) => call<string>("network_fetch_pac", { url, profile }),
  caInfo: (path: string) => call<T.CaInfo>("network_ca_info", { path }),
  setProxyPassword: (password: string | null, profile: string | null = null) => call<T.NetworkStatus>("proxy_password_set", { password, profile }),
  /** Services, their profile and the route they take with (unsaved) settings. */
  networkServices: (network: T.NetworkSettings | null) => call<T.ServiceRow[]>("network_services", { network }),
  /** A real request to the service's target through its profile. */
  networkServiceTest: (service: string, network: T.NetworkSettings | null, password: string | null) =>
    call<T.NetworkTest>("network_service_test", { service, network, password }),
  networkCertificate: (url: string, service: string | null = null) => call<T.CertDetails | null>("network_certificate", { url, service, network: null }),
  networkLegacyProbe: (profile: string) => call<T.LegacyProbe[]>("network_legacy_probe", { profile }),

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
  /** What closing the main window does (macOS: always hide; elsewhere „close to tray“). */
  closeAction: () => call<"hide" | "minimize" | "quit">("window_close_action"),
  quit: () => call<void>("app_quit"),
  captureSubmit: (text: string, target?: T.CaptureTarget) => call<T.CaptureOutcome>("capture_submit", { text, target: target ?? null }),
  captureHide: () => call<void>("capture_hide"),
  /** Opens the quick-capture window. */
  captureShow: () => call<void>("capture_show"),
  /** The capture window painted its first frame after being shown (open latency). */
  captureReady: () => call<void>("capture_ready"),
  /** Meeting running now, recent captures, queued captures. */
  captureContext: () => call<T.CaptureContext>("capture_context"),
  /** Takes the newest capture back (within 30 s). */
  captureUndo: () => call<T.RecentCapture>("capture_undo"),
  /** Hides the capture window and opens the page in the main window. */
  captureOpen: (pageId: number) => call<void>("capture_open", { pageId }),
  searchHide: () => call<void>("search_hide"),
  /** Hides the quick search and lets the main window open `target` (`search://open`). */
  searchOpen: (target: T.SearchTarget) => call<void>("search_open", { target }),
  /** Starts a timer on the most recently booked Netzplan/Vorgang. */
  timerResumeLast: () => call<void>("timer_resume_last"),
  /** Saves the start page's widgets and scratch note only. */
  saveDashboard: (dashboard: T.Dashboard) => call<T.SettingsView>("dashboard_save", { dashboard }),
  /** Everything the visible start-page widgets need, in one call (see lib/dashboard.ts `partsOf`). */
  dashboardData: (today: string, parts: { key: string; part: unknown }[]) => call<{ parts: Record<string, unknown>; ms: number }>("dashboard_data", { request: { today, parts } }),
  /** Writes an exported start-page board (JSON). */
  dashboardFileWrite: (path: string, json: string) => call<void>("dashboard_file_write", { path, json }),
  /** Takes inbox entry `index` (still reading `text`) off the inbox page `inbox`; with `target` it goes to that page. */
  dashboardInboxMove: (inbox: number, index: number, text: string, target: number | null) => call<string | null>("dashboard_inbox_move", { inbox, index, text, target }),
  saveQuickLinks: (links: T.QuickLink[]) => call<T.SettingsView>("quick_links_save", { links }),
  /** Opens the ribbon link at `index`, or entry `item` of the group there. */
  openQuickLink: (index: number, item: number | null = null) => call<void>("quick_link_open", { index, item }),
  openAttachment: (name: string, reveal = false) => call<void>("attachment_open", { name, reveal }),
  /** Title of a web page (smart paste of a URL); the URL itself when there is none. */
  linkTitle: (url: string) => call<string>("link_title", { url }),
  /** Writes a page shared as a single HTML file to `path` (from the save dialog). */
  writeHtmlFile: (path: string, html: string) => call<void>("html_file_write", { path, html }),
  /** Saves an exported diagram (`.svg` or `.png`). */
  writeDiagramFile: (path: string, data: Uint8Array) => call<void>("diagram_file_write", { path, data: Array.from(data) }),

  // focus sessions
  /** The current phase; completes a session that ran out meanwhile. */
  focusState: () => call<T.FocusState | null>("focus_state"),
  /** `minutes` may be fractional (tests use 0.05). */
  focusStart: (start: { reference: string; minutes: number; break_minutes: number; goal: string; block_id?: number | null }) => call<T.FocusState>("focus_start", { start }),
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
  routePreview: (prompt: string, useTools: boolean, tier: T.Tier | null, conversationId: number | null = null) =>
    call<T.RouteDecision>("ai_route_preview", { prompt, useTools, tier, conversationId }),
  meter: () => call<T.SessionMeter>("ai_meter"),
  /** `notes: false`: the plain chatbot of the chat view (no search in the notes, no tools). */
  chat: (a: { requestId: string; messages: T.ChatMessage[]; useTools: boolean; tier: T.Tier | null; pageId: number | null; overrideLimit?: boolean; conversationId?: number | null; notes?: boolean }) =>
    call<T.ChatOutcome>("ai_chat", { overrideLimit: false, conversationId: null, ...a }),
  // assistant chat history
  chatList: (query = "", archived = false) => call<T.ChatConversation[]>("chat_list", { query, archived }),
  chatGet: (id: number) => call<T.ChatConversationDoc>("chat_get", { id }),
  /** null when chats are not saved (Settings → Datenschutz). */
  chatCreate: (title: string) => call<T.ChatConversation | null>("chat_create", { title }),
  chatAppend: (id: number, messages: T.ChatRecord[], pageId: number | null, priv: boolean) =>
    call<{ conversation: T.ChatConversation; seqs: number[] } | null>("chat_append", { id, messages, pageId, private: priv }),
  chatTruncate: (id: number, seq: number) => call<number>("chat_truncate", { id, seq }),
  chatUpdate: (id: number, patch: { title?: string; pinned?: boolean; archived?: boolean }) => call<T.ChatConversation>("chat_update", { id, patch }),
  chatDelete: (id: number) => call<void>("chat_delete", { id }),
  chatRestore: (id: number) => call<T.ChatConversation>("chat_restore", { id }),
  chatDeleteAll: () => call<number>("chat_delete_all"),
  chatDuplicate: (id: number, title: string) => call<T.ChatConversation | null>("chat_duplicate", { id, title }),
  /** Rewrites `text` by `instruction` (inline AI, meeting summary); streams like `chat`. */
  transform: (a: { requestId: string; instruction: string; text: string; pageId: number | null; tier?: T.Tier | null; overrideLimit?: boolean }) =>
    call<T.ChatOutcome>("ai_transform", { tier: null, overrideLimit: false, ...a }),
  costStatus: () => call<T.CostStatus>("ai_cost_status"),
  cancelChat: (requestId: string) => call<void>("ai_cancel", { requestId }),
  planTool: (name: string, args: string) => call<T.ToolPlan>("ai_plan_tool", { name, arguments: args }),
  runWorkspaceTool: (name: string, args: string) => call<string>("ai_run_workspace_tool", { name, arguments: args }),
  runSystemTool: (callSpec: unknown) => call<string>("ai_run_system_tool", { call: callSpec }),
  indexPending: () => call<number>("ai_index_pending"),
  embeddingStatus: () => call<T.EmbeddingStatus>("ai_embedding_status"),

  // ---- link and tag suggestions, duplicates, PDF highlights (1.10)
  mentions: (pageId: number) => call<T.MentionReport>("mentions_get", { pageId }),
  linkMentions: (source: number, target: number, start: number | null = null) => call<number>("mentions_link", { source, target, start }),
  ignoreMention: (pageId: number, term: string) => call<void>("mentions_ignore", { pageId, term }),
  tagSuggestions: (pageId: number) => call<T.TagSuggestion[]>("tags_suggest", { pageId }),
  tagSuggestionsAi: (pageId: number) => call<T.TagSuggestion[]>("tags_suggest_ai", { pageId }),
  dismissTag: (pageId: number, tag: string) => call<void>("tags_dismiss", { pageId, tag }),
  duplicates: (pageId: number) => call<T.DuplicateHint[]>("duplicates_for", { pageId }),
  allDuplicates: () => call<T.DuplicatePair[]>("duplicates_all"),
  ignoreDuplicate: (a: number, b: number) => call<void>("duplicates_ignore", { a, b }),
  mergePages: (keep: number, other: number) => call<T.MergeOutcome>("pages_merge", { keep, other }),
  undoMerge: () => call<number[]>("pages_merge_undo"),
  pdfHighlights: (name: string) => call<T.PdfHighlight[]>("pdf_highlights_list", { name }),
  addPdfHighlight: (highlight: T.NewPdfHighlight) => call<T.PdfHighlight>("pdf_highlight_add", { highlight }),
  updatePdfHighlight: (id: number, patch: { color?: string; note?: string }) =>
    call<T.PdfHighlight>("pdf_highlight_update", { id, color: patch.color ?? null, note: patch.note ?? null }),
  deletePdfHighlight: (id: number) => call<void>("pdf_highlight_delete", { id }),
  pdfHighlightMarkdown: (name: string, id: number | null) => call<string>("pdf_highlight_markdown", { name, id }),
  appendToPage: (pageId: number, markdown: string) => call<void>("page_append", { pageId, markdown }),
};

// One listener in the shell per event name, shared by every `on` of that event: each listen and
// unlisten is an IPC call through the main thread, and a page switch subscribed and dropped
// dozens of them. Handlers run in the order they subscribed, as separate listeners did.
type Hub = { handlers: { h: (payload: unknown) => void }[]; ready: Promise<UnlistenFn> };
const hubs = new Map<string, Hub>();

export function on<P>(event: string, handler: (payload: P) => void): Promise<UnlistenFn> {
  let hub = hubs.get(event);
  if (!hub) {
    const handlers: Hub["handlers"] = [];
    const ready = listen<unknown>(event, (e) => {
      for (const x of [...handlers]) {
        try {
          x.h(e.payload);
        } catch (err) {
          // Like a listener of its own: the others still run, the error is still reported.
          setTimeout(() => {
            throw err;
          });
        }
      }
    });
    hub = { handlers, ready };
    hubs.set(event, hub);
    ready.catch(() => hubs.get(event) === hub && hubs.delete(event));
  }
  const h = hub;
  const entry = { h: handler as (payload: unknown) => void };
  h.handlers.push(entry);
  const drop = () => {
    const i = h.handlers.indexOf(entry);
    if (i >= 0) h.handlers.splice(i, 1);
  };
  return h.ready.then(
    () => drop,
    (err) => {
      drop();
      throw err;
    },
  );
}

/** URL of a stored attachment (served by the shell's `arcalo-asset:` protocol); folders in `![[a/b.png]]` are ignored. */
export function attachmentUrl(name: string) {
  const base = name.split(/[\\/]/).pop() ?? name;
  try {
    return convertFileSrc(base, "arcalo-asset");
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
  if (file.size > MAX_FILE_BYTES) throw new Error(t("files.tooBig", { mb: MAX_FILE_BYTES / 1024 / 1024 }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<T.SavedAttachment>("attachment_store", bytes, { headers: { "x-arcalo-name": encodeURIComponent(file.name || t("feed.kind.file")) } });
}

/** Errors from Rust arrive as plain strings. */
const KINDS: Record<string, TKey> = {
  netzplan: "wbs.netzplan",
  vorgang: "wbs.vorgang",
  leistungsart: "wbs.leistungsart",
  page: "err.kind.page",
  project: "err.kind.project",
  task: "err.kind.task",
  tool: "err.kind.tool",
  entry: "time.entry",
  backup: "err.kind.backup",
  version: "err.kind.version",
  attachment: "err.kind.attachment",
};

// A file path in a message: `C:\…`, `\\server\…` or `/a/b…`, up to the end of the line.
const PATH_RE = /(?<![\w:/.\\])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?=[^/\s]+\/))[^\n"“”„]*/g;

/**
 * Shortens long file paths in a message in the middle, keeping the drive (or first folder) and the
 * file name: `C:\Users\m\…\Kunde\Angebot.pdf`. The full text stays in the developer log.
 */
export function shortenPaths(text: string, max = 56): string {
  return text.replace(PATH_RE, (path) => {
    const trimmed = path.replace(/[\s.,;)]+$/, "");
    const rest = path.slice(trimmed.length);
    if (trimmed.length <= max) return path;
    const sep = trimmed.includes("\\") ? "\\" : "/";
    const parts = trimmed.split(sep);
    // Leading empty parts: `/home` and `\\server` keep their separators.
    let lead = 0;
    while (lead < parts.length - 1 && parts[lead] === "") lead++;
    const head = parts.slice(0, lead + 1).join(sep);
    const tail: string[] = [parts[parts.length - 1]];
    for (let i = parts.length - 2; i > lead; i--) {
      if (head.length + tail.join(sep).length + parts[i].length + 4 > max) break;
      tail.unshift(parts[i]);
    }
    if (tail.length >= parts.length - lead - 1) return path;
    return `${head}${sep}…${sep}${tail.join(sep)}${rest}`;
  });
}

/**
 * Backend errors as the user reads them: the core writes its messages in the display language;
 * a bare `netzplan 'NP-1' not found` becomes „Netzplan „NP-1“ nicht gefunden“ / “Network “NP-1”
 * not found”.
 */
export const errorText = (e: unknown) => errorParts(e).text;

/** Separator of a backend message and its technical text (`error::DETAILS` in the core). */
const DETAILS = "\n\nDetails: ";

/**
 * A backend error split into the message for the user and the technical text behind it
 * (SQLite's or the operating system's English words), which the toast keeps behind „Details“.
 */
export function errorParts(e: unknown): { text: string; details?: string } {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
  const at = raw.indexOf(DETAILS);
  if (at < 0) return { text: messageText(raw) };
  // Messages that wrap an error put their own words before it, so the rest is all technical.
  const details = raw.slice(at + DETAILS.length).trim();
  return { text: messageText(raw.slice(0, at)), details: details || undefined };
}

function messageText(raw: string) {
  const nf = /^(\w+) '(.+)' not found$/.exec(raw);
  if (nf) return t("err.notFound", { kind: KINDS[nf[1]] ? t(KINDS[nf[1]]) : nf[1], key: nf[2] });
  // Older texts (and re-wrapped ones) may still carry English prefixes.
  return raw
    .replace(/^(invalid state: )+/, "")
    .replace(/^could not parse command: /, `${t("err.parse")}: `)
    .replace(/^i\/o error: /, `${t("err.io")}: `)
    .replace(/^database error: /, `${t("err.db")}: `)
    .replace(/^http error: /, `${t("err.http")}: `)
    .replace(/^AI provider error \((\d+)\): /, (_all, code: string) => `${t("err.provider", { code })}: `);
}
