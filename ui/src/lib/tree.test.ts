import { describe, expect, it } from "vitest";
import { fromPageRows } from "./tree";

describe("compact tree", () => {
  it("decodes the rows of workspace_tree_compact into the nodes of workspace_tree", () => {
    const [folder] = fromPageRows([
      [
        1,
        null,
        "Projekte",
        "folder",
        0,
        "2026-10-02T08:00:00Z",
        true,
        null,
        null,
        "2026-10-01T08:00:00Z",
        "rule",
        { sort: "name", folders_first: true, color: "info" },
        [[2, 1, "2026-10-03", null, 1, "2026-10-03T08:00:00Z", false, "2026-10-03", "canvas", "2026-10-03T07:00:00Z", null, null, []]],
      ],
    ]);
    expect(folder.children[0]).toEqual({ id: 2, parent_id: 1, title: "2026-10-03", icon: null, position: 1, updated_at: "2026-10-03T08:00:00Z", favorite: false, daily_date: "2026-10-03", deleted_at: null, kind: "canvas", children: [], created_at: "2026-10-03T07:00:00Z" });
    expect({ ...folder, children: [] }).toEqual({ id: 1, parent_id: null, title: "Projekte", icon: "folder", position: 0, updated_at: "2026-10-02T08:00:00Z", favorite: true, daily_date: null, deleted_at: null, children: [], created_at: "2026-10-01T08:00:00Z", system: "rule", style: { sort: "name", folders_first: true, color: "info" } });
    // Unset fields stay absent, as in workspace_tree.
    expect("kind" in folder || "system" in folder.children[0] || "style" in folder.children[0]).toBe(false);
  });
});
