// „Hilfe & Doku“: the "?" in the ribbon above the settings with the documentation, the shortcuts,
// the release notes and the two issue forms; the same actions are commands of the palette, links
// in Settings → Über, and F1 opens the documentation. The addresses live in lib/helpLinks.ts.

import { useRef, useState } from "react";
import { BookOpen, Bug, CircleHelp, Keyboard, MessageSquareText, ScrollText } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { currentLang, t, useT, type TKey } from "../lib/i18n";
import { docsUrl, issueUrl, type HelpTopic, type IssueKind } from "../lib/helpLinks";
import { openSettingsSection } from "../lib/calnav";
import { hint } from "../lib/keymap";
import { useApp } from "../store/app";
import { showReleaseNotes, useUpdates } from "./Updates";
import { IconButton, MENU_GAP, Menu, type MenuEntry } from "./ui";
import type { LucideIcon } from "lucide-react";

/** Opens a link in the browser; a failure shows the usual error toast. */
async function openExternal(url: string) {
  await openUrl(url).catch((e) => useApp.getState().error(t("links.openFailed"), e));
}

/** The documentation page of `topic` in the UI language. */
export function openDocs(topic: HelpTopic = "home") {
  return openExternal(docsUrl(topic, currentLang()));
}

/** The issue form of `kind`, with only the version and the system filled in. */
export async function openIssueForm(kind: IssueKind) {
  const info = await api.appInfo().catch(() => null);
  const version = useUpdates.getState().status?.current_version ?? info?.version ?? "";
  return openExternal(issueUrl(kind, { version, os: info?.os_name ?? "" }));
}

/** „Tastenkürzel“: Settings → Tastatur lists every command with its keys (and changes them). */
export const showShortcuts = () => openSettingsSection("keyboard");

/** „Versionshinweise“: the release notes of the installed version. */
export async function showVersionNotes() {
  const version = useUpdates.getState().status?.current_version ?? useApp.getState().settings?.version ?? (await api.appInfo().catch(() => null))?.version;
  if (version) void showReleaseNotes(version);
}

export interface HelpAction {
  id: string;
  label: TKey;
  icon: LucideIcon;
  run: () => void;
}

/** The entries of the help menu, in order (the palette has the same as commands). */
export const HELP_ACTIONS: HelpAction[] = [
  { id: "docs", label: "help.docs", icon: BookOpen, run: () => void openDocs() },
  { id: "shortcuts", label: "help.shortcuts", icon: Keyboard, run: showShortcuts },
  { id: "notes", label: "help.releaseNotes", icon: ScrollText, run: () => void showVersionNotes() },
  { id: "feedback", label: "help.feedback", icon: MessageSquareText, run: () => void openIssueForm("feedback") },
  { id: "bug", label: "help.bug", icon: Bug, run: () => void openIssueForm("bug") },
];

function menuItems(): MenuEntry[] {
  const item = (a: HelpAction) => ({ label: t(a.label), icon: a.icon, shortcut: a.id === "docs" ? hint("help") || undefined : undefined, onSelect: a.run });
  const [docs, shortcuts, notes, feedback, bug] = HELP_ACTIONS;
  return [item(docs), item(shortcuts), item(notes), "separator", item(feedback), item(bug)];
}

/** The "?" of the ribbon: the menu opens right of the ribbon, level with the button, moved up to fit the window. */
export function HelpButton() {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; keyboard: boolean } | null>(null);
  // A click on the button while the menu is open only closes it (the menu closes itself on the
  // press already, before the click would open it again).
  const wasOpen = useRef(false);
  return (
    <>
      <IconButton
        icon={CircleHelp}
        label={t("help.title")}
        tooltipSide="right"
        size="lg"
        className="ribbon-help"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        active={!!menu}
        onPointerDown={() => (wasOpen.current = !!menu)}
        onClick={(e) => {
          const close = menu || (e.detail !== 0 && wasOpen.current);
          wasOpen.current = false;
          if (close) return setMenu(null);
          const r = e.currentTarget.getBoundingClientRect();
          const rail = e.currentTarget.closest(".ribbon")?.getBoundingClientRect() ?? r;
          setMenu({ x: rail.right + MENU_GAP, y: r.top, keyboard: e.detail === 0 });
        }}
      />
      {menu && <Menu x={menu.x} y={menu.y} preselect={menu.keyboard} items={menuItems()} onClose={() => setMenu(null)} />}
    </>
  );
}
