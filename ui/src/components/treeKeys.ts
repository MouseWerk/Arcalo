// The tree keyboard model for the sidebar's smaller trees (smart folders, favorites, tags), whose
// items are plain DOM: arrows move between visible items, Right/Left open and close a group or go
// to its first item or its parent, Home/End, Enter and Space open, letters jump (typeahead). One
// Tab stop: the item that had the focus last.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { typeahead } from "../lib/filing";
import { isComposing } from "../lib/ime";

const TYPEAHEAD_MS = 700;
const typed = { text: "", at: 0 };

/** The letters typed so far for typeahead (a pause starts a new search). */
export function typeaheadText(key: string, now = Date.now()): string {
  typed.text = now - typed.at > TYPEAHEAD_MS ? key : typed.text + key;
  typed.at = now;
  return typed.text;
}

/** Whether a key types a letter for typeahead (no modifiers; Space only within a search, else it opens). */
export const isTypeaheadKey = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, now = Date.now()) =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key !== " " || (!!typed.text && now - typed.at <= TYPEAHEAD_MS));

/** Moves the Tab stop and the focus to `el`. */
export function focusItem(items: HTMLElement[], el: HTMLElement) {
  for (const x of items) if (x !== el) x.tabIndex = -1;
  el.tabIndex = 0;
  el.focus();
  el.scrollIntoView({ block: "nearest" });
}

const level = (el: HTMLElement) => Number(el.getAttribute("aria-level") ?? 1);

/** onKeyDown of a `role=tree` whose items are `[role=treeitem]` elements with `aria-level`. */
export function treeKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  if (isComposing(e)) return;
  const item = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
  if (!item || item !== e.target) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=treeitem]")];
  const i = items.indexOf(item);
  const go = (k: number) => {
    const el = items[k];
    if (!el) return;
    e.preventDefault();
    focusItem(items, el);
  };
  const expanded = item.getAttribute("aria-expanded");
  // Alt+←/→ go back and forward (keymap): not the tree's.
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (isTypeaheadKey(e)) {
    e.preventDefault();
    const k = typeahead(
      items.map((x) => x.querySelector(".tree-label")?.textContent ?? ""),
      i,
      typeaheadText(e.key),
    );
    if (k >= 0) go(k);
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      return go(i + 1);
    case "ArrowUp":
      return go(i - 1);
    case "Home":
      return go(0);
    case "End":
      return go(items.length - 1);
    case "ArrowRight":
      e.preventDefault();
      if (expanded === "false") item.click();
      else if (expanded === "true" && items[i + 1] && level(items[i + 1]) > level(item)) go(i + 1);
      return;
    case "ArrowLeft": {
      e.preventDefault();
      if (expanded === "true") return item.click();
      for (let k = i - 1; k >= 0; k--) if (level(items[k]) < level(item)) return go(k);
      return;
    }
    case "Enter":
    case " ":
      e.preventDefault();
      item.click();
      return;
  }
}

/** On hover: the full title as a tooltip when the label is cut off (`.tree-label` inside). */
export function titleIfCut(e: { currentTarget: HTMLElement }) {
  const label = e.currentTarget.querySelector<HTMLElement>(".tree-label");
  if (!label) return;
  if (label.scrollWidth > label.clientWidth + 1) label.title = label.textContent ?? "";
  else label.removeAttribute("title");
}
