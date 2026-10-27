// The open folders of the sidebar tree: folders start collapsed, the stored list of a version
// before 1.19 (the collapsed ones) becomes the open ones once, and deleted pages leave the list.

import { beforeEach, describe, expect, it } from "vitest";
import { collapsePages, migrateCollapsed, pruneIds, readExpanded, readOldCollapsed, writeExpanded } from "./collapsed";

describe("open folders", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as { __ARCALO_WORKSPACE__?: string }).__ARCALO_WORKSPACE__;
  });

  it("stores nothing until a folder is opened (all start collapsed)", () => {
    expect(readExpanded()).toBeNull();
    writeExpanded(new Set([4, 9]));
    expect([...readExpanded()!]).toEqual([4, 9]);
  });

  it("turns the collapsed list of before 1.19 into the open folders", () => {
    localStorage.setItem("arcalo.collapsed", "[2,5]");
    expect(readOldCollapsed()).toEqual([2, 5]);
    expect([...migrateCollapsed([2, 5], [1, 2, 3, 5])]).toEqual([1, 3]);
    writeExpanded(new Set([1, 3]));
    expect(readOldCollapsed()).toBeNull();
  });

  it("prunes deleted pages and keeps the set when nothing is gone", () => {
    const ids = new Set([1, 2, 3]);
    expect(pruneIds(ids, () => true)).toBe(ids);
    expect([...pruneIds(ids, (id) => id !== 2)]).toEqual([1, 3]);
  });

  it("keeps the open folders per workspace and takes over the shared list of the first 1.19 builds once", () => {
    const w = window as { __ARCALO_WORKSPACE__?: string };
    localStorage.setItem("arcalo.expanded", "[7,8]");
    w.__ARCALO_WORKSPACE__ = "aaaa";
    expect([...readExpanded()!]).toEqual([7, 8]);
    expect(localStorage.getItem("arcalo.expanded")).toBeNull();
    expect(localStorage.getItem("arcalo.expanded.aaaa")).toBe("[7,8]");
    // Another workspace: its own list; pruning there leaves this one alone.
    w.__ARCALO_WORKSPACE__ = "bbbb";
    expect(readExpanded()).toBeNull();
    writeExpanded(new Set([1]));
    w.__ARCALO_WORKSPACE__ = "aaaa";
    expect([...readExpanded()!]).toEqual([7, 8]);
  });

  it("collapses folders from outside the sidebar", () => {
    writeExpanded(new Set([1, 2, 3]));
    let fired = 0;
    const on = () => fired++;
    window.addEventListener("arcalo:collapsed", on);
    collapsePages([2, 3]);
    window.removeEventListener("arcalo:collapsed", on);
    expect([...readExpanded()!]).toEqual([1]);
    expect(fired).toBe(1);
  });
});
