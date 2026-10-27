// „Neu“ in the page tree: every kind of page the app creates (page, folder, canvas, drawing,
// table, from a template), in a target folder. The tree's toolbar uses the usual place (Settings
// → Editor; canvases go into their folder), a page's context menu that page, the empty tree area
// the top level.

import { FilePlus2, FolderPlus, LayoutDashboard, LayoutTemplate, PenTool, Table2, type LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { t, type TKey } from "../lib/i18n";
import { selectShownTitle } from "../lib/keepalive";
import { defaultView, setView } from "../lib/collection";
import { drawingLabel, drawingTitle } from "../editor/drawing";
import { createSubpage } from "../views/PageView";
import { createCanvas } from "../views/canvas/create";
import { newPageFromTemplate } from "./Templates";
import type { MenuItem } from "./ui";

export type NewKind = "page" | "folder" | "canvas" | "drawing" | "table" | "template";

export const NEW_KINDS: { kind: NewKind; label: TKey; icon: LucideIcon }[] = [
  { kind: "page", label: "new.page", icon: FilePlus2 },
  { kind: "folder", label: "new.folder", icon: FolderPlus },
  { kind: "canvas", label: "new.canvas", icon: LayoutDashboard },
  { kind: "drawing", label: "new.drawing", icon: PenTool },
  { kind: "table", label: "new.table", icon: Table2 },
  { kind: "template", label: "new.template", icon: LayoutTemplate },
];

/** Asks the page tree to rename a page in place (a new folder gets its name there). */
export const TREE_RENAME_EVENT = "arcalo:tree-rename";

/** Where: a page, `null` for the top level, `undefined` for the usual place of the kind. */
export type NewTarget = number | null | undefined;

const s = useApp.getState;

/** A page with `content` in `parent`, opened with its title selected. */
async function createAt(parent: NewTarget, title: string, icon: string, content?: string) {
  const focus = document.activeElement;
  const p = await api.createPage(title, parent ?? null, icon, content);
  await s().refreshTree();
  s().openPage(p.id);
  selectShownTitle(focus);
  return p;
}

/** Creates a page of `kind` in `parent` and opens it (a folder is named in the tree instead). */
export async function createNew(kind: NewKind, parent: NewTarget): Promise<void> {
  try {
    switch (kind) {
      case "page":
        // The usual place follows Settings → Editor („Neue Seiten“); the top level is asked for here.
        if (parent === undefined) return void (await createSubpage(null));
        if (parent === null) return void (await createSubpage(null, undefined, { top: true }));
        return void (await createSubpage(parent));
      case "folder": {
        const p = await api.createPage(t("new.folderTitle"), parent ?? null, "folder");
        await s().refreshTree();
        window.dispatchEvent(new CustomEvent(TREE_RENAME_EVENT, { detail: { id: p.id } }));
        return;
      }
      case "canvas": {
        // Without a target a canvas is filed into its folder; the top level is a place of its own.
        const page = await createCanvas(parent ?? null, { open: parent !== null });
        if (page && parent === null) {
          await api.movePage(page.id, null, s().tree.length);
          await s().refreshTree();
          s().openPage(page.id);
        }
        return;
      }
      case "drawing": {
        const saved = await api.createDrawing(drawingTitle());
        await createAt(parent, drawingLabel(saved.name), "drawing", `![[${saved.name}]]\n`);
        // The drawing editor opens over the new page.
        const { openDrawing } = await import("../editor/drawings");
        openDrawing(saved.name);
        return;
      }
      case "table":
        await createAt(parent, t("new.tableTitle"), "database", setView("", { ...defaultView(), type: "tabelle" }));
        return;
      case "template":
        return void (await newPageFromTemplate(parent ?? null));
    }
  } catch (e) {
    s().error(t("page.createFailed"), e);
  }
}

/** The „Neu“ entries for `parent`; `before` runs first (the tree opens the target folder). */
export function newMenuItems(parent: NewTarget, before?: () => void): MenuItem[] {
  return NEW_KINDS.map(({ kind, label, icon }) => ({
    label: t(label),
    icon,
    onSelect: () => {
      before?.();
      void createNew(kind, parent);
    },
  }));
}
