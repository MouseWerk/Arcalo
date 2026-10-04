# Arcalo 1.12 quality pass - A3 Integrations: findings

Legend: H high, M medium, L low. All "fixed" unless marked "left".

## Jira
- [H] F1 fixed. Every Jira error read "KI-Server meldet Fehler 401: Jira hat die Anmeldung abgelehnt ..." (EN "The AI server reports error ...") in Settings, the site test, the Issues banner and toasts.
  Root cause: jira::status_error returned Error::Provider, whose Display is the AI wording. Fix: Error::Remote {status, message} (message shown as is); Jira code matches Remote. Tests: error.rs unit, issues errors_are_worded_for_the_user, e2e 160.
- [M] F2 fixed. Certificate errors (company CA missing), unknown host names and proxy refusals all read "Jira cannot be reached - offline or wrong address?".
  Root cause: network_error only looked at is_connect(). Fix: error::http_cause (shared with http_text) classifies the cause chain; Jira words each case with its fix (Settings -> Network: root CA or trust the server; VPN/typo; proxy profile; timeout setting). Tests: unit network_errors_name_the_cause_and_the_fix (refused, DNS, proxy), e2e 160 (self-signed TLS from fake-network).
- [M] F3 fixed. 5xx and 407 answers said only "Jira answered with error 502". Now: problem on Jira's side, try again in a few minutes / ask admins; 407: enter proxy user+password. fake-jira gained `state.fail = {status, times}`. Tests: unit + e2e 160 (502).
- [M] F4 fixed. A saved JQL search Jira rejects (typo) failed on every sync silently (dev log only); its widget kept old data.
  Fix: per-query errors of the last sync kept in JiraSync (in memory, no schema change), returned as JiraStatus.query_errors, shown under the search in Settings -> Jira with the fix; cleared by the next good sync. Test: e2e 160.
- [M] F5 fixed. Site dialog refused intranet addresses without a dot (https://jira, http://jira:8080): Test/Save stayed disabled. Fix: isSiteAddress (lib/jira.ts). Test: vitest + e2e 160.
- [M] F10 fixed. An address copied from the browser (…/browse/PROJ-1, …/jira/software/projects/…, ?query) was stored as is: every request 404 "check the address". normalize_url now cuts the page part (Cloud: host only; Server keeps a context path like /jira). Test: unit table + e2e 160.
- [L] F11 fixed. 401 named both Cloud and Server tokens; now kind-specific with where to create a new token.
- [L] F6 fixed. Failed site test had no icon; doc comment of src-tauri/jira.rs named the wrong HTTP client.

## ICS / calendar files
- [M] F7 fixed. Windows-1252 calendar files (older Outlook/Exchange exports) showed umlauts as U+FFFD; UTF-16 files (Windows "Unicode") were "no iCalendar data". Fix: decode UTF-16 by BOM, non-UTF-8 as Windows-1252. Tests: unit windows_encodings_keep_umlauts, e2e 160.
- [M] F8 fixed. A subscription that returns a web page (login/sharing page) failed with "Eingabe nicht verstanden: keine iCalendar-Daten (BEGIN:VCALENDAR fehlt)". Now: "a web page instead of a calendar ... copy the ICS link (ends in .ics) and enter it under 'Change name or address'"; other non-calendars: export again. 401/403/404 hints say how to fix; 407 proxy login; 5xx "tries again later". Tests: unit, e2e 160.
- verified (no bug): recurring series with DURATION, EXDATE in UTC vs TZID start, moved (RECURRENCE-ID in UTC) and cancelled instances, all-day DURATION P2D. Unit test series_with_duration_moved_and_cancelled_instances added.

## Outlook (classic, COM) and mail
- [L] F9 fixed. Unknown script error codes (calendar, current mail, flagged list) gave no next step; now "restart Outlook and sync/try again".
- left: Outlook calendar sign-in/free-busy/team availability run through Outlook COM (Windows only); not reproducible on Linux beyond the existing fixtures (e2e 84/85), messages reviewed: each says what to do.

## UI pass (Settings -> Jira, site dialog, Issues, Settings -> Kalender)
- [M] V2 fixed. Jira sync group row said "Alle Kalender jetzt synchronisieren" (calendar key reused). Now "Alle Jira-Sites jetzt abgleichen".
- [L] V3 fixed. Saved searches block had no bottom padding: the "Hinzufügen" button touched/cut the card border; no divider to the row above.
- [L] V1 fixed. Code ligatures turned "!=" into "≠" in the JQL and "://" into "http: //" in site/calendar addresses (misleading when copied by eye).
- [L] V4 fixed. Stacked fields in dialogs had no space between a hint and the next label (all dialogs; .dialog-body > .field + .field 12px); Jira switches block spaced likewise.
- [L] V5 fixed. Issues banner: "shown are the issues synced just now" used the newest sync of any site (a healthy site), now the failing sites' last good sync; banner offers "Jira-Einstellungen"; wraps in narrow panes.
