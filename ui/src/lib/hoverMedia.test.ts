import { describe, expect, it } from "vitest";
import { hoverOnly, isAppStylesheet, isReveal, splitHover, withoutHover } from "./hoverMedia";

describe("hover styles only where a pointer can hover", () => {
  it("splits selectors with :hover from the others", () => {
    expect(splitHover([".a:hover", ".a:focus-visible", ".b:hover .c"])).toEqual({ hover: [".a:hover", ".b:hover .c"], rest: [".a:focus-visible"] });
    expect(splitHover([".hovered", ".a"])).toEqual({ hover: [], rest: [".hovered", ".a"] });
  });

  it("drops :hover to show a control without one", () => {
    expect(withoutHover(".task-row:hover .task-plan")).toBe(".task-row .task-plan");
    expect(withoutHover(".resizer:hover::after")).toBe(".resizer::after");
    expect(withoutHover(".chip:has(+ .tail:hover)")).toBe(".chip:has(+ .tail)");
    expect(withoutHover(".row:not(:hover) .x")).toBeNull();
    expect(withoutHover(":hover")).toBeNull();
    expect(withoutHover(":hover > .x")).toBeNull();
  });

  it("knows a rule that only reveals a control", () => {
    expect(isReveal([{ prop: "opacity", value: "1" }])).toBe(true);
    expect(isReveal([{ prop: "opacity", value: "1" }, { prop: "pointer-events", value: "auto" }])).toBe(true);
    expect(isReveal([{ prop: "visibility", value: "visible" }])).toBe(true);
    expect(isReveal([{ prop: "opacity", value: "0" }])).toBe(false);
    expect(isReveal([{ prop: "background", value: "var(--bg-hover)" }])).toBe(false);
    expect(isReveal([{ prop: "opacity", value: "1" }, { prop: "color", value: "var(--text)" }])).toBe(false);
    expect(isReveal([])).toBe(false);
  });

  it("changes only the app's own stylesheets", () => {
    expect(isAppStylesheet("/repo/ui/src/styles/app.css")).toBe(true);
    expect(isAppStylesheet("C:\\repo\\ui\\src\\styles\\editor.css")).toBe(true);
    expect(isAppStylesheet("/repo/ui/node_modules/@excalidraw/excalidraw/dist/index.css")).toBe(false);
    expect(isAppStylesheet(undefined)).toBe(false);
  });

  it("moves hover rules into (hover: hover), (any-hover: hover) and shows revealed controls on touch", () => {
    // A small stand-in for PostCSS's nodes: enough to run the plugin on three rules.
    type N = { type: string; selector?: string; selectors?: string[]; nodes: N[]; prop?: string; value?: string; parent?: N; name?: string; params?: string };
    const out: N[] = [];
    const rule = (sel: string, decls: [string, string][]): N => {
      const r: N = { type: "rule", selector: sel, selectors: sel.split(/,\s*/), nodes: decls.map(([prop, value]) => ({ type: "decl", prop, value, nodes: [] })) };
      return r;
    };
    const rules = [rule(".a:hover, .a:focus-visible", [["background", "var(--bg-hover)"]]), rule(".row:hover .act", [["opacity", "1"]]), rule(".plain", [["color", "red"]])];
    const api = (r: N) => ({
      ...r,
      get selector() {
        return r.selectors!.join(", ");
      },
      set selectors(v: string[]) {
        r.selectors = v;
      },
      get selectors() {
        return r.selectors!;
      },
      clone: (over: { selectors: string[] }) => ({ ...r, selectors: over.selectors }),
      before: (n: N) => out.push(n),
      remove: () => {
        r.selectors = [];
      },
    });
    class AtRule {
      type = "atrule";
      nodes: N[] = [];
      name: string;
      params: string;
      constructor(o: { name: string; params: string }) {
        this.name = o.name;
        this.params = o.params;
      }
      append(n: N) {
        this.nodes.push(n);
      }
    }
    const root = { source: { input: { file: "/x/ui/src/styles/app.css" } }, walkRules: (cb: (r: ReturnType<typeof api>) => void) => rules.forEach((r) => cb(api(r))) };
    (hoverOnly().Once as unknown as (r: typeof root, h: { AtRule: typeof AtRule }) => void)(root, { AtRule });
    const media = out as unknown as AtRule[];
    expect(media.map((m) => `${m.params} ${m.nodes.map((n) => n.selectors!.join(", ")).join(" | ")}`)).toEqual([
      "(hover: hover), (any-hover: hover) .a:hover",
      "(hover: none) .row .act",
      "(hover: hover), (any-hover: hover) .row:hover .act",
    ]);
    // What has no :hover stays where it was; a rule of hover selectors only goes.
    expect(rules.map((r) => r.selectors!.join(", "))).toEqual([".a:focus-visible", "", ".plain"]);
  });
});
