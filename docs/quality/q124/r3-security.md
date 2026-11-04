# q124 round 3, hunt C: security and privacy

Defensive review of every way note content, bookings, tasks, titles and calendar data can leave the computer, of
secrets at rest and in logs, of the IPC surface and the rendering of foreign HTML, of path handling, of the update
channel and of the lock screen. Severity as in `plan.md`; a leak of private content or secrets, script execution
from content and writes outside the data folder count as high. The privacy leaks to cloud models found in round 1
and 2 (H4-3, R2D-1, R2D-2) were not hunted again on their paths.

| Severity | Count | Findings |
|----------|-------|----------|
| High | 3 | R3C-1, R3C-2, R3C-4 |
| Medium | 1 | R3C-3 |
| Low | 7 | L1 to L7 |

All high and medium findings are fixed at the root with a test.

## R3C-1 (high): an answer of a model could send what it read to any server, through an image address

- Symptom: the CSP allows `https:` images (for images in notes). A Markdown image in an answer of the assistant, in
  the inline AI bar, the meeting summary, the day and week review, the briefing, and in the pages the backend writes
  from a model's answer (meeting preparation, status report, voice note summary), was shown as an image, so the
  WebView fetched `https://…?d=<text>` the moment the answer appeared or the page was opened. Text in a mail taken
  over as a note, a Jira issue, a web page fetched by a tool or an imported vault can steer a model, also the local
  one that is trusted with `#privat` pages, into writing such an image with the private text in its address: the
  text leaves the computer without any click. Rendered answers also kept `<style>` (the review views), `srcset`,
  `poster` and `url(…)` in styles, and a diagram of an answer could carry an image shape.
- Root cause: the answer renderers sanitized for scripts (DOMPurify) but not for loads; nothing treated the model's
  output as untrusted content that must not reach the network by itself.
- Fix: `withoutRemoteLoads` (UI `lib/markdown.ts`) runs over every rendered answer (`renderChatMarkdown`, the new
  `renderAiMarkdown` for the summaries, `svgWithoutRemoteLoads` for diagrams of answers): a remote image becomes a
  link with its address (opened only by a click), other remote sources, `srcset` and `url(…)` go, style sheets and
  forms are not allowed. Text of a model that goes into a page carries links instead of remote images in every form
  the page shows as an image (inline, references, nested brackets, raw `<img>`/`<image>`): UI `withoutRemoteImages`
  (built on the page's Markdown lexer; `cleanAiMarkdown`, „In Seite einfügen“, „Als Seite speichern“) and core
  `transform::clean_output` (all answers the backend writes).
- Tests: `ui/src/lib/airemote.test.ts` (ten attack forms in the chat and the summaries, diagrams, every image form
  for pages), `ai::transform::tests::remote_images_of_an_answer_become_links`, e2e
  `560-ai-remote-image` (the answer shows a link, no image, nothing fetched; the saved page holds a link).

## R3C-2 (high): the quick capture's text was written in clear next to the encrypted database

- Symptom: every keystroke in the quick-capture window wrote the draft (text and target) to the WebView's
  `localStorage`, a plain LevelDB file in the user profile. With the database encrypted, whatever was typed there
  (and LevelDB keeps deleted values until it compacts) lay on the disk in clear, outside what the encryption covers.
- Root cause: the draft was treated as a UI preference (`localStorage`), not as note content.
- Fix: the draft lives in the database (meta `capture.draft`, commands `capture_draft_get`/`capture_draft_set`,
  `capture::load_draft`/`save_draft`), saved 400 ms after typing stops and removed at once when the capture is
  stored or the field emptied. A draft an earlier version left in `localStorage` moves into the database and is
  removed there.
- Tests: `capture::tests::the_draft_lives_in_the_database`, `ui/src/lib/capture.test.ts` („the capture draft“: the
  move of an old draft, the debounce, nothing in `localStorage`), e2e `68-capture-window` (the draft is in the
  database and in no `localStorage` key, also after a reload; emptying the field removes it).

## R3C-3 (medium): opening an attachment could start code of types the program list missed

- Symptom: „Öffnen“ of an attachment (and of a Jira attachment) starts the file with its default app unless
  `attachments::is_executable` names its type; then it is only shown in the folder. Help files (`.chm`, scripts run
  without a question), app packages and ClickOnce (`.msix`, `.appref-ms`, `.appinstaller`), shell files
  (`.settingcontent-ms`, `.library-ms`, `.search-ms`), troubleshooting packs (`.diagcab`), Excel add-ins (`.xll`),
  scriptlets (`.sct`, `.wsc`), disk images (`.iso`, `.vhdx`, whose files lose their download mark) and macOS
  `.terminal`/`.workflow`/`.fileloc` were started. A mail attachment taken over into a note is such a file, and the
  copy in the attachments folder has lost the download mark Windows warns by. Names ending in a dot or space
  (`setup.exe.`, which Windows opens as `setup.exe`) were not recognized either; nor were types with a dash.
- Root cause: an incomplete list, and the check went through `file_extension`, which takes letters and digits only.
- Fix: the list names these types; `is_executable` takes the whole extension (dashes included) after removing the
  dots and spaces Windows ignores.
- Test: `attachments::tests::file_extensions` (the new types, trailing dot and space, harmless types stay).

## R3C-4 (high): a link the UI did not handle took the app's window to the web page

- Symptom: links in an AI summary (reviews, briefing, inline AI bar, meeting summary), in a link preview or source
  card, in the release notes and on slides have no click handler of their own. A click (or a redirect) loaded the web
  page into the app's window: the app was gone until a restart (no way back), text typed in the last second was not
  saved, and a foreign page sat in the app's window looking like the app (a fake lock or recovery screen). The app's
  commands were not reachable from it (Tauri refuses them for remote origins; checked), new windows were not handled
  either.
- Root cause: no window had a navigation handler; every link was left to the WebView's default.
- Fix: `navigation.rs`: every window (main, quick capture, quick search, presenter, recovery screen) loads only the
  app's own addresses (`on_navigation`); other http(s) and mailto addresses open in the browser or mail program,
  anything else (`file:`, other schemes) is refused; new-window requests do the same.
- Tests: `navigation::tests::only_the_apps_own_addresses_load_in_its_windows`, e2e `561-navigation` (a link and a
  redirect to a local web page: opened outside, the window stays on the app, the page is never loaded).

## Low

- L1: a Git remote URL typed with a token in it (`https://user:token@host/…`) is stored in the settings file as
  typed; the settings sync drops it (`settings_sync::scrub`) and logs redact it, but it is not moved to the
  credential store. The wizard asks for the token separately.
- L2: captures waiting for a busy database are queued in `capture-queue.json` in the data folder, in clear also for an
  encrypted workspace, until they are stored (seconds normally).
- L3: „Tags mit KI vorschlagen“ sends the 200 most used tags as vocabulary; tags of private pages are among them (the
  page itself is routed by its privacy).
- L4: the Excalidraw library (drawings the user added to it) is kept in `localStorage`, outside an encrypted database.
- L5: the release notes of an update (from GitHub, not signed) are rendered with style sheets allowed; only the
  release owner controls them.
- L6: images of notes from other servers (`![](https://…)`, also in imported vaults and pasted HTML) load when the page
  opens and tell the server the address and the time. As in other Markdown apps; R3C-1 covers text of models.
- L7: a PAC file runs in the sandboxed `arcalo-pac:` frame with `eval`; the frame has no network and no app commands.

## Checked without findings

- AI routing for every entry point not covered earlier: `ai_transform` (page content and tags), `zeit_suggest_ai`,
  `tags_suggest_ai`, the mail task suggestion (local provider only, `private marker` route, fallback only to local
  models), meeting preparation and follow-ups, the briefing (calendar events marked private, prep pages, tasks of
  private pages), the day review (local only), embeddings of questions and pages, „Nur lokal“, „KI verwenden“ off
  (no client is built, `complete_routed` and `network::client_for` refuse).
- Secrets: the developer log redacts stored keys, proxy passwords, Git and Jira tokens, ICS URLs and known key
  formats; the diagnostics bundle and the settings export/sync drop secret fields; ICS errors carry no URL
  (`without_url`); the database key, the recovery key and the PIN hash are only in the credential store.
- Rendering: notes, chat and Jira HTML go through DOMPurify (Jira with an allowlist, its images through the site's
  client); chat answers show raw HTML as text; Mermaid runs with `securityLevel: strict` and SVG labels; the CSP has
  no `unsafe-eval` or inline scripts; attachments are served with `default-src 'none'` and `nosniff`.
- Paths: `arcalo-asset:` and `attachments::resolve` accept plain names inside the folder only (canonical path);
  staged mail files must be `<16 hex>/<name>`; vault import skips symlinks and hidden folders.
- Updates: the minisign signature is checked against the built-in key and must name the announced version; a lower
  or pre-release version is never offered.
- Lock screen: commands are refused while locked, the main window unmounts the app, popups and the presenter view
  are covered, notifications are generic, the window title is reset.
