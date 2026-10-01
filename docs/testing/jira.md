# Jira: testing against a real Jira

The e2e tests (`e2e/tests/103`–`105`) run against the fake Jira in `e2e/lib/fake-jira.js`. Before a
release, go through this list once against a real Jira Cloud site and once against a Jira Server or Data
Center. Use a test project: the worklog and create steps write into Jira.

## Jira Cloud

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Einstellungen → Jira → „Jira-Site verbinden“: address `https://<site>.atlassian.net`, type Cloud (set by
   itself from the address), your Atlassian e-mail and the token. „Verbindung testen“ must show your
   display name and „Cloud“.
3. Save. Within a few seconds the site shows „N Issues … als <Name>“; the Issues page lists your open
   issues. Compare with `assignee = currentUser() AND statusCategory != Done` in Jira's issue search.
4. Add a saved search with more than 100 hits (e.g. `project = X ORDER BY updated DESC`): the sync pages
   through it (Einstellungen → Protokoll with „Ausführlich“ shows the requests).
5. Add the three widgets; the Sprint widget needs a Scrum board with an active sprint in the project of
   most of your issues (or set the project in its settings).
6. In a note, type a key of the test project: chip, hover card, click (note page), Ctrl+click (browser).
7. A task `- [ ] Annalo test` → right-click → „Jira-Issue anlegen“; check the new issue's description.
   Move it to Done in Jira, „Aktualisieren“: the task is ticked.
8. With „Arbeit auch in Jira protokollieren“: `/zeit NP-…/… 15m KEY-1 test` posts a worklog of 15 minutes
   with the comment. Delete it in Jira afterwards.

## Jira Server / Data Center

1. Create a personal access token in Jira: profile → „Personal Access Tokens“ (Jira 8.14 and later).
2. Connect with the base address including a context path if there is one (`https://jira.firma.de/jira`);
   the type turns to „Server / Data Center“ once the connection test asked the server.
3. Repeat steps 3–8 above. Without Jira Software (Agile), the Sprint widget must say that there is no
   sprint board instead of an error.
4. Wrong token: the test says 401. After several failed logins, Jira may lock the account behind a
   CAPTCHA: the message must say to log in once in the browser.

## Network

- Behind the company proxy (Einstellungen → Netzwerk: manual, system or PAC) and with the company's root
  certificate, the test and the sync must work like the AI providers do.
- Offline: stop the network, „Aktualisieren“ shows the error on the Issues page while the cached issues,
  chips and widgets stay visible.
