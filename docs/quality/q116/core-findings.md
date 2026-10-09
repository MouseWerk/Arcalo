# Arcalo 1.16 audit: Rust core and shell (logic, data integrity)

Scope: `crates/arcalo-core`, `src-tauri`. Base: main at 1.15.0 (de27e1c). I read the newest quality
docs (q115, q113-*, q112-data/data2/time/time2) so these are not repeats. Every "confirmed" entry was
reproduced with a throwaway test in `arcalo-core` (all reverted; the probe file is kept for reuse at
`scratchpad/q116/core-probes.rs`, `#[cfg(test)] mod zz_probe;` in `lib.rs`; run with
`TZ=Europe/Berlin cargo test -p arcalo-core --lib zz_probe -- --test-threads=1 --nocapture`). Entries
in `src-tauri` that could not be run without building the app are marked "confirmed by code path".

Severity: critical = silent loss/corruption, high = data at risk or crash or wrong state many users hit,
medium = wrong behaviour/numbers with a workaround, low = edge case or polish.

Counts: high 5, medium 8, low 4 (17 confirmed). 7 more under "suspected, not confirmed".

---

## C1 (high): A page moved on one computer is deleted and re-created on the other; more than ten moves (Aufräumen) duplicate every moved page on both computers — fixed in 1.16 (gitsync `moved_notes_are_pulled_as_moves`, `moves_meet_edits_without_losing_either`; syncmerge `moved_pages_keep_their_id_on_the_other_computer`)

Repro (probe `p1_moves_on_one_computer_duplicate_or_recreate_pages_on_the_other`, two in-memory
workspaces, one bare remote, real mirror + `gitsync::sync` + a faithful copy of `syncmerge::apply`):
- A moves one page below a new parent and syncs; B syncs: B trashes its page and creates a new one
  (page id 2 -> 15). Version history, time entries (`page_id`), meeting/calendar links, properties,
  icon and creation date of that page stay with the trashed copy.
- A moves 11 pages at once (what „Aufräumen“ does with year/month folders) and syncs; B syncs:
  `created 11 trashed 0 kept 11`: every moved page now exists twice on B. B's next sync uploads the
  old paths again, A pulls them as new pages: A has every one of them twice as well.

Root cause: the pull is path based. `gitsync::changed_paths` diffs with `--no-renames`
(gitsync.rs:1316) and `syncmerge::apply` maps files to pages only by path (src-tauri/src/syncmerge.rs:84-170):
the old path is a deletion (trash, or kept by the mass-deletion guard at :100/:120), the new path a
new page (`create_page` :159). The sender-side guard uses `-M` (gitsync.rs:1146) so the move is a
rename there, but the receiver has no rename notion at all. The same happens for a renamed title.

Fix: carry renames through the pull. In `merge_remote`/`pulled` compute `git diff -M --name-status`
between base and theirs and emit a `RemoteChange` with `from: Option<String>` for `R` entries; in
`apply`, a rename whose old path maps to a live page moves that page (new parent from the folder
map, title from the stem when it differs) and saves the new content if it changed, instead of
trash+create. Exclude renamed old paths from the mass-deletion count. Optional and more robust:
write a stable page id into the mirror (`<!-- arcalo:id … -->` or frontmatter `arcalo-id`) and match
by it first.

Guard test: core `gitsync` test with a bare remote: move 1 and 12 pages on A, assert B's
`remote_changes` carry the renames; shell `syncmerge` test `moved_pages_keep_their_id_on_the_other_computer`
(same page id, parent changed, no duplicates, nothing in the trash) plus a round trip A->B->A without
duplicates.

## C2 (high): A `location.json` that names the old default folder keeps 1.15 working in `app.annalo.desktop` and copies the whole data folder again at every start (and 1.17 would delete the live workspace)

Repro (probe `p6_location_json_naming_the_old_default_folder`): old folder with a workspace and a
`location.json` whose `data_dir` is that same folder; three starts of `identity::migrate` +
`datadir::prepare`: the data folder used is `app.annalo.desktop` every time; start 2 and 3 return
`Refreshed` and set a full copy aside (`de.mousewerk.arcalo.<stamp>`), and the user gets the notice
„Daten der älteren Version übernommen“ each start.

How users get such a file: `data_dir_cancel` (src-tauri/src/lib.rs:4259, „Verschieben abbrechen“)
writes `location.json` with the *current* folder, i.e. the default folder path; a failed move at
start keeps `data_dir` as written by `write_pending_move` (datadir.rs:79, the current folder). On
Windows/macOS data and config are one folder, on Linux the config folder copy carries it too.

Root cause: identity.rs copies `location.json` verbatim; `datadir::prepare` (datadir.rs:224) treats
any existing folder with a workspace as the chosen folder, so the legacy default path wins over the
new default. The 1.15 work then lands in the old folder, whose changed stamp makes
`migrate_one` (identity.rs:220) "refresh" at every start: unbounded disk use (one full data copy per
start, attachments and backups included), slower starts, a misleading notice. The planned 1.17
deletion of the old Annalo folders would delete this user's live workspace.

Fix: in `identity::migrate` (or in `datadir::prepare`), after the copy, rewrite a `location.json`
whose `data_dir` or `pending_move` is the legacy identifier folder (or lies inside it) to the new
folder (better: clear `data_dir`, which means default). Also stop `data_dir_cancel` from writing the
default folder as an explicit path (write `data_dir: ""` when `state.data_dir == default`). Before
1.17 deletes old folders, refuse when any `location.json`, `backup_dir`, `markdown_mirror_dir` or
backup destination points into them.

Guard test: core identity test „a location.json naming the old default folder is moved to the new
one“: after `migrate` + `prepare`, `dir == new`, second `migrate` returns `Done`, no aside folder.

## C3 (high): Ticking off a repeating task panics (app crash, `panic = "abort"`) when the text after the Obsidian done marker has a multi-byte character at byte 10

Repro (probe `p10_tick_repeating_task_with_umlaut_after_done_marker`): page
`- [ ] Rechnung prüfen every:monthly due:2026-10-05 ✅ erledigt äh`, `edit_tasks(.., Done{true}, ..)`
panics at taskedit.rs:224:63 (byte index 10 is not a char boundary). Also `✅ ✅ ✅ ✅`, emoji, etc.
Release builds use `panic = "abort"` (Cargo.toml:16), so this ends the whole app (unsaved editor
state included); the same path runs for the start page widgets via `task_set_done`.

Root cause: `next_line` slices `&date[..10]` after checking `date.len() >= 10` (bytes).

Fix: `date.get(..10).filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())`. Worth a grep for
the same pattern elsewhere (none other found in core).

Guard test: `taskedit` unit test with `✅ erledigt äh` and `✅ 🎉🎉🎉`: no panic, next occurrence added,
the text after the marker kept.

## C4 (high): The start page shows the flat daily target: own weekday targets, public holidays and absences are ignored („Heute“, „Zeit diese Woche“, week proposal total)

Repro (probe `p13_dashboard_today_target_ignores_weekday_targets_holidays_absences`, NW, weekday
targets Mo-Do 8 h, Fr 5 h, vacation on Wed 2026-10-07):
`2026-10-09 (Fri): dashboard target 480 vs gap_target 300`, `2026-10-07 (vacation): 480 vs 0`,
`2026-12-25: 480 vs 0`. The UI shows „Fehlt 8 h“ on Christmas and on vacation days and 8 h instead
of 5 h on Fridays (day.tsx:230, :655).

Root cause: `dashboard::Ctx::target_minutes` (dashboard.rs:329) uses `daily_target_hours`, and
`is_workday` (:333) only `settings.workdays`; used by `today` (:453), `week` (:553) and the proposal
total (:748). The 1.12 fix (q112-time #1/#2) moved the timesheet, day review and proposals to
`worktime::gap_target`, the start page was left out.

Fix: `target_minutes: gap_target(db, day, weekday_minutes(settings, day))` for `today`; per-day
targets in `WeekData` (and a week total that is the sum of the days' gap targets) for `week` and
`proposal`; `workday` = the day has a target > 0 (weekday target), so a Saturday with own hours
counts too. Same change in `weekplan::open_days` (weekplan.rs:1385) and `propose_week` (:653), which
still gate by `settings.workdays` (a Saturday with own hours is never a gap).

Guard test: core dashboard test with weekday targets, a holiday and an absence: `Part::Today`
target equals `gap_target`; `Part::Week` totals.

## C5 (high): Rolling back from 1.15+ to 1.14 writes the "bad version" mark and the rollback notice into the new data folder, which 1.14 never reads — fixed in 1.16 (rollback `a_rollback_to_114_is_recorded_where_114_reads_it`)

Confirmed by code path (shell, not runnable here): a 1.14 user updates to 1.15/1.16, the new version
fails twice, rollback offered (or „Zur vorherigen Version zurückkehren“). `rollback::restore`
(src-tauri/src/rollback.rs:173-185) restores the pre-update database into `dir` (the new
`de.mousewerk.arcalo` folder), `mark_bad(to)`, writes `rolled-back.json` and clears the record there.
The reinstalled 1.14 starts on `app.annalo.desktop`: its `UpdateState` does not know the version is
bad, so the same broken version is offered (and with automatic installs installed) again, and the
user never sees the „zurückgekehrt“ notice. Its old `RollbackRecord` is still there.

Fix: when `record.from` is older than 1.15 (the version that moved the folders), also write the bad
mark, the notice and the cleared record into the legacy folder (`identity::LEGACY_IDENTIFIER` next to
`dir`, only when it exists); restoring the database there is not needed (1.14 sees the state of the
copy). Same for portable/custom folders: nothing to do (one folder).

Guard test: shell unit test on `restore` with a temp layout (new folder + legacy sibling): the
legacy `updates/state.json` lists the bad version, `rolled-back.json` exists there.

## C6 (medium): A note deleted on this computer while another computer edited it: the edit is dropped without a conflict (it ends in the other computer's trash) — fixed in 1.16 (gitsync `a_note_deleted_here_and_edited_there_comes_back`; syncmerge `a_page_deleted_here_and_edited_there_comes_back`)

Repro (probe `p2_local_deletion_drops_the_servers_edit_without_conflict`): A and B synced; B edits
`Notiz.md` and pushes; A deletes it and syncs: message „1 Datei geändert“, `remote_changes` empty,
the server tip has no `Notiz.md`. B's next sync trashes B's page (unchanged there since its push).

Root cause: gitsync.rs:1410-1413 keeps "this side's state" for a deletion on one side, including
"deleted here, edited there". Edit-wins-over-delete is the usual rule; the comment in
syncmerge.rs:140 („deleted there and edited here: this side stays“) shows the opposite direction
is handled.

Fix: in `merge_remote`, when `mine_id.is_none()` and `theirs_id.is_some()` for a note, take the
server's file (`take_path(theirs)`) and return it as a `RemoteChange { mine: None, theirs, conflict:
false }` so the shell re-creates the page (and tells the user „wieder hergestellt, auf dem Server
bearbeitet“).

Guard test: core gitsync test as the probe: after A's sync the server keeps B's text and A's
`remote_changes` contains it.

## C7 (medium): The in-memory vector index keeps the vectors of edited chunks; they crowd out other pages in search by meaning and grow without bound

Repro (probe `p9_vector_index_keeps_stale_chunks`): two pages edited alternately 40 times with an
embedding stored each time: `index rows 82 for 3 live chunks; results before [1, 2] after [1]`:
the second page no longer appears.

Root cause: `reindex_page` deletes an edited chunk's row and inserts a new one (new id,
notes.rs:350-360); `VectorIndex::sync` (semantic.rs:283) only adds/overwrites by id from the store
log, never removes. `top_rows` (k = limit*6+8) is filled by stale near-duplicates; `search` drops
them only after the cut. The `STORED` log in rag.rs:53 also grows for the whole session.

Fix: log deletions too (`rag::stored` gets a `removed(block_id)` call from `reindex_page`'s delete
and from page purge), and remove those slots (swap-remove) in `sync`; or have `sync` drop rows whose
id is gone when the stale share exceeds e.g. 20 %. Trim the `STORED` log once every reader has
passed a position (or keep only the last N and force a full reload when a reader is behind).

Guard test: semantic unit test as the probe: after 40 edits `idx.len() == live chunks` and the other
page is found.

## C8 (medium): Settings sync carries provider ids (router tiers, embedding provider/model) although providers are per computer: the second computer's assistant and search by meaning break — fixed in 1.16 (settings_sync `provider_choices_stay_on_their_computer`)

Repro (probe `p11_settings_sync_carries_provider_ids`): synced keys include `embedding_model`,
`embedding_provider`, `router.local_provider`, `router.standard_provider`, `router.reasoning_provider`.
Computer A uses provider `firma-ollama`; on B (providers `[litellm]`) `apply` sets
`router.standard_provider = firma-ollama`. B's assistant then fails with „Der KI-Anbieter
„firma-ollama“ ist nicht eingerichtet …“ (lib.rs:295), search by meaning becomes `ProviderOff`, and a
changed embedding model clears B's whole vector index (`ensure_index_model`). `prices` (per provider)
and `auto_route` ride along too.

Root cause: settings_sync.rs:31-56 excludes `providers` but not the keys that reference them;
`router` is in `SECTIONS` (:76).

Fix: add `embedding_provider`, `embedding_model`, `prices` to `EXCLUDED` and
`router.*_provider`/`router.*_model` to `EXCLUDED_FIELDS` (or: apply a provider reference only when
that provider id exists on this computer, in `apply`).

Guard test: settings_sync test: B without A's provider keeps its router and embedding settings.

## C9 (medium): The AI-off guard has a bypass: Settings → Netzwerk „Testen“ of an AI provider (and the LiteLLM test and the legacy probe) sends requests with the provider key while „KI verwenden“ is off or forbidden by policy

Confirmed by code path: `network_service_test` (src-tauri/src/network.rs:437) builds its own client
via `http_test` (:370) and calls `provider.authorize(req, key)` for `Service::Ai` targets; it never
calls `require_ai`. `services()` (:259) lists every enabled provider whatever `ai.enabled` says, and
NetworkSection.tsx:93 offers „Testen“ on every row. Same for `network_test` (:527, LiteLLM model
list with the stored key) and `network_legacy_probe` (:579, HEAD to AI hosts). `client_for` (:57)
and `provider_client` (lib.rs:151) guard, these three do not; with `AllowAi = 0` an admin's policy is
bypassed.

Fix: in `services()` skip AI providers (and `HttpTool`) when `!settings.ai_on()`; in
`network_service_test`/`network_legacy_probe` refuse `Service::Ai | HttpTool` with `require_ai()`;
in `network_test` call `require_ai()` first.

Guard test: shell unit test on `services()` with `ai.enabled = false` (no `ai:*` rows), and one that
`network_service_test("ai:litellm")` errs with `ai_off()` (lib.rs:5232 has a similar test for
`provider_client`).

## C10 (medium): Identity migration: a failure after the copy was committed (marker not written) leaves a stale copy that the next start keeps for good; the fallback session's work stays invisible — fixed in 1.16 (identity `a_copy_left_without_its_marker_does_not_hide_the_fallback_sessions_work`)

Repro (probe `p5_identity_post_commit_failure_hides_the_fallback_sessions_work`): first start:
`commit` moves the copy in, `write_record` fails -> `Failed`, the app works in the old folder and
saves „in der Ausweich-Sitzung geschrieben“. Next start: `Copied { kept: ["workspace.db"] }`, the
new folder keeps the stale database („vor dem Update“), the marker is written with the current
stamp, from then on `Done`. Same when `commit` merges into a pre-existing folder and a rename fails
midway.

Root cause: identity.rs:269-273: after `commit` succeeded, an error leaves `to` populated without a
marker; the next `copy_verified` merges and never overwrites (`commit`, :281-292).

Fix: write the marker into the staging folder before the rename (it is skipped when copying), so
a renamed folder always has it; or on failure after `commit` move `to` aside (as `Refreshed` does)
so the next start copies into an empty folder. In the merge case, treat a `to` that has a
`workspace.db` the old folder does not match as "set aside" instead of "keep".

Guard test: identity test as the probe (obstacle folder in place of the marker): after the next
start the new folder holds the fallback session's text.

## C11 (medium): Pages titled „README“ or below a page „Zeiterfassung“ never reach the other computer, and the sync deletes/re-adds them on every run — fixed in 1.16 (vault `page_paths_never_take_the_syncs_own_names`; syncmerge `pages_named_like_the_syncs_own_files_reach_the_other_computer`)

Repro (probe `p12_pages_named_like_the_syncs_own_files`): A has a page „README“ and a page
„Zeiterfassung“ with a subpage „Regeln für SAP“; B after its sync has only „Zeiterfassung“.

Root cause: the mirror plans file names without reserved names (vault.rs Planner `unique`,
:525-537), so the page lands at `README.md` / `Zeiterfassung/Regeln für SAP.md`; the pull skips
`readme.md` and everything below `zeiterfassung/` (syncmerge.rs:76-78). B's next sync drops the files
from the repository, A's next sync adds them back: an endless add/delete pair of commits.

Fix: reserve `README.md`, `README.txt`, `Zeiterfassung` (folder), `attachments` (folder),
`.gitattributes`, `settings.json` and the database copy names at the top level in the Planner
(`taken` pre-filled; the page becomes `README (2).md`, `Zeiterfassung (2)/…`), and keep the pull
filter for the exact own files only (`zeiterfassung/*.csv`).

Guard test: vault test that `page_paths` never yields reserved names; shell two-computer test with
both page names.

## C12 (medium): Repeating tasks: `every:monthly,15` skips the current month, `every:yearly` from 29 February drifts to the 28th for good, `every:monthly` from the 31st drifts to the 28th

Repro (probe `p4_recurrence`): `monthly,15` due 2026-01-10 -> 2026-02-15 (expected 2026-01-15);
`yearly` from 2024-02-29 -> 2025-02-28, 2026-02-28, 2027-02-28, 2028-02-28 (expected 2028-02-29);
`monthly` from 2026-01-31 -> 02-28, 03-28, 04-28 … (the dialog writes `monthly,31` for 29-31, but a
typed `every:monthly` and every imported Obsidian rule drift).

Root cause: recurrence.rs:293-294: `step` always adds `n` months, also when the month day lies
later in the base month (the weekly branch handles "later this week", the monthly one does not);
the yearly and plain monthly steps take the day of the *previous occurrence*, not of the series.

Fix: monthly with `month_day`: if `base.day() < month_day` (clamped) return this month's day first.
Keep the series' day: for `Unit::Year` and monthly without day, `next_due` should carry the original
day (from the due date the series started with) — simplest: when `due.day()` is the last day of
its month and > 28, use `month_day = Some(31)` semantics; for yearly keep 29 Feb when the target year
is a leap year (compute from the first due, e.g. `add_months(first_due, 12*k)`).

Guard test: recurrence unit tests for the three cases above.

## C13 (medium): ICS: an all-day series ignores EXDATE given as date-time, and a RECURRENCE-ID given as date-time shows the moved instance and the original

Repro (probe `p8_all_day_exdate_as_date_time`, local zone Berlin): `DTSTART;VALUE=DATE:20261005`,
`RRULE:FREQ=WEEKLY;COUNT=4` with `EXDATE:20261012T000000` or `EXDATE;TZID=Europe/Berlin:20261012T000000`:
10-12 still shows. With an override `RECURRENCE-ID:20261012T000000` moved to 10-13: both 10-12 and
10-13 show.

Root cause: ics.rs:722-727 compares `When::Time` exdates by wall time in the series zone, which is
`Zone::Utc` for all-day series (:690), so 00:00 Berlin becomes 22:00 the day before; RECURRENCE-ID
keys (:662) are UTC instants for times and dates for all-day instances, so they never meet.

Fix: for an all-day master, take the date of every EXDATE/RECURRENCE-ID in its own zone (floating ->
local) and match by date (`ex_days`, `When::Date` key). Several producers (Exchange, some CalDAV
servers) write these with a time.

Guard test: ics unit test with both forms (and the override).

## C14 (low): „Aufräumen“ files untyped-date pages by the UTC date of `created_at`

Repro (probe `p3_tidy_uses_the_utc_creation_date`, TZ=Europe/Berlin): a voice note created
2026-11-01 00:30 local (`created_at` 2026-10-31T23:30:00Z) is planned into „Sprachnotizen / 2026 / 10 –
Oktober“, and `tidy_apply` records `file_date = 2026-10-31`.

Root cause: tidy.rs:183 `date_of(&r.created)` takes the first ten characters of the UTC stamp.
Same pattern: the note query's „geändert“ column (dashboard/query.rs:337 via `date_cell`, :249:
`geändert = heute` misses edits between 00:00 and 01:00/02:00) and RAG chunk dates (ai/rag.rs:333).

Fix: parse the stamp (`db::parse_ts`) and take `with_timezone(&Local).date_naive()` (pass the tz
through `Snapshot::read`); same in `date_cell` for timestamps.

Guard test: tidy test with a fixed zone (`Snapshot` taking a `Tz`): a page created 23:30Z on the
last of the month in UTC+1 goes to the next month.

## C15 (low): A vacation day on a public holiday or weekend counts against the vacation account

Repro (probe `p14_vacation_on_a_holiday_counts`): BY, single-day vacation on 2026-12-25:
`taken 1 left 29`.

Root cause: `save_range` stores a single day as chosen (worktime.rs: `from == to ||`), and
`vacation()` (worktime.rs:449) sums every vacation absence of the year, also on days without target
(holiday, weekend, a part-timer's free day) and days that became holidays after a state change.

Fix: count `Absence::days()` only for days with `weekday_minutes > 0` and no holiday (the same rule
`save_range` uses for ranges); show such entries as "kein Urlaubstag" in the list.

Guard test: worktime test: vacation on a holiday and on a Saturday: taken 0.

## C16 (low): Holidays: Berlin's one-off „Tag der Befreiung“ on 8 May 2020 is missing

Repro (probe `p7_berlin_2020`). holidays.rs:86 adds it for 2025 only; 2020 (75th anniversary) was a
public holiday in Berlin as well (balance and absences of 2020 are off by a day for Berlin users
whose balance starts before that).

Fix: `state == "BE" && (year == 2020 || year == 2025)`. Test: holidays test for BE 2020.

## C17 (low): Untranslated user-facing errors (German in the English UI)

Confirmed by code: backupdest.rs:470 „Kopiervorgang abgebrochen“ (backup destination failure shown in
Settings → Sicherung), capture.rs:362 „Nichts zu erfassen“, calendar.rs:37 and report.rs:65 „'to' liegt
vor 'from'“, outlookcom.rs:48 „Outlook (klassisch) gibt es nur unter Windows.“, src-tauri/src/mail.rs:80/87
„Dateiinhalt fehlt“/„Dateiname fehlt“, ai/client.rs:441 „Download abgebrochen“, export.rs:91 and :211
`skipped` reasons in English only ("timer still running", "no Jira issue mapped …"; currently only
counted by the UI, but part of the command result), companion.rs:122 "daily note".

Fix: `tr!` pairs; a test in the translation check that scans `Error::State("` / `Error::Parse("`
literals without `tr!` in non-test code.

---

## Suspected, not confirmed

S1 (medium): backup destination copies that hang in the OS leave a thread behind each time — checked, not a bug: the stuck copy holds its destination's busy flag (`Busy` in the work closure), so `pass` skips that destination ("still busy with the previous copy") and no further thread starts
(`run_watched`, backupdest.rs:451 „the thread is left behind“); with a share that keeps hanging, a
new attempt every 15 minutes adds a stuck thread each time (no cap, no "previous attempt still
running" check found). Needs a test with a hook that blocks forever and two deliveries.

S2 (medium): a secret changed in 1.14 after a rollback is ignored by 1.15 when the workspace lives in — confirmed (also in the default folder: the stale new entry is read first) and fixed in 1.16 (secrets `after_a_rollback_to_114_its_secrets_are_taken_over_again`)
a custom/portable folder: `credentials-moved.json` sits in the data folder (shared by both versions),
so the account counts as moved and the stale `Arcalo` entry wins (secrets.rs:461 `take_over`,
`read_with_fallback`). The default-folder case is fine (Refreshed copies a folder without the moved
file). Needs a keyring double to prove.

S3 (low): settings rollback: 1.14 saving settings over 1.15/1.16 ones keeps `version: 16` (its — checked, not a bug: 1.14 keeps unknown keys when it saves the settings (`unknown_keys`/`restore_key` in its settings.rs), so `ai.enabled` survives
`migrate` writes `from.max(SETTINGS_VERSION)`) but drops `ai.enabled`; back on 1.16 the default
(`true`) applies, so a user who chose „Ohne KI“ has the AI on again after a rollback + update.
Depends on 1.14's serializer dropping unknown keys (not checked against the 1.14 tag).

S4 (low): `@29.02.` in `/zeit` on 2028-02-28 resolves to 2028-02-29 (future: "Buchungen dürfen nicht
in der Zukunft enden") because `with_year(2027)` fails and falls back to the future date
(zeit.rs parse_date, last branch); in a non-leap year it is an error instead of the most recent 29 Feb.

S5 (low): the git sync's deletion guard on the receiving side (`syncmerge::apply`) counts deletions — fixed in 1.16 with C1 (a move has `theirs`, so it is no deletion for the guard)
from a *rename-heavy* pull (C1) and then keeps pages that really were deleted together with them;
fixed by C1.

S7 (low): first settings sync of a fresh computer: `theirs_wins` (settings_sync.rs:250-256) lets the — not fixed: product decision (documented as intended)
server win for settings neither side ever changed (`at == 0` on both), so a second computer adopts
language-dependent defaults of the first; documented as intended, listed for a product decision.

S6 (low): `gitsync::merge_remote` takes non-note files changed on both sides "this side" (e.g. — confirmed, not fixed: attachments keep their name (only pasted images are content-hashed), so two different files of one name flip in the repository; neither computer loses its own copy (`copy_new_attachments` never overwrites). A fix needs a rename plus link rewrite on one side; proposed for 1.17
`attachments/x.png` replaced on both computers): the server's file is overwritten without notice.
Rare (attachments are content-hashed names?) — not checked.

---

## Checked, fine (no finding)

AI guard on every assistant/provider path (`AiRuntime::new`, `provider_client`, `client_for`,
`semantic::plan`); export CATS rounding per day and CSV formula defusing; timer split over midnight
and DST (`split_run`, `next_midnight`); `/zeit` durations/spans/dates; ICS RRULE expansion limits
(rrule `all(limit)` counts in-range instances only), DST wall-clock expansion, Outlook VTIMEZONE from
1601; backups via `VACUUM INTO .partial`, restore set-aside/undo, pending restore order; trash
purge detaching children; search FTS query quoting; identity copy/verify/marker idempotence (except
C10), webview cache skipping, cache moves; credential take-over read-back; settings migration chain
idempotence; holidays (Easter, Buß- und Bettag, Reformationstag rules) apart from C16.

Note: `crates/arcalo-core/tests/zz_tmp_perf116.rs` is an untracked file that is not mine (another
agent's); I left it alone. My probes were removed; `git status` shows only that file.
