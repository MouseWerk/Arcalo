import { describe, expect, it } from "vitest";
import { addItem, backupHealth, checkItems, clearDone, daySeed, firstLine, inboxDate, interactiveTasks, moveItem, removeItem, syncHealth, taskLines, toggleItem, toggleTask, writingBars } from "./dashnotes";

describe("scratchpad checkboxes", () => {
  const md = "# Liste\n- [ ] Milch\n```\n- [ ] kein Task\n```\n* [x] Brot\n1. [ ] Eier\ntext [ ] nicht";

  it("finds the task lines outside code and ticks the right one", () => {
    expect(taskLines(md)).toEqual([1, 5, 6]);
    expect(toggleTask(md, 0)).toContain("- [x] Milch");
    expect(toggleTask(md, 1)).toContain("* [ ] Brot");
    expect(toggleTask(md, 2, true)).toContain("1. [x] Eier");
    expect(toggleTask(md, 1, true)).toBe(md);
    expect(toggleTask(md, 9)).toBe(md);
  });

  it("numbers the rendered checkboxes and enables them", () => {
    const html = '<ul><li><input disabled="" type="checkbox"> a</li><li><input checked="" disabled="" type="checkbox"> b</li></ul>';
    expect(interactiveTasks(html)).toBe('<ul><li><input type="checkbox" class="dw-scratch-check" data-task="0"> a</li><li><input type="checkbox" class="dw-scratch-check" data-task="1" checked> b</li></ul>');
  });
});

describe("checklist", () => {
  it("keeps clean items and edits them", () => {
    const items = checkItems([{ id: "a", text: " Eins ", done: true }, { id: "a", text: "Zwei" }, { text: "" }, null, "x", { text: "Drei" }]);
    expect(items).toEqual([
      { id: "a", text: "Eins", done: true },
      { id: "ax", text: "Zwei", done: false },
      { id: "i3", text: "Drei", done: false },
    ]);
    expect(checkItems("nope")).toEqual([]);
    const added = addItem(items, "  Vier ", 0);
    expect(added.at(-1)).toMatchObject({ text: "Vier", done: false });
    expect(addItem(items, "   ")).toBe(items);
    expect(toggleItem(items, "ax")[1].done).toBe(true);
    expect(removeItem(items, "a").map((i) => i.id)).toEqual(["ax", "i3"]);
    expect(clearDone(items).map((i) => i.id)).toEqual(["ax", "i3"]);
    expect(moveItem(items, "i3", -1).map((i) => i.id)).toEqual(["a", "i3", "ax"]);
    expect(moveItem(items, "a", -1)).toBe(items);
  });
});

describe("inbox, writing and status", () => {
  it("reads inbox stamps and first lines", () => {
    expect(inboxDate("23.09.2026, 14:30")?.toISOString()).toBe(new Date(2026, 8, 23, 14, 30).toISOString());
    expect(inboxDate("gestern")).toBeNull();
    expect(firstLine("\n- [ ] **Anrufen** bei [[Kunde|Müller]]\nmehr")).toBe("Anrufen bei Müller");
    expect(firstLine("![Bild](a.png) Notiz")).toBe("Bild Notiz");
  });

  it("scales the writing bars to the busiest day", () => {
    const bars = writingBars([{ date: "2026-09-30", words: 50, created: 0 }, { date: "2026-10-01", words: 200, created: 1 }], "2026-10-01");
    expect(bars.map((b) => [b.fill, b.today])).toEqual([[0.25, false], [1, true]]);
    expect(writingBars([{ date: "x", words: 0, created: 0 }], "y")[0].fill).toBe(0);
  });

  it("keeps the random note for a day", () => {
    expect(daySeed(new Date(2026, 9, 1, 8))).toBe(daySeed(new Date(2026, 9, 1, 22)));
    expect(daySeed(new Date(2026, 9, 2))).not.toBe(daySeed(new Date(2026, 9, 1)));
  });

  it("rates backups and Git sync", () => {
    const now = new Date("2026-10-01T12:00:00Z").getTime();
    expect(backupHealth(null, [], now)).toBe("warn");
    expect(backupHealth("2026-10-01T08:00:00Z", [], now)).toBe("ok");
    expect(backupHealth("2026-09-20T08:00:00Z", [], now)).toBe("warn");
    expect(backupHealth("2026-10-01T08:00:00Z", [{ enabled: true, health: "failing" }], now)).toBe("error");
    expect(backupHealth("2026-10-01T08:00:00Z", [{ enabled: false, health: "failing" }], now)).toBe("ok");
    expect(syncHealth(null)).toBe("off");
    expect(syncHealth({ enabled: true, last_error: "boom", last_at: null })).toBe("error");
    expect(syncHealth({ enabled: true, last_error: null, last_at: "2026-10-01T08:00:00Z" })).toBe("ok");
  });
});
