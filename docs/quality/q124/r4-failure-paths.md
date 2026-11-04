# q124 round 4, hunt C: failure paths of the network integrations

Every integration that goes over the network, driven into its failure modes with fake servers: Jira (Cloud and
Server: sync, the issue view's edits, transitions, comments, worklogs, attachments), calendar feeds (ICS
addresses; the Outlook paths that run on Linux through the fixture), AI providers (chat, embeddings, the model
list), the Git remote, the update feed, link titles and the voice model downloads. Answers checked: 401/403,
404, 409, 429 with `Retry-After`, 500/502/503, slow and silent servers, truncated and invalid bodies, HTML login
pages instead of data, redirects to another host, certificate errors of a company CA, DNS failures and proxies.
Also the intermittent failure of `e2e/tests/84-outlook-calendars` in CI run 41798196710 (attempt 1). Branch
`q124-r4c`. The findings of [r3-integrations.md](r3-integrations.md) and [r2-work-phone.md](r2-work-phone.md)
were not hunted again.

Severity as in the [plan](plan.md): lost or duplicated data and hangs are high, a misleading or missing error with
no way forward is medium.

## Findings

### R4C-1 A setting switched on flips back off when the core stores settings at the same moment (high)

- Symptom: the CI failure of `84-outlook-calendars` (attempt 1 of run 41798196710): after the click on „Outlook-
  Kalender lesen“ the switch was off again and the calendar list never appeared (screenshot
  `FAIL-discovery-lists-every-calendar-of-Outlook-with-its-badges.png`); the nine tests after it failed as a
  consequence. For a user: a switch or value changed in the settings goes back by itself, or a calendar selected
  in „Kalender auswählen“, a color, a Jira search or the Kalender's „Termine in Outlook eintragen“ is taken back
  by a settings change saved right after it.
- Root cause: an app race in two places. (1) Every settings write of the core reads the settings, changes its
  part and stores the whole object (`calsync::save_calendar`, `jira::save_jira`, the start page, the sidebar
  links, the setup), and `settings_save` stores the whole object the window sends; nothing kept two of them
  apart. The switch's save and the calendar discovery it starts at once (which stores the names it found for the
  default calendar) ran together: the discovery read the settings before the switch was stored and wrote them
  back after it, with Outlook off. (2) The window builds each save on its copy of the settings; a change the core
  stored that had not reached that copy yet was written back to its old value. And `refreshSettings` took any
  answer, also one asked for before a save landed and answered after it, which put the form back.
- Fix: one settings write at a time (`AppState::settings_write`, `AppState::change_settings` for every partial
  write of the core, `settings_save` and the setup's writes under the same lock). A save of the window names the
  copy it changed (`settings_save(settings, base)`, `writeSettings` and the setup pass it): only what the window
  changed is taken, every other value stays as stored now (`settings::merge_change`, a three-way merge by key).
  `refreshSettings` takes only the newest answer and none over a save that landed meanwhile.
- Tests: `settings::tests::a_save_from_an_older_copy_keeps_what_changed_since`; UI `store/app.test.ts`
  (`refreshSettings`), `lib/settingsWrite.test.ts` (the copy is named); e2e `620-failure-paths` (a save from an
  older copy, and saves of the window and of the core at the same time, ten rounds); `84-outlook-calendars` ran
  green repeatedly.

### R4C-2 A comment Jira took is reported as failed when the issue cannot be read again; trying again posts it twice (high)

- Symptom: in the issue view, a comment sent while Jira (or a gateway in front of it) does not answer the read of
  the issue right after it (a timeout of the heavy issue request, a 502/504) showed „Kommentar nicht
  gespeichert“ with the text kept. The comment was in Jira; sending it again, as the message invites, made a
  second one. The same for a status change (the retry then fails with a confusing error), a field edit (the retry
  shows a conflict with the user's own value), an assignment, editing and deleting a comment and deleting a
  worklog.
- Root cause: `jira_full_comment_add` and the other edit commands posted the change and then returned the error of
  reading the issue again; only logging work (R3D-6) fell back to the last copy.
- Fix: after a change Jira took, a failed read shows the last copy with the error („Stand von …“, read only, with
  „Erneut versuchen“) instead of failing (`issueview::after_change`, used by every edit command).
- Test: e2e `620-failure-paths` (the comment is posted once, „Kommentar hinzugefügt“, the last copy with the 502,
  and after „Erneut versuchen“ the comment is shown once); `fake-jira.js` learned `failReadsAfterWrite`.

### R4C-3 A calendar download cut off midway empties the calendar until the next sync (medium)

- Symptom: an ICS subscription whose answer broke off (a proxy or server closing the connection before the end;
  without a length the body just ends) was read leniently as a calendar with fewer appointments: the rest
  disappeared from the Kalender, the start page and the booking proposals until the next sync, while the status
  said „synchronisiert“.
- Root cause: `ics::parse` closes components left open at the end of the data (right for hand-written files) and
  `ics::fetch` did not check that a download arrived whole.
- Fix: a download that begins a `VCALENDAR` but never ends it is an error („Der Kalender kam unvollständig an …
  Die Termine der letzten Synchronisierung bleiben“), so the appointments of the last sync stay; files keep the
  lenient reading.
- Test: `calsync::ics::tests::a_download_cut_off_midway_keeps_the_last_sync`.

### R4C-4 A sign-in page of a Wi-Fi or proxy disables the embedding model for the session (medium)

- Symptom: behind a hotel Wi-Fi's or a company proxy's sign-in page (status 200, HTML), the search by meaning
  marked the embedding model as one that „liefert keine Embeddings (die Antwort ist keine Embedding-Liste)“ and
  told the user to choose another model; after signing in, the index stayed stopped until the settings were saved
  again. The model list of the provider dialog said „error decoding response body“.
- Root cause: `AiClient::embed` and `get_json` decoded any successful answer as JSON; the decoding error of a web
  page counts as a lasting failure of the model. The chat already recognized such pages.
- Fix: a web page where JSON is expected is the chat's error („… Anmeldeseite eines WLANs oder Proxys?“,
  `AiClient::json_of`), not a lasting one: the search says the model is not reachable and goes on by itself
  once it answers.
- Test: `tests/litellm_stream.rs` `garbage_truncated_and_empty_streams_are_not_answers` (embeddings and the model
  list behind a sign-in page).

### R4C-5 A pasted intranet or SharePoint link gets the sign-in page's title (medium)

- Symptom: pasting the link of a page behind the company's single sign-on (SharePoint, Confluence, an intranet)
  inserted „[Sign in to your account](…)“ or „[Anmelden](…)“: the app has no session there, so the request was
  sent on to the sign-in, whose title was taken.
- Root cause: `linktitle::fetch_title` read the title of wherever the redirects ended.
- Fix: a request that ended on another address that looks like a sign-in (a host such as `login.…`,
  `accounts.…`, a path such as `/login`, `/sso`, `/saml2`, `/oauth2/authorize`, `/adfs`, `Authenticate.aspx`)
  gives no title, so the link keeps its address; a sign-in page linked itself keeps its title.
- Test: `linktitle::tests::a_sign_in_page_on_the_way_is_no_title`.

### R4C-6 A Jira address that forwards elsewhere is reported as a refused token (medium)

- Symptom: a site entered as `http://…` while the server forwards to `https://`, or the old address of a Jira that
  moved (to another host or to Atlassian's cloud), failed with „Jira hat die Anmeldung abgelehnt (401) … ein
  neues Token anlegen“. A new token did not help.
- Root cause: the HTTP client follows redirects but does not send the login to another origin (as it must not);
  the target then refused the request without a login.
- Fix: a Jira request that ended on another origin is an error naming the new address and where to enter it
  (`jira::moved_check`). Attachments and avatars, which Jira Cloud serves from another host, are not affected.
- Test: `issues::tests::a_site_that_forwards_elsewhere_names_the_new_address`.

### R4C-7 A Git server with a company certificate is reported as not reachable (medium)

- Symptom: a Git remote behind a company certificate authority failed with „Git-Repository nicht erreichbar
  (… SSL certificate problem: self-signed certificate in certificate chain)“, which points to the network or the
  address; Settings → Netzwerk can add the company's root certificate (and the Git sync uses it), but nothing
  said so. Jira, the calendars and the AI providers already said it.
- Root cause: `gitsync::failure_message` matched „unable to access“ before looking at the cause.
- Fix: certificate errors get their own message with the way: the root certificate in the profile under
  Einstellungen → Netzwerk, or trusting the server when testing the Git sync there.
- Test: `gitsync::safety_tests::stale_locks_are_removed_and_errors_are_classified`.

### Low (listed, not fixed in this round)

- R4C-L1: the update feed answered by a proxy's sign-in page says „Die Versionsinformation ist ungültig“, and a
  certificate error says „Keine Verbindung zum Update-Server (offline, oder Proxy … prüfen)“; neither names the
  likely cause (the background check retries by itself).
- R4C-L2: an ICS server answering 429 gets no hint in the message; the next try is the next interval.
- R4C-L3: a Jira search answer without an `issues` list (a JSON error page of a proxy with status 200) counts as
  an empty result: „Meine Issues“ is empty until the next sync.
- R4C-L4: a failed lookup of Jira's sprint field (a network hiccup) is kept for the life of the client: the sprint
  column stays empty until the settings change or the app restarts.
- R4C-L5: 429 and 503 from Jira are retried three times, each after up to 60 s of `Retry-After`; an edit in the
  issue view can show its spinner for over three minutes.
- R4C-L6: a Jira attachment answered by a single sign-on page (HTML with status 200) is saved and opened under
  the attachment's name; the viewer then reports a broken file instead of the app saying that Jira sent a sign-in
  page.

## Looked at, no finding

- Jira: 401 (Cloud and Server wording, the CAPTCHA lock), 403, 404, 429 and 503 with `Retry-After` (honored, capped
  at 60 s, three retries), 5xx, timeouts, proxy and certificate errors, HTML login pages instead of JSON, invalid
  JSON; a failed page of a search fails the sync (the issues loaded last stay); the worklog runner's retries
  (R2C-1, R3D-1 to R3D-5); the create-issue dialog and the worklog form keep their input.
- Calendars: ICS 401/403/404/407/5xx with what to do, a web page instead of the ICS link, timeouts (at least
  20 s), the 30 MB limit, the interval as backoff.
- AI: the chat's first-byte and idle timeouts, cancel while waiting, an answer cut off midway (kept and marked),
  broken stream events, captive portals, 401/404/429/500 explained in the chat (`aierror.ts`); embeddings time out
  after 120 s and retry after a minute when the model is not reachable.
- Git: sign-in failures, an unreachable remote, a lock left by an interrupted sync; failures are told once per run
  (hourly at most in the hourly mode).
- Update feed: offline, a missing `latest.json`, a cut-off and a tampered download (95-update-feed); downloads
  have a 60 s read timeout and resume from their part file. Voice models: checksums, part files, cancel.
- Link titles: 4 s for the whole request, 256 KB at most, only HTML, errors give the plain link.
- Certificates: the platform verifier takes the system's roots (a company CA installed in Windows works), extra
  root certificates and trusted servers per profile in Settings → Netzwerk.

## Tests added

- Rust: `settings::tests::a_save_from_an_older_copy_keeps_what_changed_since`,
  `calsync::ics::tests::a_download_cut_off_midway_keeps_the_last_sync`,
  `linktitle::tests::a_sign_in_page_on_the_way_is_no_title`,
  `issues::tests::a_site_that_forwards_elsewhere_names_the_new_address`, the certificate case in
  `gitsync::safety_tests::stale_locks_are_removed_and_errors_are_classified`, embeddings and the model list behind
  a sign-in page in `tests/litellm_stream.rs`.
- UI: `store/app.test.ts` (`refreshSettings`), `lib/settingsWrite.test.ts` (the copy a write was made from).
- e2e: `620-failure-paths.test.js` (settings saves from an older copy and at the same time as the core's; a Jira
  comment whose issue cannot be read again).
