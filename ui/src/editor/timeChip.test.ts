import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { chipMarkdown, chipStatuses, chipsIn, hoursAttr, staleAttrs } from "./timeChip";
import { timerSeconds } from "../components/Sidebar";
import type { TimeEntryRow, TimerStatus } from "../lib/types";

const row = (over: Partial<TimeEntryRow> = {}) =>
  ({
    id: 7,
    netzplan_id: 1,
    netzplan_nr: "NP-8801",
    vorgang_nr: "1020",
    leistungsart: "DEV",
    start_time: "2026-10-02T08:00:00Z",
    end_time: null,
    duration_minutes: 90,
    description: "Review",
    status_flag: "draft",
    source: "slash",
    page_id: 1,
    project_code: "P",
    wbs_element: "W",
    ...over,
  }) as TimeEntryRow;

const md = (attrs: string, text = "Review") => `Heute <time-entry ${attrs}>${text}</time-entry>\n`;
const editorFor = (content: string) => new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content, contentType: "markdown" });

describe("time chips", () => {
  it("writes the Markdown like the backend and keeps older chips byte for byte", () => {
    const old = md('id="12" hours="2,50" target="NP-8801/1020"', "Systemintegration");
    expect(toMarkdown(editorFor(old))).toBe(old);
    const full = md('id="7" hours="1,50" target="NP-8801/1020" la="DEV" date="2026-10-02" state="deleted"', "A &amp; B");
    expect(toMarkdown(editorFor(full))).toBe(full);
    expect(chipMarkdown({ entryId: 3, hours: "0,50", target: 'A"B', text: "<x>", la: "", date: "", state: "" })).toBe('<time-entry id="3" hours="0,50" target="A&quot;B">&lt;x&gt;</time-entry>');
  });

  it("survives copy and paste (HTML) with every value", () => {
    const editor = editorFor(md('id="7" hours="1,50" target="NP-8801/1020" la="DEV" date="2026-10-02"'));
    const html = editor.getHTML();
    const again = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: html });
    const [chip] = chipsIn(again.state.doc);
    expect(chip.id).toBe(7);
    expect(chip.node.attrs).toMatchObject({ hours: "1,50", target: "NP-8801/1020", la: "DEV", date: "2026-10-02", text: "Review", state: "" });
  });

  it("shows the first chip of a booking as booked, later ones and other notes' chips as copies", () => {
    const links = new Map([
      [7, "linked" as const],
      [8, "elsewhere" as const],
      [9, "missing" as const],
    ]);
    const chips = [{ id: 7 }, { id: 7 }, { id: 8 }, { id: 9 }, { id: 7, state: "deleted" }, { id: null }, { id: 10 }];
    expect(chipStatuses(chips, links)).toEqual(["linked", "copy", "copy", "missing", "deleted", "missing", "unknown"]);
    // A deleted chip does not count: a newer chip with the reused id is the booked one.
    expect(chipStatuses([{ id: 7, state: "deleted" }, { id: 7 }], links)).toEqual(["deleted", "linked"]);
  });

  it("finds what changed in the booking", () => {
    const attrs = { hours: "1,50", target: "NP-8801/1020", la: "DEV", date: "2026-10-02", text: "Review" };
    expect(staleAttrs(attrs, row())).toBeNull();
    expect(staleAttrs(attrs, row({ duration_minutes: 135, vorgang_nr: "1030", leistungsart: null, description: "Plan" }))).toEqual({ hours: "2,25", target: "NP-8801/1030", la: "", text: "Plan" });
    // Older chips get Leistungsart and day.
    expect(staleAttrs({ hours: "1.50", target: "NP-8801/1020", text: "Review" }, row())).toEqual({ la: "DEV", date: "2026-10-02" });
    expect(hoursAttr(20, "1,00")).toBe("0,33");
    expect(hoursAttr(90, "2.5")).toBe("1.50");
  });
});

describe("timer seconds", () => {
  const status = (over: Partial<TimerStatus>) => ({ entry: { start_time: "2026-10-02T08:00:00Z" }, idle_minutes: 0, is_idle: false, ...over }) as TimerStatus;
  const at = (hhmm: string) => new Date(`2026-10-02T${hhmm}:00Z`).getTime();
  it("leaves out the pauses and stands still while paused", () => {
    expect(timerSeconds(status({}), at("09:00"))).toBe(3600);
    expect(timerSeconds(status({ paused_seconds: 600 }), at("09:00"))).toBe(3000);
    expect(timerSeconds(status({ paused_seconds: 600, paused_since: "2026-10-02T08:30:00Z" }), at("12:00"))).toBe(1200);
  });
});
