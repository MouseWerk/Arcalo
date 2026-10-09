// The keys that are not commands of Settings → Tastatur (fixed keys of the editor, the page tree,
// the calendar, the start page's edit mode, focus blocks and the graph): one table, shown read-only
// below the commands, so the help's „Tastenkürzel“ lists everything the keyboard does.
// keyhelp.test.ts checks it against the handlers it describes.

import type { TKey } from "./i18n";
import { replaceHint } from "./shortcut";

export interface KeyHelp {
  /** What the keys do. */
  label: TKey;
  /** Each a shortcut spec for `keys()` („Mod B“, „Shift ArrowUp“); several are alternatives. */
  keys: string[];
  /** Shown as typed text instead of keys (`/`, `[[`, `#`). */
  typed?: boolean;
}

export interface KeyGroup {
  title: TKey;
  items: KeyHelp[];
}

export const KEY_HELP: KeyGroup[] = [
  {
    title: "kh.group.window",
    items: [
      { label: "kh.regions", keys: ["F6", "Shift F6"] },
      { label: "kh.focusEnd", keys: ["Escape"] },
    ],
  },
  {
    title: "kh.group.editor",
    items: [
      { label: "keys.reserved.bold", keys: ["Mod B"] },
      { label: "keys.reserved.italic", keys: ["Mod I"] },
      { label: "keys.reserved.code", keys: ["Mod E"] },
      { label: "keys.reserved.undo", keys: ["Mod Z"] },
      { label: "keys.reserved.redo", keys: ["Mod Shift Z", "Mod Y"] },
      { label: "keys.reserved.find", keys: ["Mod F"] },
      { label: "kh.replace", keys: ["replace"] },
      { label: "kh.followLink", keys: ["Alt Enter"] },
      { label: "kh.slash", keys: ["/"], typed: true },
      { label: "kh.link", keys: ["[["], typed: true },
      { label: "kh.tag", keys: ["#"], typed: true },
    ],
  },
  {
    title: "kh.group.tree",
    items: [
      { label: "kh.open", keys: ["Enter"] },
      { label: "kh.rename", keys: ["F2"] },
      { label: "kh.trash", keys: ["Delete"] },
      { label: "kh.range", keys: ["Shift ArrowUp", "Shift ArrowDown"] },
      { label: "keys.reserved.selectAll", keys: ["Mod A"] },
      { label: "kh.menu", keys: ["Shift F10"] },
    ],
  },
  {
    title: "kh.group.calendar",
    items: [
      { label: "kh.calMove", keys: ["ArrowLeft", "ArrowRight", "PageUp", "PageDown"] },
      { label: "kh.calToday", keys: ["T"] },
      { label: "kh.calDay", keys: ["D"] },
      { label: "kh.calWorkweek", keys: ["A"] },
      { label: "kh.calWeek", keys: ["W"] },
      { label: "kh.calMonth", keys: ["M"] },
      { label: "kh.calAgenda", keys: ["L"] },
      { label: "kh.calClose", keys: ["Escape"] },
    ],
  },
  {
    title: "kh.group.blocks",
    items: [
      { label: "kh.blockMove", keys: ["ArrowUp", "ArrowDown"] },
      { label: "kh.blockLength", keys: ["Shift ArrowUp", "Shift ArrowDown"] },
      { label: "kh.blockDay", keys: ["ArrowLeft", "ArrowRight"] },
      { label: "kh.open", keys: ["Enter", "F2"] },
      { label: "kh.remove", keys: ["Delete"] },
    ],
  },
  {
    title: "kh.group.dashboard",
    items: [
      { label: "kh.dashMove", keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] },
      { label: "kh.dashResize", keys: ["Shift ArrowRight", "Shift ArrowDown"] },
      { label: "kh.dashPreset", keys: ["1", "2", "3", "4", "5"] },
      { label: "kh.dashDuplicate", keys: ["Mod D"] },
      { label: "kh.dashSettings", keys: ["Enter"] },
      { label: "kh.remove", keys: ["Delete"] },
    ],
  },
  {
    title: "kh.group.graph",
    items: [
      { label: "kh.graphMove", keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] },
      { label: "kh.graphPan", keys: ["Shift ArrowLeft", "Shift ArrowRight"] },
      { label: "kh.open", keys: ["Enter", "Mod Enter"] },
      { label: "kh.graphHub", keys: ["Home"] },
      { label: "kh.graphZoom", keys: ["+", "-"] },
      { label: "kh.graphFit", keys: ["0"] },
      { label: "kh.graphDeselect", keys: ["Escape"] },
    ],
  },
  {
    title: "kh.group.palette",
    items: [
      { label: "kh.palTime", keys: ["/zeit"], typed: true },
      { label: "kh.palTag", keys: ["#"], typed: true },
      { label: "kh.palAsk", keys: ["?"], typed: true },
    ],
  },
];

/** The spec as shown: the platform's replace shortcut for `replace`, else the spec itself. */
export const helpSpec = (spec: string) => (spec === "replace" ? replaceHint() : null);
