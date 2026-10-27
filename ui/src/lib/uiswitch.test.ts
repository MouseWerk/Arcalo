import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const display = vi.hoisted(() => ({ choice: "full" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ facts: null, choice: display.choice })) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DISPLAY_EVENT, followInterface } from "./uiswitch";
import { SourceEditor } from "../editor/SourceEditor";
import type { PageDoc } from "./types";

describe("following the window", () => {
  let replace: ReturnType<typeof vi.spyOn>;
  let off: (() => void) | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
  });
  afterEach(() => {
    off?.();
    off = null;
    replace.mockRestore();
    vi.useRealTimers();
  });

  it("does not go while text typed during the flush is unsaved; it flushes again first", async () => {
    const flush = vi.fn(async () => true);
    let typed = true;
    off = followInterface("phone", flush, () => typed);
    window.dispatchEvent(new Event(DISPLAY_EVENT));
    await vi.advanceTimersByTimeAsync(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    typed = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith("index.html");
  });

  it("stays when the flush failed", async () => {
    const flush = vi.fn(async () => false);
    off = followInterface("phone", flush, () => false);
    window.dispatchEvent(new Event(DISPLAY_EVENT));
    await vi.advanceTimersByTimeAsync(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("goes over while the Markdown source view has the focus (the flush stores its text)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const doc = { id: 7, title: "Notiz", content: "Text im Quelltext\n" } as unknown as PageDoc;
    await act(async () => root.render(createElement(SourceEditor, { doc, onSaved: () => {} })));
    host.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    display.choice = "phone";
    const flush = vi.fn(async () => true);
    off = followInterface("full", flush, () => false);
    window.dispatchEvent(new Event(DISPLAY_EVENT));
    await vi.advanceTimersByTimeAsync(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("mobile.html");
    display.choice = "full";
    await act(async () => root.unmount());
    host.remove();
  });
});
