// Hover styles only where a pointer can hover (1.20, the full app on Android). On a touch screen
// a tap leaves `:hover` on the element until the next tap elsewhere, so a row stays tinted and a
// hover-only control stays shown. At build time (ui/vite.config.ts) every rule of the app's
// stylesheets with `:hover` in a selector goes into `@media (hover: hover)`; where the rule only
// reveals a control (opacity, visibility), `@media (hover: none)` shows the control without the
// hover instead, so nothing becomes unreachable by touch. Desktops with a mouse or trackpad match
// `(hover: hover)` and keep every rule as written.
//
// The selector logic is plain functions (tested in hoverMedia.test.ts); `hoverOnly` wires them
// into PostCSS without importing it (Vite passes the node constructors).

/** Splits a rule's selectors into those with `:hover` and the rest. */
export function splitHover(selectors: string[]): { hover: string[]; rest: string[] } {
  const hover: string[] = [];
  const rest: string[] = [];
  for (const s of selectors) (/:hover\b/.test(s) ? hover : rest).push(s);
  return { hover, rest };
}

/** The selector without its `:hover` (what the control looks like without a hover), or null when
 *  that leaves nothing sensible (`:not(:hover)`, a bare `:hover`). */
export function withoutHover(selector: string): string | null {
  if (/:not\([^)]*:hover/.test(selector)) return null;
  const out = selector
    .replace(/:hover\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Nothing left, or a combinator without its other side (`:hover > .x`).
  if (!out || /^[>+~]|[>+~]$/.test(out) || /\(\s*\)/.test(out)) return null;
  return out;
}

const REVEAL_PROPS = new Set(["opacity", "visibility", "pointer-events", "transition-delay"]);

/** A rule that only shows something on hover (opacity, visibility): touch shows it always. */
export function isReveal(decls: { prop: string; value: string }[]): boolean {
  if (!decls.length || !decls.every((d) => REVEAL_PROPS.has(d.prop))) return false;
  const opacity = decls.find((d) => d.prop === "opacity");
  const visibility = decls.find((d) => d.prop === "visibility");
  if (opacity && Number(opacity.value) === 0) return false;
  if (visibility && visibility.value.trim() !== "visible") return false;
  return !!(opacity || visibility);
}

/** The app's own stylesheets (not those of packages, e.g. Excalidraw's). */
export function isAppStylesheet(file: string | undefined): boolean {
  return !!file && /[\\/]src[\\/]styles[\\/][^\\/]+\.css$/.test(file) && !/node_modules/.test(file);
}

// Minimal shapes of the PostCSS nodes used here.
interface Decl {
  type: string;
  prop: string;
  value: string;
}
interface Rule {
  type: string;
  selector: string;
  selectors: string[];
  nodes: Decl[];
  parent?: Parent;
  clone(over?: Record<string, unknown>): Rule;
  before(n: unknown): void;
  remove(): void;
}
interface Parent {
  type: string;
  name?: string;
  params?: string;
  parent?: Parent;
}
interface Root {
  source?: { input?: { file?: string } };
  walkRules(cb: (r: Rule) => void): void;
}
interface Helpers {
  AtRule: new (o: { name: string; params: string }) => { append(n: unknown): void };
}

function inside(rule: Rule, test: (p: Parent) => boolean): boolean {
  for (let p = rule.parent; p; p = p.parent) if (test(p)) return true;
  return false;
}

/** The PostCSS plugin (ui/vite.config.ts → css.postcss.plugins). */
export function hoverOnly() {
  return {
    postcssPlugin: "arcalo-hover-only",
    Once(node: unknown, helpers: unknown) {
      const root = node as Root;
      const { AtRule } = helpers as Helpers;
      if (!isAppStylesheet(root.source?.input?.file)) return;
      root.walkRules((rule) => {
        if (!rule.selector.includes(":hover")) return;
        if (inside(rule, (p) => p.type === "atrule" && (/keyframes$/.test(p.name ?? "") || /\bhover\s*:/.test(p.params ?? "")))) return;
        const { hover, rest } = splitHover(rule.selectors);
        if (!hover.length) return;
        const decls = rule.nodes.filter((n) => n.type === "decl");
        if (isReveal(decls)) {
          const plain = hover.map(withoutHover).filter((s): s is string => !!s);
          if (plain.length) {
            const none = new AtRule({ name: "media", params: "(hover: none)" });
            none.append(rule.clone({ selectors: plain }));
            rule.before(none);
          }
        }
        const media = new AtRule({ name: "media", params: "(hover: hover)" });
        media.append(rule.clone({ selectors: hover }));
        rule.before(media);
        if (rest.length) rule.selectors = rest;
        else rule.remove();
      });
    },
  };
}
