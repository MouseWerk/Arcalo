// A fake Jira for end-to-end tests, in two flavors: Cloud (REST v3, Basic auth with e-mail and
// API token, ADF descriptions, `/search/jql` with `nextPageToken`, Agile boards) and Server/Data
// Center (REST v2, Bearer personal access token, wiki markup, `/search` with `startAt`, no Agile).
// It understands the JQL Arcalo sends (my open issues, `key in (…)`, `project = X`, `text ~ "…"`,
// `key = X`), pages its searches two issues at a time, stores created issues, comments,
// transitions and worklogs, and records every request. It listens on a random port; `stop()`
// closes it (connection refused, as offline), `start()` opens the same port again.
//
// Options: `rateLimitOnce` answers the first search with 429 (Retry-After: 1); `captcha` makes
// every login fail as a Server account locked behind a CAPTCHA; `failWorklogs: n` refuses the
// first n worklog posts with 500 after storing nothing. `state.fail = { status, times }` answers the
// next `times` authorized requests with `status` (a gateway error, a proxy asking for a login).

import http from "node:http";

const adf = (text) => ({ type: "doc", version: 1, content: text.split("\n\n").map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) });
const adfText = (v) => (typeof v === "string" ? v : (v?.content ?? []).map((p) => (p.content ?? []).map((c) => c.text ?? "").join("")).join("\n\n"));

export function defaultIssues(me = "Mia Meyer") {
  const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
  return [
    { key: "PROJ-123", summary: "Login fails on SSO", type: "Bug", status: "In Progress", category: "indeterminate", priority: "High", assignee: me, project: "PROJ", projectName: "Portal", due: day(-1), sprint: "Sprint 4", description: "Steps: open login, click SSO.\n\nThe token has expired." },
    { key: "PROJ-124", summary: "Password reset mail", type: "Story", status: "To Do", category: "new", priority: "Medium", assignee: me, project: "PROJ", projectName: "Portal", due: day(5), sprint: "Sprint 4", description: "Send a reset link." },
    { key: "PROJ-125", summary: "Audit log export", type: "Task", status: "To Do", category: "new", priority: "Low", assignee: me, project: "PROJ", projectName: "Portal", due: null, sprint: "Sprint 4", description: "" },
    { key: "OPS-7", summary: "Nightly backup job", type: "Task", status: "In Review", category: "indeterminate", priority: "Highest", assignee: me, project: "OPS", projectName: "Operations", due: day(2), sprint: "", description: "Backups stop at 02:00." },
    { key: "OPS-8", summary: "Rotate certificates", type: "Task", status: "To Do", category: "new", priority: "Medium", assignee: "Tom", project: "OPS", projectName: "Operations", due: null, sprint: "", description: "" },
    { key: "PROJ-100", summary: "Old done story", type: "Story", status: "Done", category: "done", priority: "Medium", assignee: me, project: "PROJ", projectName: "Portal", due: null, sprint: "Sprint 3", description: "" },
  ];
}

export function startFakeJira({ flavor = "cloud", email = "mia@firma.de", token = "secret-token", me = "Mia Meyer", issues = defaultIssues(me), rateLimitOnce = false, captcha = false, failWorklogs = 0 } = {}) {
  const cloud = flavor === "cloud";
  const v = cloud ? "3" : "2";
  const requests = [];
  const store = issues.map((i) => ({ comments: [{ author: "Tom", created: "2026-09-29T08:00:00.000+0000", body: `First look at ${i.key}` }], worklogs: [], ...i }));
  const state = { rateLimited: !rateLimitOnce, failWorklogs, port: 0, nextId: 1000, captcha };
  let server = null;

  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };
  const authorized = (req) => {
    const h = req.headers.authorization ?? "";
    if (cloud) return h === `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    return h === `Bearer ${token}`;
  };
  const fields = (i) => ({
    summary: i.summary,
    status: { name: i.status, statusCategory: { key: i.category } },
    priority: i.priority ? { name: i.priority } : null,
    assignee: i.assignee ? { displayName: i.assignee, accountId: i.assignee === me ? "acc-mia" : "acc-x", name: i.assignee === me ? "mmeyer" : "other" } : null,
    reporter: { displayName: "Tom" },
    issuetype: { name: i.type },
    project: { key: i.project, name: i.projectName },
    duedate: i.due,
    updated: "2026-09-30T10:15:30.000+0200",
    resolutiondate: i.category === "done" ? "2026-09-29T10:00:00.000+0000" : null,
    description: i.description ? (cloud ? adf(i.description) : i.description) : null,
    comment: { comments: i.comments.map((c) => ({ author: { displayName: c.author }, created: c.created, body: cloud ? adf(c.body) : c.body })) },
    customfield_10020: i.sprint ? (cloud ? [{ id: 4, name: i.sprint, state: i.sprint === "Sprint 4" ? "active" : "closed" }] : [`com.atlassian.greenhopper.service.sprint.Sprint@1a[id=4,rapidViewId=1,state=${i.sprint === "Sprint 4" ? "ACTIVE" : "CLOSED"},name=${i.sprint},sequence=4]`]) : null,
  });
  const wire = (i) => ({ id: String(10000 + store.indexOf(i)), key: i.key, fields: fields(i) });
  const byKey = (k) => store.find((i) => i.key === k);

  /** The issues a JQL query finds. */
  function query(jql) {
    const j = jql.replace(/\s+ORDER BY.*$/i, "").trim();
    let m;
    if ((m = /^key in \(([^)]*)\)$/i.exec(j))) {
      const keys = m[1].split(",").map((s) => s.trim());
      return store.filter((i) => keys.includes(i.key));
    }
    if ((m = /^key = (\S+)$/i.exec(j))) return store.filter((i) => i.key === m[1]);
    if ((m = /^text ~ "(.*)"$/i.exec(j))) {
      const words = m[1].toLowerCase().split(/\s+/);
      return store.filter((i) => words.every((w) => `${i.summary} ${i.description}`.toLowerCase().includes(w)));
    }
    let list = store;
    if (/assignee = currentUser\(\)/i.test(j)) list = list.filter((i) => i.assignee === me);
    if (/statusCategory != Done/i.test(j)) list = list.filter((i) => i.category !== "done");
    if ((m = /project = (\w+)/i.exec(j))) list = list.filter((i) => i.project === m[1]);
    if (!/assignee|project|statusCategory/i.test(j)) return null;
    return list;
  }

  const handler = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : null;
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body: data });
    if (path === "/rest/api/2/serverInfo") return json(res, 200, { deploymentType: cloud ? "Cloud" : "DataCenter", version: cloud ? "1001.0.0" : "9.12.0" });
    if (state.captcha) return json(res, 403, { errorMessages: ["CAPTCHA_CHALLENGE"] }, { "X-Authentication-Denied-Reason": "CAPTCHA_CHALLENGE; login-url=http://x/login.jsp" });
    if (!authorized(req)) return json(res, 401, { errorMessages: ["You are not authenticated."] });
    if (state.fail?.times > 0) {
      state.fail.times--;
      return json(res, state.fail.status, { errorMessages: [`Failure ${state.fail.status}`] });
    }
    const api = `/rest/api/${v}/`;
    if (path.startsWith("/rest/agile/1.0/")) {
      if (!cloud) return json(res, 404, { errorMessages: ["Agile is not installed"] });
      const rest = path.slice("/rest/agile/1.0/".length);
      if (rest === "board") return json(res, 200, { values: url.searchParams.get("projectKeyOrId") === "PROJ" ? [{ id: 1, name: "PROJ board", type: "scrum" }] : [] });
      if (rest === "board/1/sprint") {
        const start = new Date(Date.now() - 4 * 86400_000).toISOString();
        const end = new Date(Date.now() + 6 * 86400_000).toISOString();
        return json(res, 200, { values: [{ id: 4, name: "Sprint 4", state: "active", startDate: start, endDate: end, goal: "Login works" }] });
      }
      if (rest === "sprint/4/issue") return json(res, 200, { issues: store.filter((i) => i.sprint === "Sprint 4").map(wire) });
      return json(res, 404, { errorMessages: ["no"] });
    }
    if (!path.startsWith(api)) return json(res, 404, { errorMessages: ["wrong API version"] });
    const rest = path.slice(api.length);
    if (rest === "myself") return json(res, 200, cloud ? { accountId: "acc-mia", displayName: me, emailAddress: email } : { name: "mmeyer", key: "mmeyer", displayName: me, emailAddress: email });
    if (rest === "field") return json(res, 200, [{ id: "summary", name: "Summary" }, { id: "customfield_10020", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }]);
    if ((cloud && rest === "search/jql") || (!cloud && rest === "search")) {
      if (!state.rateLimited) {
        state.rateLimited = true;
        return json(res, 429, { errorMessages: ["Rate limit exceeded"] }, { "Retry-After": "1" });
      }
      const found = query(url.searchParams.get("jql") ?? "");
      if (!found) return json(res, 400, { errorMessages: ["Error in the JQL Query"] });
      const size = Math.min(2, Number(url.searchParams.get("maxResults") ?? 50));
      if (cloud) {
        const start = Number(url.searchParams.get("nextPageToken") ?? 0);
        const page = found.slice(start, start + size);
        const more = start + size < found.length;
        return json(res, 200, { issues: page.map(wire), ...(more ? { nextPageToken: String(start + size) } : {}), isLast: !more });
      }
      const start = Number(url.searchParams.get("startAt") ?? 0);
      return json(res, 200, { startAt: start, maxResults: size, total: found.length, issues: found.slice(start, start + size).map(wire) });
    }
    if (rest === "project/search" && cloud) return json(res, 200, { values: [...new Set(store.map((i) => i.project))].map((k) => ({ key: k, name: byKey(store.find((i) => i.project === k).key).projectName })) });
    if (rest === "project" && !cloud) return json(res, 200, [...new Set(store.map((i) => i.project))].map((k) => ({ key: k, name: store.find((i) => i.project === k).projectName })));
    let m;
    if ((m = /^project\/(\w+)$/.exec(rest))) return json(res, 200, { key: m[1], issueTypes: [{ name: "Task", subtask: false }, { name: "Bug", subtask: false }, { name: "Story", subtask: false }, { name: "Sub-task", subtask: true }] });
    if (rest === "issue" && req.method === "POST") {
      const f = data.fields;
      const n = Math.max(...store.filter((i) => i.project === f.project.key).map((i) => Number(i.key.split("-")[1])), 0) + 1;
      const issue = { key: `${f.project.key}-${n}`, summary: f.summary, type: f.issuetype.name, status: "To Do", category: "new", priority: "Medium", assignee: me, project: f.project.key, projectName: store.find((i) => i.project === f.project.key)?.projectName ?? "", due: null, sprint: "", description: adfText(f.description ?? ""), comments: [], worklogs: [], created: data };
      store.push(issue);
      return json(res, 201, { id: String(10000 + store.length - 1), key: issue.key, self: "x" });
    }
    if ((m = /^issue\/([A-Z0-9_]+-\d+)(\/(\w+))?$/.exec(rest))) {
      const issue = byKey(m[1]);
      if (!issue) return json(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      const sub = m[3];
      if (!sub && req.method === "GET") return json(res, 200, wire(issue));
      if (sub === "comment" && req.method === "POST") {
        issue.comments.push({ author: me, created: "2026-10-01T09:00:00.000+0000", body: adfText(data.body) });
        return json(res, 201, { id: "c1" });
      }
      if (sub === "transitions" && req.method === "GET") return json(res, 200, { transitions: [{ id: "11", name: "Start", to: { name: "In Progress" } }, { id: "31", name: "Finish", to: { name: "Done" } }] });
      if (sub === "transitions" && req.method === "POST") {
        const to = data.transition.id === "31" ? ["Done", "done"] : ["In Progress", "indeterminate"];
        [issue.status, issue.category] = to;
        return json(res, 204);
      }
      if (sub === "worklog" && req.method === "POST") {
        if (state.failWorklogs > 0) {
          state.failWorklogs--;
          return json(res, 500, { errorMessages: ["Internal server error"] });
        }
        const w = { id: String(state.nextId++), started: data.started, timeSpentSeconds: data.timeSpentSeconds, comment: adfText(data.comment ?? ""), author: cloud ? { accountId: "acc-mia" } : { name: "mmeyer" } };
        issue.worklogs.push(w);
        return json(res, 201, w);
      }
      if (sub === "worklog" && req.method === "GET") return json(res, 200, { worklogs: issue.worklogs });
    }
    // One worklog: changed (PUT) or removed (DELETE) after the entry was edited or deleted.
    if ((m = /^issue\/([A-Z0-9_]+-\d+)\/worklog\/(\w+)$/.exec(rest))) {
      const issue = byKey(m[1]);
      const w = issue?.worklogs.find((x) => x.id === m[2]);
      if (!w) return json(res, 404, { errorMessages: ["Cannot find worklog with id: " + m[2]] });
      if (req.method === "PUT") {
        Object.assign(w, { started: data.started ?? w.started, timeSpentSeconds: data.timeSpentSeconds ?? w.timeSpentSeconds, comment: adfText(data.comment ?? "") });
        return json(res, 200, w);
      }
      if (req.method === "DELETE") {
        issue.worklogs.splice(issue.worklogs.indexOf(w), 1);
        return json(res, 204);
      }
    }
    return json(res, 404, { errorMessages: ["not found"] });
  };

  const open = () =>
    new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.once("error", reject);
      server.listen(state.port, "127.0.0.1", () => {
        state.port = server.address().port;
        resolve();
      });
    });
  const close = () =>
    new Promise((r) => {
      if (!server) return r();
      server.closeAllConnections?.();
      server.close(() => r());
      server = null;
    });
  return open().then(() => ({
    requests,
    issues: store,
    state,
    get url() {
      return `http://127.0.0.1:${state.port}`;
    },
    worklogs: () => store.flatMap((i) => i.worklogs.map((w) => ({ key: i.key, ...w }))),
    stop: close,
    start: open,
    close,
  }));
}
