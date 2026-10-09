import { beforeEach, describe, expect, it, vi } from "vitest";
import { renamePageWithUndo } from "./rename";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { useApp } from "../store/app";

vi.mock("../lib/api", async (orig) => {
  const m = await orig<typeof import("../lib/api")>();
  return { ...m, api: { ...m.api, renamePage: vi.fn() } };
});
vi.mock("./saves", () => ({ flushAllEditors: vi.fn(async () => {}) }));
vi.mock("./NoteEditor", () => ({ reloadEditors: vi.fn() }));

describe("renaming a page", () => {
  beforeEach(() => {
    useApp.setState({ toasts: [], refreshTree: vi.fn(async () => {}) } as never);
    vi.mocked(api.renamePage).mockReset();
  });

  it("offers „Rückgängig“ for a rename", async () => {
    vi.mocked(api.renamePage).mockResolvedValue(0);
    await renamePageWithUndo(1, "Alpha", "Beta");
    expect(useApp.getState().toasts.map((x) => x.action?.label)).toEqual([t("common.undo")]);
  });

  it("stays quiet when a new page gets its first title", async () => {
    vi.mocked(api.renamePage).mockResolvedValue(0);
    await renamePageWithUndo(1, t("page.untitled"), "Besprechung");
    await renamePageWithUndo(2, "", "Notiz");
    expect(useApp.getState().toasts).toEqual([]);
    // Links to it were rewritten: that is worth saying, with the way back.
    vi.mocked(api.renamePage).mockResolvedValue(2);
    await renamePageWithUndo(3, t("page.untitled"), "Plan");
    expect(useApp.getState().toasts).toHaveLength(1);
  });
});
