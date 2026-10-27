// A fake Jira for end-to-end tests, in two flavors: Cloud (REST v3, Basic auth with e-mail and
// API token, ADF descriptions, `/search/jql` with `nextPageToken`, Agile boards) and Server/Data
// Center (REST v2, Bearer personal access token, wiki markup, `/search` with `startAt`, no Agile).
// It understands the JQL Arcalo sends (my open issues, `key in (…)`, `project = X`, `text ~ "…"`,
// `key = X`), pages its searches two issues at a time, stores created issues, comments,
// transitions and worklogs, and records every request. Like Jira it answers only the fields a
// request asks for (`fields=`, also `*all,-comment`), so a test sees what the app loads. It
// listens on a random port; `stop()` closes it (connection refused, as offline), `start()` opens
// the same port again.
//
// For the issue view it answers like Jira's issue page asks: `expand=renderedFields,names,schema,
// editmeta,transitions,transitions.fields,changelog`, custom fields (a select, a text field, story
// points), attachments with thumbnails and avatars that need the login (Server) or not (Cloud's
// public avatars), paged comments (Cloud sorts by `orderBy`, Server ignores it like old versions),
// paged worklogs, remote links, permissions, user searches, field edits (`PUT issue`, each bumps
// `updated` and writes a history entry), assigning, editing and deleting comments, and a
// transition with a screen that requires a resolution (`41`). `edit(key, fields)` changes an issue
// as someone else would in Jira's own page (for the conflict case).
//
// Options: `rateLimitOnce` answers the first search with 429 (Retry-After: 1); `captcha` makes
// every login fail as a Server account locked behind a CAPTCHA; `failWorklogs: n` refuses the
// first n worklog posts with 500 after storing nothing; `big: "KEY"` gives that issue 500 comments
// and 100 attachments. `state.fail = { status, times }` answers the next `times` authorized
// requests with `status` (a gateway error, a proxy asking for a login).

import http from "node:http";
import zlib from "node:zlib";

const adf = (text) => ({ type: "doc", version: 1, content: text.split("\n\n").map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) });
const adfText = (v) => (typeof v === "string" ? v : (v?.content ?? []).map((p) => (p.content ?? []).map((c) => c.text ?? c.attrs?.text ?? "").join("")).join("\n\n"));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Jira's timestamp format (`2026-10-25T08:00:00.000+0000`). */
const jiraNow = () => new Date().toISOString().replace("Z", "+0000");

/** A small PNG of one color (thumbnails, avatars). */
export function pngOf(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

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

const PRIORITIES = [
  { id: "1", name: "Highest" },
  { id: "2", name: "High" },
  { id: "3", name: "Medium" },
  { id: "4", name: "Low" },
];
const ENV_OPTIONS = [
  { id: "10300", value: "Production" },
  { id: "10301", value: "Staging" },
  { id: "10302", value: "Test" },
];
const RESOLUTIONS = [
  { id: "10000", name: "Fixed" },
  { id: "10001", name: "Won't Fix" },
];

export function startFakeJira({ flavor = "cloud", email = "mia@firma.de", token = "secret-token", me = "Mia Meyer", issues = defaultIssues(me), rateLimitOnce = false, captcha = false, failWorklogs = 0, big = null } = {}) {
  const cloud = flavor === "cloud";
  const v = cloud ? "3" : "2";
  const requests = [];
  const state = { rateLimited: !rateLimitOnce, failWorklogs, port: 0, nextId: 1000, captcha };
  const users = {
    [me]: { id: cloud ? "acc-mia" : "mmeyer", name: me, avatar: cloud ? "/avatars/mia.png" : "/secure/useravatar?ownerId=mmeyer" },
    Tom: { id: cloud ? "acc-tom" : "tom", name: "Tom", avatar: cloud ? "/avatars/tom.png" : "/secure/useravatar?ownerId=tom" },
  };
  const userBy = (id) => Object.values(users).find((u) => u.id === id);
  const store = issues.map((i) => ({
    comments: [{ author: "Tom", created: "2026-09-29T08:00:00.000+0000", body: `First look at ${i.key}` }],
    worklogs: [],
    updated: "2026-09-30T10:15:30.000+0200",
    created: "2026-09-20T09:00:00.000+0200",
    labels: [],
    history: [],
    customs: {},
    attachments: [],
    subtasks: [],
    links: [],
    remote: [],
    ...i,
  }));
  const proj = store.find((i) => i.key === "PROJ-123");
  if (proj) {
    Object.assign(proj, {
      labels: ["sso", "login"],
      customs: { customfield_10050: ENV_OPTIONS[0], customfield_10061: "ACME-7781", points: 5 },
      attachments: [
        { id: "10500", filename: "screenshot.png", mime: "image/png", data: pngOf(160, 100, [56, 132, 214]) },
        { id: "10501", filename: "trace.log", mime: "text/plain", data: Buffer.from("PSP answered 504\n") },
      ],
      subtasks: ["PROJ-125"],
      links: [
        { id: "20001", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outward: "OPS-7" },
        { id: "20002", type: { name: "Relates", inward: "relates to", outward: "relates to" }, inward: "PROJ-124" },
      ],
      remote: [{ id: 10000, relationship: "mentioned in", object: { url: "https://github.com/acme/portal/pull/812", title: "Fix SSO token refresh" } }],
      history: [{ id: "30001", author: "Tom", created: "2026-09-25T10:00:00.000+0200", items: [{ field: "status", fromString: "To Do", toString: "In Progress" }] }],
      descriptionRaw: cloud
        ? {
            type: "doc",
            version: 1,
            content: [
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
              { type: "paragraph", content: [{ type: "text", text: "Steps: open login, click " }, { type: "text", text: "SSO", marks: [{ type: "strong" }] }, { type: "text", text: "." }] },
              { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Chrome and Edge" }] }] }] },
              { type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: '{"error": "token_expired"}' }] },
              { type: "paragraph", content: [{ type: "text", text: "The token has expired." }] },
              { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "file", id: "9f1c", collection: "", alt: "screenshot.png" } }] },
            ],
          }
        : "h2. Steps\nSteps: open login, click *SSO*.\n\n* Chrome and Edge\n\n{code:json}\n{\"error\": \"token_expired\"}\n{code}\n\nThe token has expired.\n\n!screenshot.png!",
    });
  }
  const bigIssue = big && store.find((i) => i.key === big);
  if (bigIssue) {
    bigIssue.comments = Array.from({ length: 500 }, (_, n) => ({ author: n % 3 ? "Tom" : me, created: new Date(Date.UTC(2026, 6, 1, 8) + n * 3600_000).toISOString().replace("Z", "+0000"), body: `Comment number ${n + 1}` }));
    bigIssue.attachments = Array.from({ length: 100 }, (_, n) => ({ id: String(11000 + n), filename: `file-${String(n + 1).padStart(3, "0")}.png`, mime: "image/png", data: pngOf(32, 24, [(n * 37) % 255, 120, 180]) }));
  }
  store.forEach((i) => i.comments.forEach((c) => (c.id ??= String(state.nextId++))));
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
  const base = () => `http://127.0.0.1:${state.port}`;
  const userJson = (name) => {
    if (!name) return null;
    const u = users[name] ?? { id: `acc-${name.toLowerCase()}`, name, avatar: "" };
    const avatarUrls = u.avatar ? { "48x48": `${base()}${u.avatar}`, "24x24": `${base()}${u.avatar}` } : {};
    return cloud ? { accountId: u.id, displayName: u.name, active: true, avatarUrls } : { name: u.id, key: `JIRAUSER-${u.id}`, displayName: u.name, active: true, avatarUrls };
  };
  const statusJson = (i) => ({ name: i.status, statusCategory: { key: i.category } });
  const byKey = (k) => store.find((i) => i.key === k);
  const refJson = (k) => {
    const o = byKey(k);
    return { key: k, fields: { summary: o?.summary ?? k, status: o ? statusJson(o) : { name: "To Do", statusCategory: { key: "new" } }, issuetype: { name: o?.type ?? "Task" }, priority: o?.priority ? { name: o.priority } : null } };
  };
  const attachmentUrls = (a) =>
    cloud
      ? { content: `${base()}/rest/api/3/attachment/content/${a.id}`, thumbnail: a.mime.startsWith("image/") ? `${base()}/rest/api/3/attachment/thumbnail/${a.id}` : undefined }
      : { content: `${base()}/secure/attachment/${a.id}/${a.filename}`, thumbnail: a.mime.startsWith("image/") ? `${base()}/secure/thumbnail/${a.id}/_thumb_${a.id}.png` : undefined };
  const description = (i) => i.descriptionRaw ?? (i.description ? (cloud ? adf(i.description) : i.description) : null);
  const pointsField = cloud ? "customfield_10016" : "customfield_10106";

  /** Jira's rendered HTML of a stored body (ADF or wiki markup), enough of it for the tests. */
  function render(body, i) {
    if (!body) return "";
    if (typeof body !== "string") {
      const marks = (t) => (t.marks ?? []).reduce((s, m) => (m.type === "strong" ? `<b>${s}</b>` : m.type === "em" ? `<em>${s}</em>` : m.type === "link" ? `<a href="${esc(m.attrs.href)}">${s}</a>` : m.type === "code" ? `<tt>${s}</tt>` : s), esc(t.text ?? ""));
      const node = (n) => {
        const kids = () => (n.content ?? []).map(node).join("");
        switch (n.type) {
          case "text":
            return marks(n);
          case "paragraph":
            return `<p>${kids()}</p>`;
          case "heading":
            return `<h${n.attrs.level}>${kids()}</h${n.attrs.level}>`;
          case "bulletList":
            return `<ul>${kids()}</ul>`;
          case "orderedList":
            return `<ol>${kids()}</ol>`;
          case "listItem":
            return `<li>${kids()}</li>`;
          case "codeBlock":
            return `<div class="code panel"><div class="codeContent panelContent"><pre class="code-${n.attrs?.language ?? "java"}">${esc((n.content ?? []).map((c) => c.text).join(""))}</pre></div></div>`;
          case "hardBreak":
            return "<br/>";
          case "mention":
            return `<a href="/secure/ViewProfile.jspa?accountId=${esc(n.attrs.id)}" class="user-hover">${esc(n.attrs.text.replace(/^@/, ""))}</a>`;
          case "mediaSingle": {
            const a = i?.attachments.find((x) => x.filename === n.content?.[0]?.attrs?.alt);
            return a ? `<p><span class="image-wrap"><img src="/rest/api/3/attachment/content/${a.id}" alt="${esc(a.filename)}" /></span></p>` : "";
          }
          default:
            return kids();
        }
      };
      return (body.content ?? []).map(node).join("");
    }
    const inline = (s) =>
      esc(s)
        .replace(/\*([^*\s][^*]*)\*/g, "<b>$1</b>")
        .replace(/(^|\s)_([^_\s][^_]*)_/g, "$1<em>$2</em>")
        .replace(/!([^!\s]+)!/g, (_m, f) => {
          const a = i?.attachments.find((x) => x.filename === f.split("|")[0]);
          return a ? `<span class="image-wrap"><img src="/secure/attachment/${a.id}/${esc(a.filename)}" /></span>` : "";
        });
    return body
      .split(/\n\n+/)
      .map((p) => {
        if (/^h(\d)\. /.test(p)) {
          const [first, ...rest] = p.split("\n");
          const level = first[1];
          return `<h${level}>${inline(first.slice(4))}</h${level}>${rest.length ? `<p>${rest.map(inline).join("<br/>")}</p>` : ""}`;
        }
        if (/^\{code(:[^}]*)?\}/.test(p)) return `<div class="code panel"><div class="codeContent panelContent"><pre>${esc(p.replace(/^\{code[^}]*\}\n?/, "").replace(/\n?\{code\}$/, ""))}</pre></div></div>`;
        if (/^\* /.test(p)) return `<ul>${p.split("\n").map((l) => `<li>${inline(l.replace(/^\* /, ""))}</li>`).join("")}</ul>`;
        return `<p>${p.split("\n").map(inline).join("<br/>")}</p>`;
      })
      .join("\n");
  }

  const fields = (i) => ({
    summary: i.summary,
    status: statusJson(i),
    priority: i.priority ? { name: i.priority, id: PRIORITIES.find((p) => p.name === i.priority)?.id ?? "3" } : null,
    assignee: userJson(i.assignee),
    reporter: userJson("Tom"),
    creator: userJson("Tom"),
    issuetype: { name: i.type, subtask: false },
    project: { key: i.project, name: i.projectName },
    duedate: i.due,
    created: i.created,
    updated: i.updated,
    resolutiondate: i.category === "done" ? "2026-09-29T10:00:00.000+0000" : null,
    resolution: i.resolution ? { name: i.resolution } : null,
    description: description(i),
    labels: i.labels,
    components: [],
    fixVersions: [],
    versions: [],
    comment: { comments: i.comments.map((c) => ({ id: c.id, author: userJson(c.author), created: c.created, body: cloud ? adf(c.body) : c.body })) },
    customfield_10020: i.sprint ? (cloud ? [{ id: 4, name: i.sprint, state: i.sprint === "Sprint 4" ? "active" : "closed" }] : [`com.atlassian.greenhopper.service.sprint.Sprint@1a[id=4,rapidViewId=1,state=${i.sprint === "Sprint 4" ? "ACTIVE" : "CLOSED"},name=${i.sprint},sequence=4]`]) : null,
    customfield_10050: i.customs.customfield_10050 ?? null,
    customfield_10061: i.customs.customfield_10061 ?? null,
    [pointsField]: i.customs.points ?? null,
    timetracking: (() => {
      const spent = i.worklogs.reduce((a, w) => a + w.timeSpentSeconds, 0);
      const est = i.estimates ?? (spent ? { originalEstimate: "1d", originalEstimateSeconds: 28800 } : {});
      return { ...est, ...(spent ? { timeSpent: `${Math.round(spent / 60)}m`, timeSpentSeconds: spent } : {}) };
    })(),
    attachment: i.attachments.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime, size: a.data.length, created: "2026-09-21T09:00:00.000+0200", author: userJson("Tom"), ...attachmentUrls(a) })),
    subtasks: i.subtasks.map(refJson),
    issuelinks: i.links.map((l) => ({ id: l.id, type: l.type, ...(l.outward ? { outwardIssue: refJson(l.outward) } : { inwardIssue: refJson(l.inward) }) })),
    watches: { watchCount: 3, isWatching: true },
    votes: { votes: 1, hasVoted: false },
    worklog: { startAt: 0, maxResults: 20, total: i.worklogs.length, worklogs: i.worklogs.slice(0, 20) },
  });
  /** An issue as Jira sends it: only the fields asked for (`fields=a,b`, `*all,-x`; all without the parameter). */
  const wire = (i, want = null, expand = "") => {
    const all = fields(i);
    const asked = want ? want.split(",").map((f) => f.trim()) : null;
    let picked = all;
    if (asked && !asked.includes("*all") && !asked.includes("*navigable")) picked = Object.fromEntries(Object.entries(all).filter(([k]) => asked.includes(k)));
    else if (asked) picked = Object.fromEntries(Object.entries(all).filter(([k]) => !asked.includes(`-${k}`)));
    const out = { id: String(10000 + store.indexOf(i)), key: i.key, fields: picked };
    const ex = expand.split(",");
    if (ex.includes("renderedFields")) out.renderedFields = { description: render(description(i), i), customfield_10061: i.customs.customfield_10061 ? esc(i.customs.customfield_10061) : null };
    if (ex.includes("names")) out.names = { summary: "Summary", description: "Description", customfield_10050: "Environment type", customfield_10061: "Customer ref", [pointsField]: cloud ? "Story point estimate" : "Story Points", customfield_10020: "Sprint" };
    if (ex.includes("schema"))
      out.schema = {
        summary: { type: "string", system: "summary" },
        description: { type: "string", system: "description" },
        labels: { type: "array", items: "string", system: "labels" },
        customfield_10050: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: 10050 },
        customfield_10061: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", customId: 10061 },
        [pointsField]: { type: "number", custom: cloud ? "com.pyxis.greenhopper.jira:jsw-story-points" : "com.atlassian.jira.plugin.system.customfieldtypes:float" },
        customfield_10020: { type: "array", items: cloud ? "json" : "string", custom: "com.pyxis.greenhopper.jira:gh-sprint" },
      };
    if (ex.includes("editmeta")) out.editmeta = { fields: i.assignee === me ? editmeta() : {} };
    if (ex.includes("transitions")) out.transitions = i.assignee === me ? transitions(ex.includes("transitions.fields")) : [];
    if (ex.includes("changelog")) out.changelog = { startAt: 0, maxResults: i.history.length, total: i.history.length, histories: i.history.map(historyJson) };
    return out;
  };
  const historyJson = (h) => ({ id: h.id, author: userJson(h.author), created: h.created, items: h.items });
  const editmeta = () => ({
    summary: { required: true, schema: { type: "string", system: "summary" }, name: "Summary", key: "summary", operations: ["set"] },
    description: { required: false, schema: { type: "string", system: "description" }, name: "Description", key: "description", operations: ["set"] },
    labels: { required: false, schema: { type: "array", items: "string", system: "labels" }, name: "Labels", key: "labels", operations: ["add", "set", "remove"] },
    priority: { required: false, schema: { type: "priority", system: "priority" }, name: "Priority", key: "priority", operations: ["set"], allowedValues: PRIORITIES },
    assignee: { required: false, schema: { type: "user", system: "assignee" }, name: "Assignee", key: "assignee", operations: ["set"] },
    duedate: { required: false, schema: { type: "date", system: "duedate" }, name: "Due date", key: "duedate", operations: ["set"] },
    customfield_10050: { required: false, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: 10050 }, name: "Environment type", key: "customfield_10050", operations: ["set"], allowedValues: ENV_OPTIONS },
    customfield_10061: { required: false, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", customId: 10061 }, name: "Customer ref", key: "customfield_10061", operations: ["set"] },
    [pointsField]: { required: false, schema: { type: "number", custom: cloud ? "com.pyxis.greenhopper.jira:jsw-story-points" : "com.atlassian.jira.plugin.system.customfieldtypes:float" }, name: cloud ? "Story point estimate" : "Story Points", key: pointsField, operations: ["set"] },
    comment: { required: false, schema: { type: "comments-page", system: "comment" }, name: "Comment", key: "comment", operations: ["add", "edit", "remove"] },
    timetracking: { required: false, schema: { type: "timetracking", system: "timetracking" }, name: "Time tracking", key: "timetracking", operations: ["set", "edit"] },
  });
  const transitions = (withFields) => [
    { id: "11", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } }, hasScreen: false, ...(withFields ? { fields: {} } : {}) },
    { id: "31", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } }, hasScreen: false, ...(withFields ? { fields: {} } : {}) },
    {
      id: "41",
      name: "Resolve",
      to: { name: "Resolved", statusCategory: { key: "done" } },
      hasScreen: true,
      ...(withFields
        ? {
            fields: {
              resolution: { required: true, schema: { type: "resolution", system: "resolution" }, name: "Resolution", key: "resolution", operations: ["set"], allowedValues: RESOLUTIONS },
              comment: { required: false, schema: { type: "comments-page", system: "comment" }, name: "Comment", key: "comment", operations: ["add"] },
            },
          }
        : {}),
    },
    { id: "51", name: "Reopen", to: { name: "To Do", statusCategory: { key: "new" } }, hasScreen: false, ...(withFields ? { fields: {} } : {}) },
  ];
  /** A change in Jira: `updated` moves on and the history records it. */
  function changed(i, author, items) {
    i.updated = jiraNow();
    i.history.push({ id: String(state.nextId++), author, created: i.updated, items });
  }
  /** Changes an issue as someone else would in Jira itself. */
  function edit(key, patch, author = "Tom") {
    const i = byKey(key);
    const items = [];
    for (const [k, val] of Object.entries(patch)) {
      if (k === "summary") items.push({ field: "summary", fromString: i.summary, toString: val }), (i.summary = val);
      else if (k === "customfield_10050") items.push({ field: "Environment type", fromString: i.customs.customfield_10050?.value ?? "", toString: val?.value ?? "" }), (i.customs.customfield_10050 = val);
      else if (k === "description") items.push({ field: "description", fromString: adfText(description(i) ?? ""), toString: adfText(val) }), (i.descriptionRaw = val), (i.description = adfText(val));
    }
    changed(i, author, items);
  }

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

  const commentJson = (c, i) => ({ id: c.id, author: userJson(c.author), body: cloud ? adf(c.body) : c.body, renderedBody: render(cloud ? adf(c.body) : c.body, i), created: c.created, updated: c.updated ?? c.created });
  const png = (res, data, mime = "image/png") => {
    res.writeHead(200, { "content-type": mime, "content-length": data.length });
    res.end(data);
  };

  const handler = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : null;
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const want = url.searchParams.get("fields");
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body: data });
    if (path === "/rest/api/2/serverInfo") return json(res, 200, { deploymentType: cloud ? "Cloud" : "DataCenter", version: cloud ? "1001.0.0" : "9.12.0" });
    // Cloud's avatars are public (another host in reality); everything else needs the login.
    if (path.startsWith("/avatars/")) return png(res, pngOf(48, 48, path.includes("mia") ? [214, 120, 64] : [90, 160, 110]));
    if (state.captcha) return json(res, 403, { errorMessages: ["CAPTCHA_CHALLENGE"] }, { "X-Authentication-Denied-Reason": "CAPTCHA_CHALLENGE; login-url=http://x/login.jsp" });
    if (!authorized(req)) return json(res, 401, { errorMessages: ["You are not authenticated."] });
    if (state.fail?.times > 0) {
      state.fail.times--;
      return json(res, state.fail.status, { errorMessages: [`Failure ${state.fail.status}`] });
    }
    let m;
    if (path === "/secure/useravatar") return png(res, pngOf(48, 48, url.searchParams.get("ownerId") === "mmeyer" ? [214, 120, 64] : [90, 160, 110]));
    if ((m = /^\/rest\/api\/3\/attachment\/(content|thumbnail)\/(\d+)$/.exec(path)) || (m = /^\/secure\/(attachment|thumbnail)\/(\d+)\//.exec(path))) {
      const a = store.flatMap((i) => i.attachments).find((x) => x.id === m[2]);
      if (!a) return json(res, 404, { errorMessages: ["no attachment"] });
      return png(res, a.data, a.mime);
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
      if (rest === "sprint/4/issue") return json(res, 200, { issues: store.filter((i) => i.sprint === "Sprint 4").map((i) => wire(i, want)) });
      return json(res, 404, { errorMessages: ["no"] });
    }
    if (!path.startsWith(api)) return json(res, 404, { errorMessages: ["wrong API version"] });
    const rest = path.slice(api.length);
    if (rest === "myself") return json(res, 200, { ...userJson(me), emailAddress: email, ...(cloud ? {} : { key: "mmeyer" }) });
    if (rest === "field") return json(res, 200, [{ id: "summary", name: "Summary" }, { id: "customfield_10020", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }]);
    if (rest === "mypermissions") {
      const all = ["ADD_COMMENTS", "EDIT_OWN_COMMENTS", "DELETE_OWN_COMMENTS", "WORK_ON_ISSUES", "ASSIGN_ISSUES", "ASSIGNABLE_USER", "TRANSITION_ISSUES"];
      const issue = byKey(url.searchParams.get("issueKey") ?? "");
      // Someone else's issue: comment on it and assign it, nothing more.
      const mine = issue?.assignee === me;
      const anyone = ["ADD_COMMENTS", "EDIT_OWN_COMMENTS", "DELETE_OWN_COMMENTS", "ASSIGN_ISSUES", "ASSIGNABLE_USER"];
      return json(res, 200, { permissions: Object.fromEntries([...all, "EDIT_ALL_COMMENTS", "DELETE_ALL_COMMENTS"].map((p) => [p, { key: p, havePermission: (mine && all.includes(p)) || anyone.includes(p) }])) });
    }
    if (rest === "user/assignable/search" || rest === "user/search") {
      const q = (url.searchParams.get(cloud ? "query" : "username") ?? "").toLowerCase();
      return json(res, 200, Object.keys(users).filter((n) => !q || q === "." || n.toLowerCase().includes(q)).map(userJson));
    }
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
        return json(res, 200, { issues: page.map((i) => wire(i, want)), ...(more ? { nextPageToken: String(start + size) } : {}), isLast: !more });
      }
      const start = Number(url.searchParams.get("startAt") ?? 0);
      return json(res, 200, { startAt: start, maxResults: size, total: found.length, issues: found.slice(start, start + size).map((i) => wire(i, want)) });
    }
    if (rest === "project/search" && cloud) return json(res, 200, { values: [...new Set(store.map((i) => i.project))].map((k) => ({ key: k, name: byKey(store.find((i) => i.project === k).key).projectName })) });
    if (rest === "project" && !cloud) return json(res, 200, [...new Set(store.map((i) => i.project))].map((k) => ({ key: k, name: store.find((i) => i.project === k).projectName })));
    if ((m = /^project\/(\w+)$/.exec(rest))) return json(res, 200, { key: m[1], issueTypes: [{ name: "Task", subtask: false }, { name: "Bug", subtask: false }, { name: "Story", subtask: false }, { name: "Sub-task", subtask: true }] });
    if (rest === "issue" && req.method === "POST") {
      const f = data.fields;
      const n = Math.max(...store.filter((i) => i.project === f.project.key).map((i) => Number(i.key.split("-")[1])), 0) + 1;
      const issue = { key: `${f.project.key}-${n}`, summary: f.summary, type: f.issuetype.name, status: "To Do", category: "new", priority: "Medium", assignee: me, project: f.project.key, projectName: store.find((i) => i.project === f.project.key)?.projectName ?? "", due: null, sprint: "", description: adfText(f.description ?? ""), comments: [], worklogs: [], created: jiraNow(), updated: jiraNow(), labels: [], history: [], customs: {}, attachments: [], subtasks: [], links: [], remote: [], createdWith: data };
      store.push(issue);
      return json(res, 201, { id: String(10000 + store.length - 1), key: issue.key, self: "x" });
    }
    // One comment: edited (PUT) or deleted (DELETE).
    if ((m = /^issue\/([A-Z0-9_]+-\d+)\/comment\/(\w+)$/.exec(rest))) {
      const issue = byKey(m[1]);
      const c = issue?.comments.find((x) => x.id === m[2]);
      if (!c) return json(res, 404, { errorMessages: ["Can not find a comment for the id: " + m[2]] });
      if (req.method === "PUT") {
        Object.assign(c, { body: adfText(data.body), updated: jiraNow() });
        issue.updated = jiraNow();
        return json(res, 200, commentJson(c, issue));
      }
      if (req.method === "DELETE") {
        issue.comments.splice(issue.comments.indexOf(c), 1);
        issue.updated = jiraNow();
        return json(res, 204);
      }
    }
    if ((m = /^issue\/([A-Z0-9_]+-\d+)(\/(\w+))?$/.exec(rest))) {
      const issue = byKey(m[1]);
      if (!issue) return json(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
      const sub = m[3];
      if (!sub && req.method === "GET") return json(res, 200, wire(issue, want, url.searchParams.get("expand") ?? ""));
      if (!sub && req.method === "PUT") {
        const f = data.fields ?? {};
        if ("summary" in f && !String(f.summary ?? "").trim()) return json(res, 400, { errors: { summary: "You must specify a summary of the issue." } });
        if ("labels" in f && f.labels.some((l) => /\s/.test(l))) return json(res, 400, { errors: { labels: "The label must not contain spaces." } });
        if ("customfield_10050" in f && f.customfield_10050 && !ENV_OPTIONS.some((o) => o.id === f.customfield_10050.id)) return json(res, 400, { errors: { customfield_10050: "Option id is not valid." } });
        if ("description" in f && f.description != null && (cloud ? typeof f.description !== "object" || f.description.type !== "doc" : typeof f.description !== "string")) return json(res, 400, { errors: { description: cloud ? "Operation value must be an Atlassian Document." : "Operation value must be a string." } });
        const items = [];
        for (const [k, val] of Object.entries(f)) {
          if (k === "summary") items.push({ field: "summary", fromString: issue.summary, toString: val }), (issue.summary = val);
          else if (k === "description") items.push({ field: "description", fromString: adfText(description(issue) ?? ""), toString: adfText(val ?? "") }), (issue.descriptionRaw = val), (issue.description = adfText(val ?? ""));
          else if (k === "labels") items.push({ field: "labels", fromString: issue.labels.join(" "), toString: val.join(" ") }), (issue.labels = val);
          else if (k === "priority") items.push({ field: "priority", fromString: issue.priority, toString: PRIORITIES.find((p) => p.id === val.id)?.name }), (issue.priority = PRIORITIES.find((p) => p.id === val.id)?.name ?? issue.priority);
          else if (k === "duedate") items.push({ field: "duedate", fromString: issue.due ?? "", toString: val ?? "" }), (issue.due = val);
          else if (k === "assignee") issue.assignee = val ? (userBy(val.accountId ?? val.name)?.name ?? null) : null;
          else if (k === "customfield_10050") items.push({ field: "Environment type", fromString: issue.customs.customfield_10050?.value ?? "", toString: ENV_OPTIONS.find((o) => o.id === val?.id)?.value ?? "" }), (issue.customs.customfield_10050 = val ? ENV_OPTIONS.find((o) => o.id === val.id) : null);
          else if (k === "customfield_10061") items.push({ field: "Customer ref", fromString: issue.customs.customfield_10061 ?? "", toString: val ?? "" }), (issue.customs.customfield_10061 = val);
          else if (k === "timetracking") {
            const secs = (t) => (t ? t.split(/\s+/).reduce((a, p) => a + Number.parseFloat(p) * ({ w: 144000, d: 28800, h: 3600, m: 60 }[p.slice(-1)] ?? 60), 0) : undefined);
            const est = { ...(issue.estimates ?? {}) };
            if (val.originalEstimate) Object.assign(est, { originalEstimate: val.originalEstimate, originalEstimateSeconds: secs(val.originalEstimate) });
            if (val.remainingEstimate) Object.assign(est, { remainingEstimate: val.remainingEstimate, remainingEstimateSeconds: secs(val.remainingEstimate) });
            items.push({ field: "timeestimate", fromString: issue.estimates?.remainingEstimate ?? "", toString: est.remainingEstimate ?? "" });
            issue.estimates = est;
          } else if (k === pointsField) items.push({ field: cloud ? "Story point estimate" : "Story Points", fromString: String(issue.customs.points ?? ""), toString: String(val ?? "") }), (issue.customs.points = val);
          else return json(res, 400, { errors: { [k]: `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.` } });
        }
        changed(issue, me, items);
        return json(res, 204);
      }
      if (sub === "assignee" && req.method === "PUT") {
        const id = data.accountId ?? data.name;
        const before = issue.assignee;
        issue.assignee = id ? (userBy(id)?.name ?? null) : null;
        changed(issue, me, [{ field: "assignee", fromString: before ?? "", toString: issue.assignee ?? "" }]);
        return json(res, 204);
      }
      if (sub === "comment" && req.method === "POST") {
        const c = { id: String(state.nextId++), author: me, created: jiraNow(), body: adfText(data.body) };
        issue.comments.push(c);
        issue.updated = jiraNow();
        return json(res, 201, commentJson(c, issue));
      }
      if (sub === "comment" && req.method === "GET") {
        // Cloud sorts by `orderBy`; Server answers oldest first whatever is asked (old versions do).
        const newest = cloud && url.searchParams.get("orderBy") === "-created";
        const list = newest ? [...issue.comments].reverse() : issue.comments;
        const start = Number(url.searchParams.get("startAt") ?? 0);
        const max = Number(url.searchParams.get("maxResults") ?? 50);
        return json(res, 200, { startAt: start, maxResults: max, total: list.length, comments: list.slice(start, start + max).map((c) => commentJson(c, issue)) });
      }
      if (sub === "remotelink" && req.method === "GET") return json(res, 200, issue.remote);
      if (sub === "changelog" && req.method === "GET" && cloud) {
        const start = Number(url.searchParams.get("startAt") ?? 0);
        const max = Number(url.searchParams.get("maxResults") ?? 100);
        return json(res, 200, { startAt: start, maxResults: max, total: issue.history.length, values: issue.history.slice(start, start + max).map(historyJson) });
      }
      if (sub === "transitions" && req.method === "GET") return json(res, 200, { transitions: transitions(url.searchParams.get("expand") === "transitions.fields") });
      if (sub === "transitions" && req.method === "POST") {
        const id = data.transition.id;
        const to = { 11: ["In Progress", "indeterminate"], 31: ["Done", "done"], 41: ["Resolved", "done"], 51: ["To Do", "new"] }[id];
        if (!to) return json(res, 400, { errorMessages: ["Transition id '" + id + "' is not valid for this issue."] });
        if (id === "41" && !data.fields?.resolution?.id) return json(res, 400, { errors: { resolution: "Resolution is required." } });
        const before = issue.status;
        [issue.status, issue.category] = to;
        if (id === "41") issue.resolution = RESOLUTIONS.find((r) => r.id === data.fields.resolution.id)?.name;
        for (const add of data.update?.comment ?? []) issue.comments.push({ id: String(state.nextId++), author: me, created: jiraNow(), body: adfText(add.add.body) });
        changed(issue, me, [{ field: "status", fromString: before, toString: issue.status }]);
        return json(res, 204);
      }
      if (sub === "worklog" && req.method === "POST") {
        if (state.failWorklogs > 0) {
          state.failWorklogs--;
          return json(res, 500, { errorMessages: ["Internal server error"] });
        }
        const w = { id: String(state.nextId++), started: data.started, timeSpentSeconds: data.timeSpentSeconds, timeSpent: `${Math.round(data.timeSpentSeconds / 60)}m`, comment: adfText(data.comment ?? ""), author: cloud ? { accountId: "acc-mia", displayName: me } : { name: "mmeyer", displayName: me } };
        issue.worklogs.push(w);
        issue.updated = jiraNow();
        return json(res, 201, w);
      }
      if (sub === "worklog" && req.method === "GET") {
        // Server answers all at once; Cloud pages.
        if (!cloud) return json(res, 200, { startAt: 0, maxResults: issue.worklogs.length, total: issue.worklogs.length, worklogs: issue.worklogs });
        const start = Number(url.searchParams.get("startAt") ?? 0);
        const max = Number(url.searchParams.get("maxResults") ?? 5000);
        return json(res, 200, { startAt: start, maxResults: max, total: issue.worklogs.length, worklogs: issue.worklogs.slice(start, start + max) });
      }
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
    edit,
    stop: close,
    start: open,
    close,
  }));
}
