import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "../store/app";
import type { AiProvider, Settings, SettingsView } from "./types";
import { AI_COMMANDS, AI_SHORTCUTS, AI_TABS, aiEnabled, aiOn, aiSwitchOn, useAi, withAi } from "./aiswitch";
import { COMMANDS } from "./keymap";
import { AI_WIDGETS, galleryKinds, shownWidgets, widgetShown } from "./dashboard";
import { usableProvider } from "./providers";
import { AI_SLASH, slashItems } from "../editor/extensions";
import type { GridWidget } from "./types";

const ollama: AiProvider = { id: "ollama", name: "", kind: "ollama", base_url: "http://localhost:11434", local: true, enabled: true, bypass_proxy: true, api_version: "", models: [] };
const view = (enabled: boolean | undefined, policy = false): SettingsView =>
  ({ settings: { ai: { enabled }, providers: [ollama] }, provider_keys: [], ai_policy_off: policy }) as unknown as SettingsView;

describe("„KI verwenden“", () => {
  it("is on unless switched off or a policy forbids it; unknown settings show no AI", () => {
    expect(aiSwitchOn({} as Settings)).toBe(true);
    expect(aiSwitchOn({ ai: {} } as Settings)).toBe(true);
    expect(aiSwitchOn({ ai: { enabled: false } } as Settings)).toBe(false);
    expect(aiOn(view(undefined))).toBe(true);
    expect(aiOn(view(true))).toBe(true);
    expect(aiOn(view(false))).toBe(false);
    expect(aiOn(view(true, true))).toBe(false);
    // Before the settings are loaded nothing about AI flashes up.
    expect(aiOn(null)).toBe(false);
  });

  it("only flips the switch: providers and models stay for when it is back on", () => {
    const s = { ai: { enabled: true, temperature: 0.3 }, providers: [ollama], embedding_model: "nomic" } as unknown as Settings;
    const off = withAi(s, false);
    expect(off.ai).toEqual({ enabled: false, temperature: 0.3 });
    expect(off.providers).toBe(s.providers);
    expect(withAi(off, true)).toEqual({ ...s, ai: { enabled: true, temperature: 0.3 } });
  });

  it("makes no provider usable while off", () => {
    expect(usableProvider(view(true))).toBe(true);
    expect(usableProvider(view(false))).toBe(false);
    expect(usableProvider(view(true, true))).toBe(false);
  });

  it("follows the store, also for the hook, and re-renders when it changes", async () => {
    useApp.setState({ settings: view(false) });
    expect(aiEnabled()).toBe(false);
    const seen: boolean[] = [];
    const Probe = () => {
      seen.push(useAi());
      return null;
    };
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => useApp.setState({ settings: view(true) }));
    expect(seen.at(0)).toBe(false);
    expect(seen.at(-1)).toBe(true);
    await act(async () => root.unmount());
  });

  it("names what it hides: the chat tab, the AI commands and shortcuts", () => {
    expect([...AI_TABS]).toEqual(["chat"]);
    expect(AI_COMMANDS).toEqual(expect.arrayContaining(["ask", "assistant", "chat-open", "chat-new", "weekly-report", "index"]));
    expect([...AI_SHORTCUTS].every((id) => COMMANDS.some((c) => c.id === id))).toBe(true);
  });

  it("drops inline AI and the meeting summary from the slash menu", () => {
    const on = () => {};
    const opts = { onTemplate: on, onImage: on, onAi: on, onSummary: on, onDrawing: on, onFile: on };
    const ids = (ai: boolean) => slashItems(opts, true, ai).map((i) => i.id);
    expect(ids(true)).toEqual(expect.arrayContaining([...AI_SLASH]));
    expect(ids(false).some((id) => AI_SLASH.has(id))).toBe(false);
    // Everything else stays.
    expect(ids(false).length).toBe(ids(true).length - AI_SLASH.size);
  });

  it("hides the AI widgets on the start page and in the gallery, keeping them on the board", () => {
    const w = (id: string, kind: string, y: number): GridWidget => ({ id, kind, x: 0, y, w: 6, h: 4, config: {} }) as GridWidget;
    const board = [w("a", "suggestions", 0), w("b", "tasks", 4)];
    expect(widgetShown("suggestions", true)).toBe(true);
    expect(widgetShown("suggestions", true, {}, false)).toBe(false);
    expect(shownWidgets(board, true, false).map((x) => x.kind)).toEqual(["tasks"]);
    expect(galleryKinds(true, false, false).some((k) => AI_WIDGETS.has(k))).toBe(false);
    expect(galleryKinds(true, false, true).some((k) => AI_WIDGETS.has(k))).toBe(true);
  });
});
