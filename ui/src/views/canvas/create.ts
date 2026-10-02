// Creating canvases (tree, palette, slash menu). Kept apart from the board, which loads lazily.

import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import type { Page } from "../../lib/types";
import { useApp } from "../../store/app";

export const isCanvas = (p: { kind?: string | null } | null | undefined) => p?.kind === "canvas";

/** A new canvas below `parentId` (or filed into the canvas folder), opened unless `open` is false. */
export async function createCanvas(parentId: number | null, opts: { title?: string; open?: boolean; content?: string } = {}): Promise<Page | null> {
  const s = useApp.getState();
  try {
    const page = await api.createCanvas(opts.title ?? t("canvas.untitled"), parentId);
    if (opts.content) await api.savePage(page.id, opts.content);
    await s.refreshTree();
    if (opts.open !== false) s.openPage(page.id);
    return page;
  } catch (e) {
    s.error(t("canvas.createFailed"), e);
    return null;
  }
}
