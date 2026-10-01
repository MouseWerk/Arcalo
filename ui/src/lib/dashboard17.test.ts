// The start page of 1.7: registered widgets, the new sizes, the templates „Sprint“ and
// „Persönlich“, the move of a 1.6 layout, and the checks of a board file on import.

import { describe, expect, it } from "vitest";
import {
  allKinds,
  boardFileName,
  DASHBOARD_VERSION,
  exportBoard,
  galleryKinds,
  importBoard,
  isKind,
  loadDashboard,
  partsOf,
  presetWidgets,
  publicConfig,
  registerWidgetDef,
  resizeToPreset,
  shownWidgets,
  sizeName,
  toSaved,
  withHidden,
  type WidgetDef,
} from "./dashboard";
import { COLS, overlaps } from "./dashgrid";
import type { Board, Dashboard, GridWidget } from "./types";

const noOverlaps = (ws: GridWidget[]) => {
  for (const a of ws) for (const b of ws) if (a !== b) expect(overlaps(a, b), `${a.id}/${b.id}`).toBe(false);
};

const def = (extra: Partial<WidgetDef> = {}): WidgetDef => ({ label: "dash.w.note", hint: "dash.w.noteHint", group: "pages", size: { w: 4, h: 7 }, min: { w: 2, h: 3 }, config: () => ({}), ...extra });

// The widgets of components/dashboard/widgets, as they register (their defs only).
for (const k of ["scratchpad", "inbox", "resurface", "synced", "writing", "pomodoro", "checklist", "status"]) registerWidgetDef(k, def());
registerWidgetDef("jira-test", def({ secrets: ["account"], config: () => ({ project: "", account: "" }), parts: (c) => [{ kind: "recent", limit: Number(c.limit) || 3 }] }));
registerWidgetDef("timed-test", def({ time: true }));

describe("registered widgets", () => {
  it("join the catalogue, the gallery and the data parts", () => {
    expect(isKind("scratchpad") && isKind("jira-test")).toBe(true);
    expect(isKind("toString")).toBe(false);
    expect(allKinds()).toEqual(expect.arrayContaining(["today", "scratchpad", "status"]));
    expect(galleryKinds(true)).toContain("jira-test");
    // A registered time widget is hidden and not offered while time tracking is off.
    expect(galleryKinds(false)).not.toContain("timed-test");
    expect(partsOf({ kind: "jira-test", config: { limit: 5 } }, new Date())).toEqual([{ kind: "recent", limit: 5 }]);
    expect(() => registerWidgetDef("Bad Kind", def())).toThrow();
  });

  it("widgets of unknown kinds stay on the board, hidden, and come back after an edit", () => {
    const all: GridWidget[] = [
      { id: "a", kind: "clock", x: 0, y: 0, w: 4, h: 4 },
      { id: "z", kind: "from-the-future", x: 4, y: 0, w: 4, h: 4, config: { x: 1 } },
      { id: "b", kind: "tasks", x: 8, y: 0, w: 4, h: 4 },
    ];
    const shown = shownWidgets(all, true);
    expect(shown.map((w) => w.id)).toEqual(["a", "b"]);
    const back = withHidden(all, shown, true);
    expect(back.map((w) => w.id).sort()).toEqual(["a", "b", "z"]);
    expect(back.find((w) => w.id === "z")?.config).toEqual({ x: 1 });
    noOverlaps(back);
  });
});

describe("sizes", () => {
  const board: GridWidget[] = [
    { id: "a", kind: "clock", x: 0, y: 0, w: 4, h: 7 },
    { id: "b", kind: "recent", x: 4, y: 0, w: 4, h: 7 },
    { id: "c", kind: "favorites", x: 8, y: 0, w: 4, h: 7 },
    { id: "d", kind: "note", x: 0, y: 7, w: 12, h: 6 },
  ];

  it("wide, tall and both reflow the others without overlaps", () => {
    for (const name of ["s", "m", "w", "t", "wt"] as const) {
      const next = resizeToPreset(board, "b", name);
      noOverlaps(next);
      expect(sizeName(next.find((w) => w.id === "b")!)).toBe(name);
      for (const w of next) expect(w.x + w.w).toBeLessThanOrEqual(COLS);
    }
    // Wide at the right edge moves left instead of being cut.
    const wide = resizeToPreset(board, "c", "w").find((w) => w.id === "c")!;
    expect([wide.x, wide.w]).toEqual([4, 8]);
    // Tall pushes what is below further down.
    const tall = resizeToPreset(board, "a", "t");
    expect(tall.find((w) => w.id === "d")!.y).toBe(14);
    expect(resizeToPreset(board, "nope", "w")).toBe(board);
  });
});

describe("templates", () => {
  it("„Sprint“ and „Persönlich“ fill a board without overlaps or time widgets", () => {
    for (const name of ["sprint", "personal"] as const) {
      for (const time of [true, false]) {
        const ws = presetWidgets(name, [], time);
        expect(ws.length).toBeGreaterThan(3);
        noOverlaps(ws);
        expect(ws.some((w) => ["week", "budget", "timer", "proposal"].includes(w.kind))).toBe(false);
      }
    }
    expect(presetWidgets("personal").map((w) => w.kind)).toEqual(expect.arrayContaining(["scratchpad", "inbox", "resurface", "writing", "checklist"]));
    expect(presetWidgets("sprint").map((w) => w.kind)).toEqual(expect.arrayContaining(["tasks", "pomodoro", "synced"]));
  });
});

describe("a 1.6 layout", () => {
  // As 1.6 saved it: two boards, a note's text, the second board active, a time widget.
  const v16: Dashboard = {
    version: 2,
    active: "projekte",
    notes: { note: "Einkaufen\n- [ ] Milch", "note-2": "Zweite Notiz" },
    boards: [
      {
        id: "heute",
        name: "Heute",
        widgets: [
          { id: "today", kind: "today", x: 0, y: 0, w: 8, h: 13, config: { blocks: { timeline: true, hours: false } } },
          { id: "agenda", kind: "agenda", x: 8, y: 0, w: 4, h: 13, title: "Meine Termine", config: { days: 2, sources: [] } },
          { id: "week", kind: "week", x: 0, y: 13, w: 6, h: 7, config: { mode: "wbs" } },
          { id: "note", kind: "note", x: 6, y: 13, w: 6, h: 7, config: { mode: "text", page: null } },
        ],
      },
      { id: "projekte", name: "Projekte", widgets: [{ id: "note-2", kind: "note", x: 0, y: 0, w: 4, h: 6 }, { id: "clock", kind: "clock", x: 4, y: 0, w: 3, h: 5, config: { seconds: true } }] },
    ],
  };

  it("opens with every board, widget, setting and note, on the board used last", () => {
    const d = loadDashboard(structuredClone(v16));
    expect(d.version).toBe(DASHBOARD_VERSION);
    expect(d.active).toBe("projekte");
    expect(d.boards).toEqual(v16.boards);
    expect(d.notes).toEqual(v16.notes);
    // Saved again: the same boards under the new version, nothing dropped.
    const saved = toSaved(d);
    expect({ ...saved, version: 2 }).toEqual({ ...v16 });
    expect(saved.version).toBe(3);
  });

  it("keeps the time widgets while time tracking is off", () => {
    const d = loadDashboard(structuredClone(v16), false);
    expect(shownWidgets(d.boards[0].widgets, false).map((w) => w.kind)).not.toContain("week");
    expect(toSaved(d).boards[0].widgets.map((w) => w.id)).toContain("week");
  });

  it("an older single list becomes the first board", () => {
    const d = loadDashboard({ version: 0, boards: [], active: "", notes: {}, widgets: [{ id: "a", kind: "today", size: "l" }, { id: "n", kind: "note", size: "m" }], note: "Merken" });
    expect(d.boards).toHaveLength(1);
    expect(d.boards[0].widgets.map((w) => w.kind)).toEqual(["today", "note"]);
    expect(Object.values(d.notes)).toEqual(["Merken"]);
  });
});

describe("board files", () => {
  const board: Board = {
    id: "arbeit",
    name: "Arbeit & Büro",
    widgets: [
      { id: "jira-test", kind: "jira-test", x: 0, y: 0, w: 4, h: 7, config: { project: "ABC", account: "cred:jira/me", apiToken: "xyz", nested: { password: "p", keep: 1 } } },
      { id: "note", kind: "note", x: 4, y: 0, w: 4, h: 7, config: { mode: "text" } },
    ],
  };

  it("leave out credentials and name the file neutrally", () => {
    const text = exportBoard(board, { note: "Text", other: "nicht dabei" }, new Date(2026, 9, 1));
    expect(text).not.toMatch(/xyz|cred:jira|"p"/);
    const file = JSON.parse(text);
    expect(file).toMatchObject({ format: "annalo-dashboard", version: 2, app: "annalo", notes: { note: "Text" } });
    expect(file.board.widgets[0].config).toEqual({ project: "ABC", nested: { keep: 1 } });
    expect(boardFileName(board, new Date(2026, 9, 1))).toBe("annalo-arbeit-buro-2026-10-01.dashboard.json");
    expect(publicConfig("note", { mode: "text", sessionId: "s" })).toEqual({ mode: "text" });
  });

  it("are checked on import: version, size, kinds, settings and secrets", () => {
    const boards: Board[] = [{ id: "heute", name: "Heute", widgets: [{ id: "note", kind: "note", x: 0, y: 0, w: 4, h: 6 }] }];
    const file = (widgets: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ format: "annalo-dashboard", version: 2, board: { name: "  Import  ", widgets }, notes: { note: "Hallo", x: 5 }, ...extra });
    expect(importBoard(file([], { version: 9 }), boards)).toEqual({ error: "dash.import.newer" });
    expect(importBoard(file(Array.from({ length: 41 }, () => ({ kind: "clock" }))), boards)).toEqual({ error: "dash.import.tooMany" });
    expect(importBoard(JSON.stringify({ format: "annalo-dashboard", board: { widgets: "x" } }), boards)).toEqual({ error: "dash.import.wrongFormat" });
    const r = importBoard(
      file([
        { id: "note", kind: "note", x: 0, y: 0, w: 4, h: 6, title: "  Notiz  " },
        { id: "w1", kind: "wetter", x: 4, y: 0, w: 4, h: 4 },
        { id: "w2", kind: "wetter" },
        { id: "j", kind: "jira-test", x: "a", y: null, config: { project: "X", account: "cred", token: "t" } },
        { id: "big", kind: "clock", config: { blob: "x".repeat(20_000) } },
        null,
      ]),
      boards,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.dropped).toEqual(["wetter"]);
    expect(r.board.name).toBe("Import");
    expect(r.board.widgets.map((w) => w.kind)).toEqual(["note", "jira-test", "clock"]);
    // New ids where they are taken; the note follows its widget.
    const note = r.board.widgets[0];
    expect(note.id).toBe("note-2");
    expect(note.title).toBe("Notiz");
    expect(r.notes).toEqual({ "note-2": "Hallo" });
    expect(r.board.widgets[1].config).toEqual({ project: "X" });
    // Settings too large for a widget fall back to its defaults.
    expect(r.board.widgets[2].config).toEqual({ seconds: false, week: true });
    noOverlaps(r.board.widgets);
  });
});
