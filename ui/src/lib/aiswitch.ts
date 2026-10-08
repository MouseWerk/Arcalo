// „KI verwenden“ (Settings → KI & Modelle, first in the setup as „Mit KI“ / „Ohne KI“): one switch
// for everything a language model does. Off, the assistant, the chat, inline AI, summaries, AI
// widgets and commands, „KI einrichten“ hints and search by meaning disappear, and the backend
// refuses every AI request; the provider settings stay and come back when it is switched on. An
// organization's policy (`AllowAi = 0`) can force it off. Components read it with `useAi()`,
// code outside React with `aiEnabled()`.

import { useApp } from "../store/app";
import type { Settings, SettingsView } from "./types";

/** Whether the stored switch is on (settings from before the switch count as on). */
export const aiSwitchOn = (s: Settings | null | undefined) => s?.ai?.enabled !== false;

/** Whether AI is in use: the switch and no policy against it. Unknown settings count as off, so
 * nothing about AI flashes up for someone who does not use it. */
export const aiOn = (view: Pick<SettingsView, "settings" | "ai_policy_off"> | null | undefined) => !!view && aiSwitchOn(view.settings) && !view.ai_policy_off;

/** The switch, live: re-renders when it changes. */
export const useAi = () => useApp((st) => aiOn(st.settings));

/** The switch now, for code outside React (editor extensions, shortcuts, event handlers). */
export const aiEnabled = () => aiOn(useApp.getState().settings);

/** Whether a policy decides it (the switch is shown locked off). */
export const useAiPolicyOff = () => useApp((st) => !!st.settings?.ai_policy_off);

/** Tabs that only exist with AI. */
export const AI_TABS = new Set(["chat"]);

/** Command palette entries that use a language model. */
export const AI_COMMANDS = ["ask", "assistant", "weekly-report", "chat-history", "chat-new", "chat-open", "chat-view-new", "index"];

/** Shortcuts (`keymap` ids) that do nothing while AI is off. */
export const AI_SHORTCUTS = new Set(["assistant", "chat_view"]);

/** The switch written into settings: only the flag changes, the providers stay as they are. */
export const withAi = (s: Settings, on: boolean): Settings => ({ ...s, ai: { ...s.ai, enabled: on } });
