import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import { setLang } from "../lib/i18n";
import type { CalendarEvent, EntryFields } from "../lib/types";
import { EntryEditor, EntryFieldsEdit } from "./CalendarEntries";

vi.mock("../lib/api", async (orig) => {
  const m = await orig<typeof import("../lib/api")>();
  return { ...m, api: { ...m.api, calendarEntryCreate: vi.fn() } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);

/** Types `value` into an input as the user would (React sees an input event). */
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    el.focus();
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = async (el: HTMLElement, k: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

describe("the panels of an appointment: Enter takes what was just typed", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  beforeEach(() => {
    setLang("de");
    vi.mocked(api.calendarEntryCreate).mockReset();
    vi.mocked(api.calendarEntryCreate).mockImplementation(async (d) => ({ key: "outlook|x|", ...d }) as unknown as CalendarEvent);
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });
  const mount = (el: ReturnType<typeof createElement>) => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
  };
  /** „Neuer Termin“ with its draft kept by the parent, as in the Kalender. */
  function NewEntry() {
    const [draft, setDraft] = useState({ start: at(16, 10), end: at(16, 10, 30) });
    return createElement(EntryEditor, { draft, cal: undefined, onChange: setDraft, onClose: () => {}, onCreated: () => {} });
  }
  const field = (label: string) => host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const created = () => vi.mocked(api.calendarEntryCreate).mock.calls.map(([d]) => [new Date(d.start).getTime(), new Date(d.end).getTime()]);

  it("„Neuer Termin“: a start typed and Enter creates it at that time", async () => {
    mount(createElement(NewEntry));
    type(field("Titel"), "Telefonat");
    type(field("Beginn"), "14:00");
    await key(field("Beginn"), "Enter");
    expect(created()).toEqual([[at(16, 14).getTime(), at(16, 14, 30).getTime()]]);
  });

  it("„Neuer Termin“: an end or a date typed and Enter", async () => {
    mount(createElement(NewEntry));
    type(field("Ende"), "11:15");
    await key(field("Ende"), "Enter");
    expect(created()).toEqual([[at(16, 10).getTime(), at(16, 11, 15).getTime()]]);
    act(() => root!.unmount());
    vi.mocked(api.calendarEntryCreate).mockClear();
    mount(createElement(NewEntry));
    type(field("Datum"), "2026-10-19");
    await key(field("Datum"), "Enter");
    expect(created()).toEqual([[at(19, 10).getTime(), at(19, 10, 30).getTime()]]);
  });

  it("the panel of an appointment: Enter in a time saves it once", async () => {
    const onSave = vi.fn<(p: EntryFields) => void>();
    const e = { key: "outlook|G-O1|", start: at(16, 10).toISOString(), end: at(16, 11).toISOString(), all_day: false, location: "" } as CalendarEvent;
    mount(createElement(EntryFieldsEdit, { e, onSave }));
    type(field("Ende"), "12:00");
    await key(field("Ende"), "Enter");
    expect(onSave.mock.calls).toEqual([[{ start: at(16, 10).toISOString(), end: at(16, 12).toISOString() }]]);
    // Leaving the field afterwards saves nothing more.
    act(() => {
      field("Ende").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
