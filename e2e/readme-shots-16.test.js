// Screenshots for the README of 1.6 (not part of the test suite): the app in English with
// English sample content, a week of SAP project work (meetings in several Outlook calendars,
// bookings, focus sessions, page editing, chats), in light and dark. Run after building the app:
//   ARCALO_SHOTS=../docs/screenshots ARCALO_APP=../target/debug/arcalo node --test readme-shots-16.test.js
// ARCALO_SCENES=split,calendar,… takes only some scenes (names in SCENES below; "firstrun" is the
// intro and the setup on a fresh workspace). ARCALO_SCALE sets the device scale factor (default
// 1; at 2 the X display must be at least 2960x1840). The week is the current one; the pictures
// tell their story best from Wednesday to Friday (the daily review shows the day before).
import { test, before, after } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import { launch, SHOTS } from "./lib/harness.js";
import { week, outlookItem } from "./lib/calendar-fixtures.js";
import { openCapture } from "./lib/capture.js";
import { readPng } from "./lib/png.js";

const SCALE = process.env.ARCALO_SCALE ?? "1";
const ONLY = process.env.ARCALO_SCENES?.split(",") ?? null;
const want = (name) => !ONLY || ONLY.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const cur = week(0);
const prev = week(-1);
const prev2 = week(-2);
const at = cur.at;

let app, llm, tmp;

// ---------------------------------------------------------------- a fake AI server in English

/** A LiteLLM-compatible server whose answers are short English texts fitting the sample week. */
function startFakeAI() {
  const MODELS = ["company-fast", "company-standard", "company-reasoning", "company-embed"];
  const key = "sk-readme-arcalo";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/model/info" || req.url === "/v1/model/info") return reply(200, { data: MODELS.map((m) => ({ model_name: m, litellm_params: { model: m }, model_info: { mode: m.endsWith("embed") ? "embedding" : null } })) });
    if (req.url === "/v1/models") return reply(200, { data: MODELS.map((id) => ({ id, object: "model" })) });
    if (req.url === "/v1/embeddings") {
      const vec = (t) => Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7 + (t.length % (i + 2)) / 10);
      return reply(200, { data: json.input.map((t, index) => ({ index, embedding: vec(t) })) });
    }
    if (req.url !== "/v1/chat/completions") return reply(404, {});
    const msgs = json.messages;
    const sys = msgs.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n");
    const user = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    let text;
    if (/assign time entries|ordnest Zeitbuchungen/.test(sys)) {
      const work = (user.match(/(?:Work|Tätigkeit): (.*)$/m)?.[1] ?? "").toLowerCase();
      const words = work.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
      const lines = user.split("\n").filter((l) => /^- \S+ \| /.test(l));
      let best = lines[0] ?? "";
      let score = -1;
      for (const l of lines) {
        const s = words.filter((w) => l.toLowerCase().includes(w)).length;
        if (s > score) [best, score] = [l, s];
      }
      const reference = best.match(/^- (\S+) \|/)?.[1] ?? "NP-0000";
      text = JSON.stringify({ reference, leistungsart: "DEV", confidence: 0.84, reason: `Mapping work was booked on ${reference} three times this week` });
    } else if (/You edit texts|Du bearbeitest Texte/.test(sys) && /meeting|Besprechung/i.test(user.split("<text>")[0])) {
      text = [
        "## Summary",
        "",
        "The weekly sync went through the state of the rollout. The delta load is stable, so the integration test can start next week.",
        "",
        "## Decisions",
        "",
        "- The go-live stays at the end of October",
        "- Returns follow in phase 3",
        "",
        "## Tasks",
        "",
        `- [ ] Align the test plan with [[Architecture]] @Max due:${iso(at(7, 0))} !!`,
        `- [ ] Send the training dates to the key users @Lea due:${iso(at(4, 0))}`,
        "",
        "## Open points",
        "",
        "- Who signs off the master data process?",
      ].join("\n");
    } else if (/You edit texts|Du bearbeitest Texte/.test(sys)) {
      text = "The middleware links the ERP to the order portal through IDocs. #architecture";
    } else {
      text = [
        "The integration test can start on Monday: the delta load has been running without errors since last week [1], and test data for activity 1040 is still open.",
        "",
        "- **Done:** IDoc mapping, OpenAPI specification",
        "- **Open:** test data for 1040, training dates for NP-8802",
        "- **Risk:** activity 1020 is on the critical path [1]",
        "",
        "Next step: align the test cases with the business team in the weekly sync.",
      ].join("\n");
      if (!/nummerierte Quellen|numbered sources/.test(sys)) text = text.replace(/ \[1\]/g, "");
    }
    res.writeHead(200, { "content-type": "text/event-stream", "x-litellm-response-cost": "0.0012" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const words = text.match(/\S+\s*/g) ?? [];
    for (const w of words) {
      send({ choices: [{ delta: { content: w } }] });
      await sleep(6);
    }
    send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    send({ choices: [], usage: { prompt_tokens: 1840, completion_tokens: words.length } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, key, close: () => new Promise((r) => server.close(r)) })));
}

// ---------------------------------------------------------------- fixtures

/** Outlook with three calendars: the own one, the sub-calendar „Project X“ and a colleague's. */
function outlookFixture() {
  const teams = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_readme%40thread.v2/0";
  const safe = `https://eur02.safelinks.protection.outlook.com/?url=${encodeURIComponent(teams)}&data=05%7C02&reserved=0`;
  const items = [
    outlookItem("WS1", "Weekly sync changes", at(0, 10), at(0, 11), { recurring: true, organizer: "Miller, Anna", attendees: ["Miller, Anna", "White, George"], urls: [safe] }),
    outlookItem("WS0", "Weekly sync changes", prev.at(0, 10), prev.at(0, 11), { recurring: true, organizer: "Miller, Anna" }),
    outlookItem("IR", "Interface review", at(1, 14), at(1, 15), { location: "Room Zurich" }),
    outlookItem("AR", "Architecture round", at(2, 11), at(2, 12)),
    outlookItem("CM", "Customer meeting Miller", at(3, 13), at(3, 14, 30), { location: "Microsoft Teams meeting", organizer: "Miller, Anna", attendees: ["Miller, Anna", "White, George"], urls: [teams] }),
    outlookItem("CM0", "Customer meeting Miller", prev2.at(3, 13), prev2.at(3, 14)),
    outlookItem("SR", "Sprint review", at(4, 14), at(4, 15)),
    outlookItem("GL", "Go-live checklist", at(4, 16), at(4, 16, 30)),
  ];
  const folder = (entryId, name, extra = {}) => ({ entryId, storeId: "S-OWN", name, path: "", store: "maurice@company.com", storeType: 0, filePath: "", default: false, nav: false, group: "", groupType: -1, owner: "maurice@company.com", recipient: "", person: false, items: 4, freeBusy: false, error: "", message: "", ...extra });
  return JSON.stringify({
    ok: true,
    version: "16.0.0.0",
    mode: "restrict",
    items,
    discovery: {
      ok: true,
      version: "16.0.0.0",
      navError: "",
      calendars: [
        folder("E-DEFAULT", "Calendar", { default: true, path: "\\\\maurice@company.com\\Calendar", items: 412 }),
        folder("E-PROJ", "Project X", { path: "\\\\maurice@company.com\\Calendar\\Project X", items: 12 }),
        folder("E-ANNA", "Calendar", { storeId: "S-ANNA", store: "Anna Miller", owner: "Anna Miller", recipient: "Anna Miller", storeType: 1, nav: true, group: "Shared Calendars", groupType: 4, items: 55 }),
        folder("", "George White", { storeId: "", store: "", owner: "George White", recipient: "George White", storeType: -1, nav: true, group: "Shared Calendars", groupType: 4, items: -1, freeBusy: true }),
        folder("E-ROOM", "Room Zurich", { storeId: "S-ROOM", store: "Room Zurich", owner: "Room Zurich", recipient: "Room Zurich", storeType: 1, nav: true, group: "Rooms", groupType: 6, items: 3 }),
      ],
    },
    folders: {
      "E-PROJ": { items: [outlookItem("PS1", "Project X sync", at(2, 15), at(2, 15, 30)), outlookItem("DM", "Data migration dry run", at(4, 9), at(4, 11))] },
      "E-ANNA": { items: [outlookItem("SA", "Sales round", at(1, 11), at(1, 12)), outlookItem("WP", "Workshop preparation", at(3, 15, 30), at(3, 16, 30))] },
      "George White": { freeBusy: true, mode: "freebusy", items: [] },
      "E-ROOM": { items: [] },
    },
  });
}

/** The mail selected in Outlook (the script's output). */
const MAIL = {
  ok: true,
  version: "16.0.0.17928",
  source: "selection",
  items: [
    {
      entryId: "00000000AB12",
      storeId: "0000000038A1BB10",
      subject: "RE: Test data for the integration test",
      senderName: "Miller, Anna",
      senderEmail: "anna.miller@example.com",
      to: "Project team order portal",
      cc: "White, George",
      received: utc(at(3, 8, 42)),
      conversation: "Test data for the integration test",
      importance: 2,
      categories: "Project X",
      body:
        "Hi all,\r\n\r\nthe test data for the orders is now in the Q system. Please check by Tuesday whether the special cases (partial delivery, cancellation) are covered and let me know.\r\n\r\nBest regards\r\nAnna",
      truncated: false,
      attachments: [
        { index: 1, name: "Test data orders.xlsx", size: 48213, type: 1, inline: false, data: "" },
        { index: 2, name: "Test cases integration test.pdf", size: 132870, type: 1, inline: false, data: "" },
      ],
    },
  ],
};

/** Browser profiles below a temp home folder: Chrome „Work“ with a bookmarks bar. */
function bookmarkProfiles(home) {
  const T = "13348540800000000";
  const url = (name, u) => ({ type: "url", name, url: u, date_added: T });
  const dir = (name, children) => ({ type: "folder", name, children, date_added: T });
  const work = {
    roots: {
      bookmark_bar: dir("Bookmarks bar", [
        url("Jira", "https://jira.example.com/projects/PORTAL"),
        url("Confluence", "https://confluence.example.com/display/PORTAL"),
        dir("SAP", [url("Fiori launchpad", "https://fiori.example.com/launchpad"), url("CATS time sheet", "https://fiori.example.com/cats"), url("Solution Manager", "https://solman.example.com")]),
        dir("Monitoring", [url("Grafana", "https://grafana.example.com/d/portal"), url("Kibana", "https://kibana.example.com/app/discover"), url("Status page", "https://status.example.com")]),
        url("GitLab", "https://gitlab.example.com/portal"),
        url("Translate", "javascript:void(0)"),
      ]),
      other: dir("Other bookmarks", [url("Travel expenses", "https://travel.example.com"), url("Cafeteria menu", "https://intranet.example.com/menu")]),
      synced: dir("Mobile bookmarks", []),
    },
    version: 1,
  };
  const personal = { roots: { bookmark_bar: dir("Bookmarks bar", [url("Weather", "https://weather.example.com/")]), other: dir("Other bookmarks", []) }, version: 1 };
  const chrome = path.join(home, ".config/google-chrome");
  fs.mkdirSync(path.join(chrome, "Default"), { recursive: true });
  fs.mkdirSync(path.join(chrome, "Profile 1"), { recursive: true });
  fs.writeFileSync(path.join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work" }, "Profile 1": { name: "Personal" } } } }));
  fs.writeFileSync(path.join(chrome, "Default/Bookmarks"), JSON.stringify(work));
  fs.writeFileSync(path.join(chrome, "Profile 1/Bookmarks"), JSON.stringify(personal));
}

const SPRINT = `---
properties:
  status: {type: select, options: {Open: grey, In progress: blue, Review: yellow, Done: green}}
  effort: number
  due: date
  owner: person
view:
  type: board
  group: status
  cards: [due, owner, effort]
---
Tasks for the go-live of the order portal. Drag a card to change its status.
`;
const TASKS = [
  ["IDoc mapping ORDERS05", "Done", 6, iso(at(-3, 0)), "Anna"],
  ["Test the delta load", "Review", 4, iso(at(0, 0)), "Max"],
  ["Error queue with retry", "In progress", 8, iso(at(2, 0)), "Max"],
  ["OpenAPI specification", "In progress", 5, iso(at(4, 0)), "Anna"],
  ["Key user training", "Open", 3, iso(at(8, 0)), "Lea"],
  ["Monitoring dashboard", "Open", 5, iso(at(10, 0)), "Max"],
];

const DECK = `# Status report week 40

Order portal · rollout phase 2

---

## Achieved

- IDoc mapping for orders completed
- Delta load runs stable (3 days without errors)
- API specification agreed with the business team

> [!note]
> Thank Anna for the mapping.

---

## Budget

| Activity | Plan | Actual |
|---|---|---|
| System integration | 120 h | 96 h |
| Interfaces | 80 h | 71 h |
| Test | 60 h | 18 h |

---

## Next steps

1. Integration test with the business team
2. Release the go-live checklist
3. Key user training on October 12
`;

const CONCEPT = `---
activity: NP-8801/1030
---
[TOC]

## Target picture

The order portal hands orders to SAP as IDocs[^1]; status and delivery data come back through the delta load.

<!-- columns -->

### Benefits

- No double entry
- Status in real time
- Errors land in a queue

<!-- column -->

### Risks

- Mapping effort for special cases
- Depends on the middleware team

<!-- /columns -->

> [!tip]+ Decision
> We start with orders; returns follow in phase 3.

> [!info]- Technical details
> Queue: persistent processing with retry, at most 5 attempts.

## Open questions

- [ ] Clarify the release process for master data due:${iso(at(3, 0))}
- [x] Provide the test system

[^1]: Message type ORDERS05, basic type ORDERS05, extension ZORD.
`;

const TESTPLAN = `---
activity: NP-8801/1040
---
Integration test of the order flow portal → middleware → SAP.

## Test cases

- [x] Create test cases for orders
- [ ] Align test data with the business team due:${iso(at(7, 0))} !!
- [ ] Check the partial delivery case due:${iso(at(3, 0))}
`;

const MINUTES = `---
date: ${iso(at(2, 0))}
attendees: [Anna Miller, George White]
---
## Results

- The go-live stays at the end of October
- Returns follow in phase 3

## Tasks

- [ ] Review the offer for phase 3 @George due:${iso(at(8, 0))}
- [ ] Send the minutes to the customer due:${iso(at(3, 0))} !
`;

// ---------------------------------------------------------------- helpers

const ready = () => app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
const openTree = async (title) => {
  await app.browser.waitUntil(async () => {
    for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return true;
    return false;
  }, { timeout: 8000, timeoutMsg: `no ${title} in the tree` });
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
};
const panel = (open) =>
  app.browser.execute((o) => {
    if (!!document.querySelector(".app > .panel") !== o) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  }, open);
const sidebar = (open) =>
  app.browser.execute((o) => {
    if (!!document.querySelector(".sidebar") !== o) document.querySelector(".ribbon .icon-btn")?.click();
  }, open);
/** Moves the mouse out of the way (also the pointer WebDriver's clicks used). */
const calm = async (x = 5, y = 880) => {
  const bar = await app.$(".statusbar");
  if (await bar.isExisting().catch(() => false)) await bar.moveTo().catch(() => {});
  await app.browser.performActions([{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x, y }] }]).catch(() => {});
};
/** A text cursor in the last heading instead of a selected first block (blurred later). */
const placeCursor = () => app.click(".pane.active > .pane-content:not([hidden]) .ProseMirror h2:last-of-type");
/** No caret, selection, hover state or toast in the picture. */
const settle = async (x = 5, y = 880) => {
  await app.browser.execute(() => {
    document.activeElement?.blur?.();
    getSelection()?.removeAllRanges();
  });
  await app.dismissToasts();
  await calm(x, y);
  await app.browser.releaseActions().catch(() => {});
  await sleep(500);
};
const settings = async () => (await app.invoke("settings_get")).settings;
const save = async (patch) => {
  const s = await settings();
  await app.invoke("settings_save", { settings: { ...s, ...patch(s) } });
};
const setTheme = async (theme) => {
  if ((await settings()).theme === theme && (await app.browser.execute(() => document.documentElement.dataset.theme)) === theme) return;
  await save(() => ({ theme }));
  await app.browser.refresh();
  await ready();
  await sleep(800);
};
const closeTabs = async () => {
  for (let i = 0; i < 4; i++) {
    await app.browser.execute(() => {
      for (const b of [...document.querySelectorAll(".tabbar .tab .tab-close")]) b.click();
    });
    await sleep(120);
  }
  // Back to one pane.
  await app.browser.execute(() => {
    const panes = document.querySelectorAll(".workspace > .pane");
    if (panes.length > 1) panes[panes.length - 1].querySelector(".tabbar .tab .tab-close")?.click();
  });
  await sleep(200);
};
const dialogGone = () => app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".dialog"))), { timeout: 8000 });
const clickText = async (sel, text) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, t) => {
          const el = [...document.querySelectorAll(s)].find((b) => (t.startsWith("/") ? new RegExp(t.slice(1, -1)).test(b.textContent.trim()) : b.textContent.trim() === t) && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        text,
      ),
    { timeout: 8000, timeoutMsg: `no ${sel} „${text}“` },
  );
  await sleep(120);
};
async function palette(text, item) {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette input");
  await app.type(text);
  await app.waitText(".pal-item", item);
  for (const it of await app.$$(".pal-item"))
    if (item.test(await app.textOf(it))) {
      await it.click();
      return;
    }
}
const selectText = (text) =>
  app.browser.execute((t) => {
    const root = document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i < 0) continue;
      root.focus();
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + t.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    return false;
  }, text);
const openSettings = async (section) => {
  await app.keys(["Control", ","]);
  await app.click(`.settings-nav-item[data-section="${section}"]`);
  await sleep(500);
};
/** Scrolls the settings so the group whose heading reads `title` is at the top. */
const scrollToGroup = (title) =>
  app.browser.execute((t) => {
    const h = [...document.querySelectorAll(".settings h2, .settings h3, .settings .set-group-title")].find((e) => e.textContent.trim() === t);
    h?.scrollIntoView({ block: "start" });
    return !!h;
  }, title);
/** Saves the part of the window that `sel` covers (WebKit's element screenshots run past it). */
async function shotOf(sel, name) {
  const r = await app.browser.execute((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, dpr: window.devicePixelRatio };
  }, sel);
  const img = readPng(await app.browser.takeScreenshot());
  const [x0, y0, w, h] = [r.x, r.y, r.w, r.h].map((v) => Math.round(v * r.dpr));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [cr, cg, cb] = img.pixel(Math.min(x0 + x, img.width - 1), Math.min(y0 + y, img.height - 1));
      raw.set([cr, cg, cb], y * (w * 3 + 1) + 1 + x * 3);
    }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), png);
}
const shot = async (name) => {
  await app.shot(name);
};

// ---------------------------------------------------------------- seed

let ids = {};

async function seed() {
  // AI provider, rounding, sample quick links.
  await save((s) => ({
    time: { ...s.time, rounding: { step_minutes: 15, mode: "up", min_minutes: 0 } },
    providers: [{ id: "litellm", name: "Company LiteLLM", kind: "litellm", base_url: llm.url, local: false, enabled: true, bypass_proxy: true, api_version: "", models: [] }],
    auto_route: false,
    router: { ...s.router, local_provider: "litellm", local_model: "company-fast", standard_provider: "litellm", standard_model: "company-standard", reasoning_provider: "litellm", reasoning_model: "company-reasoning" },
    embedding_provider: "litellm",
    embedding_model: "company-embed",
  }));
  await app.invoke("provider_key_set", { id: "litellm", key: llm.key });
  await app.invoke("quick_links_save", {
    links: [
      {
        name: "SAP",
        url: "",
        icon: "briefcase",
        kind: "group",
        color: "blau",
        items: [
          { name: "Fiori launchpad", url: "https://fiori.example.com/launchpad", icon: "globe" },
          { name: "CATS time sheet", url: "https://fiori.example.com/cats", icon: "clipboard-list" },
          { name: "Solution Manager", url: "https://solman.example.com", icon: "wrench" },
          { name: "SAP Logon", url: "C:\\Program Files\\SAP\\FrontEnd\\SAPGUI\\saplogon.exe", icon: "app-window", kind: "app" },
        ],
      },
      { name: "Jira", url: "https://jira.example.com/projects/PORTAL", icon: "ticket" },
    ],
  });

  // Only this week's story counts: no demo bookings.
  for (const e of await app.invoke("time_entries", { from: null, to: null })) await app.invoke("delete_time_entry", { id: e.id });
  const tree = await app.invoke("wbs_tree");
  const np = (nr) => tree.flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr === nr).id;
  ids = { np8801: np("NP-8801"), np8802: np("NP-8802") };

  const walk = (nodes, t) => {
    for (const n of nodes) {
      if (n.title === t) return n;
      const hit = walk(n.children ?? [], t);
      if (hit) return hit;
    }
    return null;
  };
  const project = walk(await app.invoke("workspace_tree"), "PRJ-2026-X Rollout");
  const concept = await app.invoke("page_create", { parentId: project.id, title: "Order portal concept", icon: "book-open", content: CONCEPT });
  const testplan = await app.invoke("page_create", { parentId: project.id, title: "Integration test plan", icon: "list-checks", content: TESTPLAN });
  const minutes = await app.invoke("page_create", { parentId: project.id, title: `Customer meeting Miller ${pad(at(2, 0).getDate())}.${pad(at(2, 0).getMonth() + 1)}.`, icon: "users", content: MINUTES });
  const sprint = await app.invoke("page_create", { parentId: null, title: "Go-live sprint", icon: "folder-kanban", content: SPRINT });
  for (const [title, status, effort, due, owner] of TASKS)
    await app.invoke("page_create", { parentId: sprint.id, title, icon: null, content: `---\nstatus: ${status}\neffort: ${effort}\ndue: ${due}\nowner: ${owner}\n---\n` });
  await app.invoke("page_create", { parentId: null, title: "Status report week 40", icon: "flag", content: DECK });
  await app.browser.execute((id) => localStorage.setItem("arcalo.page-full", JSON.stringify([id])), sprint.id);
  ids.concept = concept.id;
  ids.sprint = sprint.id;

  // Today's daily note with a few tasks.
  const daily = await app.invoke("daily_note", { date: iso(new Date()) });
  await app.invoke("page_save", {
    id: daily.id,
    content: `## Today\n\n- [ ] Send the offer to Miller !!\n- [ ] Prepare the interface review\n- [x] Check the delta load log\n- [ ] Submit travel expenses\n\n## Notes\n\n- Anna sends the test data on Tuesday\n`,
  });

  // Bookings of the week (and two earlier ones Arcalo learns from).
  const book = (np, vorgang, la, start, minutes, description) =>
    app.invoke("time_entry_create", { netzplanId: np, vorgangNr: vorgang, leistungsart: la, startTime: start.toISOString(), durationMinutes: minutes, description });
  const { np8801: a, np8802: b } = ids;
  await book(a, "1020", "DEV", at(0, 8), 120, "IDoc mapping material master");
  await book(a, "1030", "DEV", at(0, 12, 30), 240, "REST interface order data");
  await book(a, "1020", "DEV", at(1, 8), 180, "Error analysis queue processing");
  await book(a, "1020", "DEV", at(1, 12, 30), 90, "Delta load delivery status");
  await book(a, "1020", "DEV", at(1, 15), 90, "Code review mapping");
  await book(a, "1030", "DEV", at(2, 8), 180, "OpenAPI specification");
  await book(a, "1040", "TEST", at(2, 15, 30), 90, "Test cases orders");
  await book(a, "1020", "DEV", at(3, 8), 240, "System integration delta load");
  await book(a, "1010", "PM", prev.at(0, 10), 60, "Weekly sync changes");
  await book(b, "2010", "PM", prev2.at(3, 13), 60, "Customer meeting Miller");

  // Outlook: own calendar, „Project X“ and Anna's calendar.
  await save((s) => ({ calendar: { ...s.calendar, outlook: true } }));
  const found = await app.invoke("calendar_outlook_discover");
  const idOf = (entry) => found.outlook_calendars.find((c) => c.entry_id === entry)?.id;
  ids.proj = idOf("E-PROJ");
  ids.anna = idOf("E-ANNA");
  if (!ids.proj || !ids.anna) throw new Error("calendar ids not found");
  await app.invoke("calendar_outlook_update", { id: ids.proj, enabled: true, color: null, booking: null });
  await app.invoke("calendar_outlook_update", { id: ids.anna, enabled: true, color: null, booking: null });
  await app.invoke("calendar_sync_now", { source: null });
  await app.browser.waitUntil(async () => (await app.invoke("calendar_status")).sources.every((s) => !s.syncing && s.status?.synced_at), { timeout: 30000, timeoutMsg: "not synced" });
  const events = await app.invoke("calendar_events", { from: prev2.monday.toISOString(), to: week(1).monday.toISOString() });
  const lastWs = events.find((e) => e.title === "Weekly sync changes" && new Date(e.start).getTime() === prev.at(0, 10).getTime());
  const entries = await app.invoke("time_entries", { from: null, to: null });
  const wsEntry = entries.find((e) => e.description === "Weekly sync changes");
  if (lastWs && wsEntry) await app.invoke("calendar_link_entry", { key: lastWs.key, entryId: wsEntry.id });

  // Journal rows: page editing, tasks and files; focus sessions.
  const db = new DatabaseSync(path.join(app.dataDir, "workspace.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const act = db.prepare("INSERT INTO activity (at, kind, page_id, title, detail, amount, count) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const edit = (d, page, title, count, chars = 900) => act.run(utc(d), "page_edited", page, title, "", chars, count);
  edit(at(0, 11, 58), concept.id, "Order portal concept", 30);
  edit(at(2, 10, 40), concept.id, "Order portal concept", 9, 300);
  act.run(utc(at(2, 13, 2)), "page_created", minutes.id, "Customer meeting Miller", "", 640, 12);
  edit(at(2, 14, 50), testplan.id, "Integration test plan", 26, 1400);
  edit(at(2, 16, 25), testplan.id, "Integration test plan", 11, 500);
  act.run(utc(at(2, 10, 12)), "task_done", concept.id, "Provide the test system", "", 0, 1);
  act.run(utc(at(2, 15, 40)), "task_done", testplan.id, "Create test cases for orders", "", 0, 1);
  act.run(utc(at(2, 14, 20)), "task_added", minutes.id, "Review the offer for phase 3", "", 0, 1);
  act.run(utc(at(2, 15, 55)), "task_added", testplan.id, "Align test data with the business team", "", 0, 1);
  act.run(utc(at(2, 14, 5)), "file_added", null, "Delivery plan week 41.xlsx", "File", 0, 1);
  const focus = db.prepare(
    `INSERT INTO focus_sessions (netzplan_id, vorgang_nr, reference, goal, started_at, planned_minutes, ended_at, status, worked_minutes)
     VALUES (?, ?, ?, ?, ?, 50, ?, 'done', 50)`,
  );
  focus.run(a, "1020", "NP-8801/1020", "Mapping ORDERS05", utc(at(1, 13)), utc(at(1, 13, 50)));
  focus.run(a, "1030", "NP-8801/1030", "Error cases of the delta load", utc(at(2, 13)), utc(at(2, 13, 50)));
  db.close();

  // Earlier chats for the history.
  const chat = async (title, q, a, daysAgo, pinned = false) => {
    const c = await app.invoke("chat_create", { title });
    const msg = (role, content) => ({ role, content, display: null, tool_calls: null, tool_call_id: null, tool: null, citations: null, provider: "litellm", model: "company-standard", tier: "standard", reasons: null, meta: null, tokens: 420, cost_usd: 0.0012, error: null, cancelled: false });
    await app.invoke("chat_append", { id: c.id, messages: [msg("user", q), msg("assistant", a)], pageId: null, private: null });
    if (pinned) await app.invoke("chat_update", { id: c.id, patch: { title: null, pinned: true, archived: null } });
    return { id: c.id, daysAgo };
  };
  const made = [
    await chat("Weekly report week 39", "Draft this week's status e-mail", "Here is a draft of the status e-mail for week 39 …", 9, true),
    await chat("Budget of NP-8801", "How is the budget of NP-8801?", "NP-8801 has used 96 of 120 hours …", 0),
    await chat("Open tasks before the go-live", "Which tasks are still open before the go-live?", "Five tasks are open …", 1),
    await chat("Summarize the architecture", "Summarize the architecture page", "The middleware connects the ERP …", 1),
    await chat("Translate the customer e-mail", "Translate Anna's e-mail into German", "Hallo zusammen …", 4),
    await chat("Gaps in the timesheet", "Where are gaps in this week's bookings?", "Thursday afternoon is not booked yet …", 6),
    await chat("Delta load error codes", "What do the delta load error codes mean?", "The codes come from the queue …", 12),
  ];
  const db2 = new DatabaseSync(path.join(app.dataDir, "workspace.db"));
  db2.exec("PRAGMA busy_timeout = 5000");
  const upd = db2.prepare("UPDATE chat_conversations SET created_at = ?, updated_at = ? WHERE id = ?");
  for (const m of made) {
    const d = new Date(Date.now() - m.daysAgo * 86400e3 - 2 * 3600e3);
    upd.run(d.toISOString(), d.toISOString(), m.id);
  }
  db2.close();

  await app.browser.refresh();
  await ready();
}

// ---------------------------------------------------------------- scenes

async function split() {
  await setTheme("light");
  await closeTabs();
  await sidebar(true);
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await app.browser.execute(() => {
    const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.innerText.trim() === "PRJ-2026-X Rollout");
    const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: b.left + 20, clientY: b.top + 5 }));
  });
  await app.waitFor(".menu");
  await clickText(".menu-item", "/Open (to|on) the right/");
  await sleep(800);
  await panel(true);
  await sleep(600);
  await settle();
  await shot("split-view");
}

async function note() {
  await setTheme("dark");
  await closeTabs();
  await panel(false);
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await app.click(".pane.active > .pane-content:not([hidden]) .ProseMirror > p");
  await settle();
  await shot("note-dark");
}

async function preview() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("PRJ-2026-X Rollout");
  const link = await app.waitFor('.pane.active > .pane-content:not([hidden]) .ProseMirror a[data-wikilink][data-target="Architecture"]');
  await settle();
  await link.moveTo();
  await app.waitText(".link-preview-title", /Architecture/);
  await sleep(600);
  await shot("link-preview");
  await calm();
  await sleep(400);
}

async function tableToolbar() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("PRJ-2026-X Rollout");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror table");
  await app.browser.execute(() => {
    const cell = [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .ProseMirror td")].find((c) => c.textContent.includes("ERP system integration"));
    const p = cell.querySelector("p") ?? cell;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror").focus();
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await app.waitFor(".table-toolbar");
  await calm();
  await sleep(600);
  await shot("table-toolbar");
}

async function versions() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  const page = await app.invoke("page_resolve", { title: "Architecture", create: false });
  const original = (await app.invoke("page_get", { id: page.id })).content;
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  // A first version, then an edited state.
  await app.click('.pane.active > .pane-content:not([hidden]) [aria-label="More actions"]');
  await clickText(".menu-item", "/Versions/");
  await app.waitFor(".versions-snapshot");
  await app.click(".versions-snapshot");
  await app.waitFor(".versions-item");
  await sleep(300);
  await app.keys(["Escape"]);
  await dialogGone();
  await app.invoke("page_save", {
    id: page.id,
    content: original.replace("- **Queue**: persistent processing with retry", "- **Queue**: persistent processing with retry, at most 5 attempts\n- **Monitoring**: Grafana dashboard with alerts").replace("A delay moves the acceptance.", "A delay moves the acceptance and the go-live."),
  });
  await app.browser.refresh();
  await ready();
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await app.click('.pane.active > .pane-content:not([hidden]) [aria-label="More actions"]');
  await clickText(".menu-item", "/Versions/");
  await app.waitFor(".versions-snapshot");
  await app.click(".versions-snapshot");
  await app.browser.waitUntil(async () => (await app.$$(".versions-item")).length >= 2, { timeout: 8000 });
  const items = await app.$$(".versions-item");
  await items[items.length - 1].click();
  await sleep(400);
  await clickText(".versions-preview .segmented button", "/Differences/");
  await app.waitFor(".versions-diff .diff-add, .versions-diff .diff-del");
  await settle();
  await shot("versions-diff");
  await app.keys(["Escape"]);
  await dialogGone();
  await app.invoke("page_save", { id: page.id, content: original });
}

async function board() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("Go-live sprint");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .coll .board-col");
  await settle();
  await shot("board-view");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .coll button")].find((b) => b.innerText.trim() === "Table")?.click());
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .coll-table");
  await settle();
  await shot("table-view");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .coll button")].find((b) => b.innerText.trim() === "Board")?.click());
}

async function blocks() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("Order portal concept");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await app.click(".pane.active > .pane-content:not([hidden]) .ProseMirror > p");
  await settle();
  await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .ProseMirror .toc-block")?.scrollIntoView({ block: "start" }));
  await sleep(300);
  await shot("editor-blocks");
}

async function present() {
  await setTheme("light");
  await closeTabs();
  await openTree("Status report week 40");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await app.click('.pane.active > .pane-content:not([hidden]) [aria-label="More actions"]');
  await clickText(".menu-item", "/^Present/");
  await app.waitFor(".presentation .present-slide");
  await app.keys(["ArrowRight"]);
  await app.keys(["ArrowRight"]);
  await app.browser.performActions([{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: 5, y: 5 }] }]).catch(() => {});
  await sleep(3500);
  await shot("presentation");
  await app.keys(["Escape"]);
  await sleep(600);
}

async function activity() {
  await setTheme("light");
  await closeTabs();
  await panel(true);
  await app.click('.ribbon [aria-label^="Timeline"]');
  await app.waitFor(".activity-item");
  await clickText(".pane.active > .pane-content:not([hidden]) button", "Yesterday");
  await sleep(800);
  await settle();
  await shot("activity-feed");
  await panel(false);
}

async function review() {
  await setTheme("dark");
  await closeTabs();
  await panel(false);
  await app.click(".ribbon .ribbon-review");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .rv-view .rv-stats");
  await app.browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .rv-view")?.focus());
  await app.keys(["ArrowLeft"]);
  await app.waitText(".rv-date", /Yesterday|Wednesday/);
  await sleep(800);
  await settle();
  await shot("day-review-dark");
}

async function dashboard() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await app.keys(["Control", "t"]);
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .dash-grid .dw");
  await app.browser.waitUntil(async () => (await app.$$(".pane.active > .pane-content:not([hidden]) .dw-skel")).length === 0, { timeout: 15000 });
  await sleep(1200);
  await settle();
  await app.browser.execute(() => document.querySelector(".home")?.scrollTo(0, 0));
  await shot("dashboard");
}

async function timeSuggest() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  const page = await app.invoke("page_resolve", { title: "Weekly sync 22.09.", create: false });
  const original = (await app.invoke("page_get", { id: page.id })).content;
  await openTree("Weekly sync 22.09.");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/time NP-88");
  await app.browser.waitUntil(async () => app.browser.execute(() => [...document.querySelectorAll(".sugg-host .sugg-item")].some((e) => e.offsetParent)), { timeout: 8000 });
  await calm();
  await sleep(500);
  await shot("time-suggest");
  await app.keys(["Escape"]);
  for (let i = 0; i < 11; i++) await app.keys(["Backspace"]);
  // Smart /time: a line without a reference asks the AI.
  await app.type("/time 1h Mapping workshop");
  await app.keys(["Escape"]);
  await app.keys(["Enter"]);
  await app.waitFor(".zeit-confirm .zeit-confirm-target", 15000);
  await sleep(500);
  await shot("smart-time-confirm");
  await app.keys(["Escape"]);
  await sleep(300);
  await app.invoke("page_save", { id: page.id, content: original });
  await closeTabs();
}

async function workCard() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("Integration test plan");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .work-card");
  await settle();
  await shot("page-work-card");
}

async function timesheet() {
  await setTheme("dark");
  await closeTabs();
  await panel(false);
  await app.click('.ribbon [aria-label="Time tracking"]');
  await app.waitFor(".week-grid");
  await settle();
  await shot("timesheet-dark");
  await app.click('.ribbon [aria-label="Projects"]');
  await app.waitFor(".vorgaenge");
  await settle();
  await shot("projects-dark");
}

async function cite() {
  await setTheme("light");
  await closeTabs();
  await openTree("Weekly sync 22.09.");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await panel(true);
  await app.keys(["Control", "j"]);
  const ta = await app.waitFor(".composer textarea");
  await ta.setValue("Delta load integration test");
  await app.keys(["Enter"]);
  await app.waitFor(".msg-ai .msg-meta", 15000);
  const chip = await app.waitFor('.msg-ai .prose sup.cite[data-cite="1"]');
  await app.browser.execute(() => document.activeElement?.blur());
  await chip.moveTo();
  await app.waitFor(".cite-card");
  await sleep(500);
  await shot("cite-preview");
  await calm();
}

async function history() {
  await setTheme("dark");
  await closeTabs();
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await panel(true);
  await app.browser.execute(() => document.querySelector(".assistant-head .chat-history-btn, .assistant-head button[aria-label='History']")?.click());
  if (!(await app.$(".chat-history").isExisting())) await app.click('.assistant-head button[aria-label="History"]');
  await app.waitFor(".chat-history-search input");
  await sleep(500);
  await settle();
  await shot("assistant-history-dark");
  await app.keys(["Escape"]);
  await panel(false);
}

async function inlineAi() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await selectText("The middleware connects the ERP to the order portal through IDocs.");
  await app.keys(["Control", "j"]);
  await app.waitFor(".ai-bar");
  await clickText(".ai-chip", "/^(Improve|Shorten)/");
  await app.waitFor(".ai-bar-preview .prose");
  await app.waitText(".ai-bar-actions .btn", /Replace/);
  await sleep(500);
  await calm();
  await sleep(300);
  await shot("inline-ai-preview");
  await app.keys(["Escape"]);
  await sleep(300);
  await app.keys(["Escape"]);
}

async function summary() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("Weekly sync 22.09.");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await app.click('.pane.active > .pane-content:not([hidden]) [aria-label="More actions"]');
  await clickText(".menu-item", "/Summarize the meeting/");
  await app.waitText(".summary-preview h2", /Decisions/, 15000);
  await sleep(600);
  await settle();
  await shot("meeting-summary");
  await app.keys(["Escape"]);
  await dialogGone();
}

async function calendar() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await sidebar(false);
  await app.click(".ribbon .ribbon-calendar-view");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .calv-head");
  await clickText(".pane.active > .pane-content:not([hidden]) .calv-views button", "Work week");
  await sleep(700);
  await app.browser.execute(() => {
    const s = document.querySelector(".pane.active > .pane-content:not([hidden]) .calv-scroll, .pane.active > .pane-content:not([hidden]) .calv-body, .pane.active > .pane-content:not([hidden]) .calv-grid");
    const row = [...document.querySelectorAll(".pane.active > .pane-content:not([hidden]) .calv-hour, .pane.active > .pane-content:not([hidden]) .calv-time")].find((e) => e.innerText.trim() === "08:00");
    if (s && row) s.scrollTop = row.offsetTop - 8;
  });
  await settle();
  await shot("calendar-week");
  // The meeting with its join link from the description.
  await app.browser.execute(() => [...document.querySelectorAll(".calv-ev")].find((b) => b.querySelector(".calv-ev-title")?.textContent === "Weekly sync changes")?.click());
  await app.waitFor(".calv-detail, .calv-detail-row");
  await sleep(500);
  await calm();
  await sleep(300);
  await shot("calendar-meeting");
  await app.keys(["Escape"]);
  await sidebar(true);
}

async function outlookSettings() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openSettings("calendar");
  await app.waitFor(".olcal-row");
  await app.browser.execute(() => document.querySelector(".olcal-row")?.scrollIntoView({ block: "center" }));
  await sleep(600);
  await settle();
  await shot("outlook-calendars");
  await closeTabs();
}

async function weekProposal() {
  await setTheme("dark");
  await closeTabs();
  await panel(false);
  await app.click('.ribbon [aria-label="Time tracking"]');
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .wp-open");
  await app.click(".pane.active > .pane-content:not([hidden]) .wp-open");
  await app.waitFor(".dialog .wp-days");
  await sleep(600);
  const mark = () =>
    app.browser.execute(() => {
      const r = [...document.querySelectorAll(".wp-row")].find((x) => x.querySelector(".wp-text .input")?.value === "Architecture round");
      const boxes = r ? [...r.querySelectorAll('.wp-wbs [role="combobox"]')] : [];
      if (boxes.length < 2) return false;
      boxes[0].dataset.e2e = "wp-net";
      boxes[1].dataset.e2e = "wp-act";
      return true;
    });
  if (await mark()) {
    await app.select('[data-e2e="wp-net"]', String(ids.np8801));
    await mark();
    await app.select('[data-e2e="wp-act"]', "1030");
  }
  await settle();
  await app.browser.execute(() => document.querySelector(".dialog .wp-days")?.scrollTo?.(0, 0));
  await shot("week-proposal-dark");
  await app.keys(["Escape"]);
  await dialogGone();
}

async function mail() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("Integration test plan");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror");
  await palette("current e-mail", /Take over current e-mail/);
  await app.waitFor(".dialog .mailx-card");
  await sleep(400);
  for (const b of await app.$$(".mailx-chip"))
    if ((await app.textOf(b)) === "Next week") {
      await b.click();
      break;
    }
  await app.browser.execute(() => {
    const box = [...document.querySelectorAll(".mailx-files input[type=checkbox]")][0];
    if (box && !box.checked) box.click();
  });
  await settle();
  await shot("mail-to-task");
  await app.keys(["Escape"]);
  await dialogGone();
}

async function linkGroup() {
  await setTheme("dark");
  await closeTabs();
  await panel(false);
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await placeCursor();
  await settle();
  await app.click(".ribbon .quick-group");
  await app.waitFor(".link-pop");
  await sleep(400);
  await shot("link-group-dark");
  await app.keys(["Escape"]);
  await sleep(300);
}

async function bookmarks() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openTree("Order portal concept");
  await app.click(".ribbon .quick-link-add");
  await app.waitFor(".dialog .link-import-bookmarks");
  await app.click(".dialog .link-import-bookmarks");
  await app.waitFor(".bm-source");
  await app.browser.execute(() => [...document.querySelectorAll(".bm-source")].find((s) => s.querySelector(".bm-source-profile").textContent.startsWith("Work")).click());
  await app.waitFor(".bm-tree .bm-row");
  await app.click(".dialog .bm-next");
  await app.waitFor(".bm-unit");
  await sleep(400);
  await settle();
  await shot("bookmark-import");
  await app.keys(["Escape"]);
  await dialogGone().catch(async () => {
    await app.keys(["Escape"]);
    await dialogGone();
  });
}

async function tasks() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await app.click('.ribbon [aria-label^="Tasks"]');
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .task-row, .pane.active > .pane-content:not([hidden]) .tasks");
  await sleep(500);
  await settle();
  await shot("tasks-view");
}

async function dailyCalendar() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await app.browser.execute(() => document.activeElement?.blur?.());
  await app.keys(["Control", "Shift", "c"]);
  await app.waitFor(".calendar");
  await sleep(500);
  await settle();
  await shot("daily-calendar");
  await app.keys(["Escape"]);
  await app.browser.refresh();
  await ready();
}

async function search() {
  await setTheme("light");
  await closeTabs();
  const url = await app.browser.getUrl();
  await app.browser.url(url.replace(/#.*$/, "") + "#search");
  await app.browser.refresh();
  await ready();
  await app.waitFor(".search-app input, input.pal-input, .pal-input input");
  await app.type("IDoc");
  await app.waitFor(".pal-snippet mark");
  await sleep(500);
  await shotOf(".qs-panel", "quick-search");
  await app.browser.url(url.replace(/#.*$/, ""));
  await ready();
}

async function themes() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  await openSettings("appearance");
  await app.waitFor(".theme-card");
  await settle();
  await shot("theme-picker");
  await closeTabs();
  const s = await settings();
  await save((x) => ({ theme: "dark", appearance: { ...x.appearance, theme_dark: "tokyo-night" } }));
  await app.browser.refresh();
  await ready();
  await openTree("Architecture");
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .ProseMirror h2");
  await app.click(".pane.active > .pane-content:not([hidden]) .ProseMirror > p");
  await settle();
  await shot("theme-tokyo-night");
  await save(() => ({ theme: s.theme, appearance: s.appearance }));
  await app.browser.refresh();
  await ready();
}

async function backdrop() {
  await setTheme("dark");
  await closeTabs();
  await panel(false);
  await save((s) => ({ appearance: { ...s.appearance, window_effect: "acrylic", window_opacity: 75 } }));
  await app.browser.refresh();
  await ready();
  await openSettings("appearance");
  await app.browser.execute(() => document.querySelector('.settings input[type="range"]')?.closest(".set-row, .set-group, section")?.scrollIntoView({ block: "center" }));
  await sleep(700);
  await settle();
  await shot("settings-backdrop-dark");
  await save((s) => ({ appearance: { ...s.appearance, window_effect: "none", window_opacity: 80 } }));
  await app.browser.refresh();
  await ready();
}

async function network() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  const before = (await settings()).network;
  await save((s) => ({ network: { ...s.network, mode: "manual", http_proxy: "proxy.example.com:8080", https_proxy: "proxy.example.com:8080", no_proxy: "<local>, *.example.com, 10.0.0.0/8", proxy_user: "mkleindienst" } }));
  await openSettings("network");
  await sleep(600);
  await settle();
  await shot("settings-network");
  await closeTabs();
  await save(() => ({ network: before }));
}

async function gitSync() {
  await setTheme("light");
  await closeTabs();
  await panel(false);
  const before = (await settings()).git_sync;
  await save((s) => ({ git_sync: { ...s.git_sync, enabled: true, remote_url: "https://github.com/example/arcalo-notes.git", branch: "main", author_name: "Maurice Kleindienst", author_email: "maurice@example.com" } }));
  await openSettings("backup");
  await sleep(500);
  await scrollToGroup("Git sync");
  await sleep(500);
  await settle();
  await shot("settings-git-sync");
  await closeTabs();
  await save(() => ({ git_sync: before }));
}

async function capture() {
  await setTheme("light");
  const w = await openCapture(app);
  await app.browser.refresh();
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 10000 });
  await app.type(">order");
  await app.waitText(".capture-picker .sugg-item.sel", /Order portal concept/);
  await sleep(400);
  await shot("capture-picker");
  await app.keys(["Enter"]);
  await app.type("Questions from the review");
  await app.keys(["Shift", "Enter"]);
  await app.keys(["Shift"]);
  await app.type("todo Add the mapping for partial deliveries by Fri");
  await sleep(600);
  await shot("capture-task");
  await app.browser.execute(() => {
    const el = document.querySelector(".capture-input");
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await app.keys(["Escape"]);
  await w.toMain();
}

const SCENES = {
  split,
  note,
  preview,
  table: tableToolbar,
  versions,
  board,
  blocks,
  present,
  activity,
  review,
  dashboard,
  time: timeSuggest,
  workcard: workCard,
  timesheet,
  cite,
  history,
  inline: inlineAi,
  summary,
  calendar,
  outlook: outlookSettings,
  week: weekProposal,
  mail,
  links: linkGroup,
  bookmarks,
  tasks,
  daily: dailyCalendar,
  themes,
  backdrop,
  network,
  git: gitSync,
  search,
  capture,
};

// ---------------------------------------------------------------- run

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-readme16-"));
  llm = await startFakeAI();
  const outlook = path.join(tmp, "outlook.json");
  fs.writeFileSync(outlook, outlookFixture());
  const mailFile = path.join(tmp, "outlook-mail.json");
  fs.writeFileSync(mailFile, JSON.stringify(MAIL));
  const home = path.join(tmp, "home");
  bookmarkProfiles(home);
  const env = {
    ARCALO_LOCALE: "en-US",
    GDK_SCALE: SCALE,
    ARCALO_TEST_FIXTURES: "1",
    ARCALO_OUTLOOK_FIXTURE: outlook,
    ARCALO_OUTLOOK_MAIL_FIXTURE: mailFile,
    ARCALO_CALENDAR_DELAY_SECS: "3600",
    ARCALO_TEST_HOME: home,
    ARCALO_TEST_BACKDROP: "1",
  };
  // The workspace is set to English before the demo is seeded (as on a first start in English).
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir);
  let first = await launch({ demo: false, dataDir, env });
  const view = await first.invoke("settings_get");
  await first.invoke("settings_save", { settings: { ...view.settings, locale: { ...view.settings.locale, language: "en" } } });
  await first.close();
  app = await launch({ demo: true, dataDir, env });
  await seed();
});
after(async () => {
  await app?.close();
  await llm?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("1.6 README screenshots", async () => {
  const failed = [];
  for (const [name, scene] of Object.entries(SCENES)) {
    if (!want(name)) continue;
    try {
      await scene();
    } catch (e) {
      failed.push(`${name}: ${String(e).split("\n")[0]}`);
      await app.shot(`FAIL-${name}`).catch(() => {});
      await app.keys(["Escape"]).catch(() => {});
      await app.browser.refresh().catch(() => {});
      await ready().catch(() => {});
    }
  }
  if (failed.length) throw new Error(failed.join("\n"));
});

// The intro and the setup on a fresh workspace, in English.
test("first run", { skip: !want("firstrun") }, async () => {
  await app.close();
  app = null;
  const fresh = await launch({ demo: false, onboarding: true, env: { ARCALO_LOCALE: "en-US", GDK_SCALE: SCALE } });
  app = fresh;
  await app.waitFor(".fr-intro");
  // The scene about time tracking, most of its motion done.
  await app.click(".fr-seg:nth-child(3)");
  await sleep(3300);
  await shot("first-run-intro");
  await app.click(".fr-setup");
  await app.waitFor(".fr-intake");
  const s = await settings();
  await app.invoke("settings_save", { settings: { ...s, theme: "dark" } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === "dark");
  await app.click('.fr-rail-item[data-step="work"]');
  await app.waitFor(".fr-step-work");
  await sleep(600);
  await settle();
  await shot("first-run-setup-dark");
});
