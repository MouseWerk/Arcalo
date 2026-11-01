// The machinery of a screenshot tour (e2e 440): photograph a stop, audit its layout, note what
// cannot be reached or does not close with Esc, and collect every finding for one assertion at
// the end. `createTour(getApp)` binds it to the running app; `tour.combo` and `tour.lang` say
// which combination of language, theme and size is being photographed.
import { auditLayout } from "./layout-audit.js";
import { germanLeftovers } from "./english.js";
import { translator } from "./catalog.js";

export const PANE = ".pane.active > .pane-content:not([hidden])";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What is open on top: a menu, a popover or a dialog (the last one). */
const ROOTS = ".menu, [role=dialog], [role=listbox].suggest, .popover, .overlay > *, .modal";

export function createTour(getApp, { prefix, auditOk = [], germanOk = [] }) {
  const app = () => getApp();
  const tour = {
    lang: "de",
    t: translator("de"),
    combo: "",
    n: 0,
    findings: [],
    setLang(lang) {
      tour.lang = lang;
      tour.t = translator(lang);
    },
    note(where, what) {
      tour.findings.push(`${tour.combo} ${where}: ${what}`);
    },

    /** The theme `id` in `mode` ("light" or "dark") at `width` x `height`. */
    async look(mode, id, width, height) {
      await app().browser.setWindowSize(width, height);
      const view = await app().invoke("settings_get");
      const ap = { ...view.settings.appearance, [mode === "light" ? "theme_light" : "theme_dark"]: id };
      await app().invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
      await app().reload();
      await app().browser.waitUntil(async () => (await app().browser.execute(() => document.documentElement.dataset.themeId)) === id, { timeoutMsg: `${id} not applied` });
    },

    async topRoot() {
      return app().browser.execute((sel) => {
        const shown = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
        const el = shown[shown.length - 1];
        if (!el) return null;
        if (!el.id) el.id = `tour-root-${Math.random().toString(36).slice(2, 8)}`;
        return `#${CSS.escape(el.id)}`;
      }, ROOTS);
    },

    /** Photographs the window and audits `root` (default: what is on top, else the active pane). */
    async shot(name, root, { german = true } = {}) {
      await sleep(350);
      const file = `${prefix}-${tour.combo}-${String(++tour.n).padStart(3, "0")}-${name}`;
      await app().shot(file);
      const where = root ?? (await tour.topRoot()) ?? PANE;
      const problems = await app().browser.execute(auditLayout, where).catch((e) => [`audit failed: ${e.message}`]);
      for (const p of problems) if (!/^root .* not found$/.test(p) && !auditOk.some((re) => re.test(p))) tour.note(file, p);
      // A field's placeholder is its label while it is empty: it must not be cut („Search in the Pl“).
      const cutHints = await app().browser.execute((s) => {
        const ctx = document.createElement("canvas").getContext("2d");
        const out = [];
        for (const i of document.querySelector(s)?.querySelectorAll("input[placeholder]") ?? []) {
          if (i.value || !i.placeholder || !i.getClientRects().length || i.type === "hidden") continue;
          const cs = getComputedStyle(i);
          ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const room = i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          if (ctx.measureText(i.placeholder).width > room + 1) out.push(`"${i.placeholder}" (${Math.round(ctx.measureText(i.placeholder).width)} > ${Math.round(room)})`);
        }
        return out;
      }, where).catch(() => []);
      for (const c of cutHints) tour.note(file, `placeholder cut: ${c}`);
      // What is on top (a menu, a dialog, a popover) is not covered by anything (a toast once covered a menu).
      if (!root && where !== PANE) {
        const over = await app().browser.execute((s) => {
          const el = document.querySelector(s);
          const r = el?.getBoundingClientRect();
          if (!r || !r.width) return null;
          const pts = [[r.left + 6, r.top + 6], [r.right - 6, r.top + 6], [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6], [r.left + r.width / 2, r.top + r.height / 2]];
          for (const [x, y] of pts) {
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && !el.contains(hit) && !hit.closest(".tooltip")) return `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}`;
          }
          return null;
        }, where);
        if (over) tour.note(file, `${where} is covered by ${over}`);
      }
      const wide = await app().browser.execute(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 1) tour.note(file, `the page scrolls sideways by ${wide}px`);
      if (tour.lang === "en" && german) for (const h of await germanLeftovers(app(), [/Arcalo/, ...germanOk])) tour.note(file, `German: ${h}`);
    },

    /**
     * Runs one stop; a stop that fails is a finding and the tour goes on. Afterwards Esc must
     * close whatever the stop left open (menus, popovers, dialogs).
     */
    async stop(name, fn) {
      try {
        await fn();
      } catch (e) {
        tour.note(name, `failed: ${String(e.message ?? e).split("\n")[0]}`);
        await app().browser.saveScreenshot(`${process.env.ARCALO_SHOTS ?? "screenshots"}/${prefix}-${tour.combo}-FAILSTOP-${name}.png`).catch(() => {});
      }
      const left = await tour.closeAll();
      if (left) tour.note(name, `Esc does not close ${left}`);
    },

    /** Escape until nothing is on top; returns what stayed open (null when all closed). */
    async closeAll() {
      for (let i = 0; i < 4; i++) {
        const top = await tour.topRoot();
        if (!top) return null;
        await app().keys(["Escape"]);
        await sleep(200);
      }
      const top = await tour.topRoot();
      return top ? app().browser.execute((s) => { const e = document.querySelector(s); return `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`; }, top) : null;
    },

    /** Runs the palette command titled `t(key)`. */
    async command(key, vars) {
      const title = tour.t(key, vars);
      await app().keys(["Control", "k"]);
      const input = await app().waitFor(".palette input");
      await app().browser.execute((el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, input, title);
      await app().browser.waitUntil(
        async () =>
          app().browser.execute((want) => {
            const item = [...document.querySelectorAll(".palette .pal-item")].find((i) => i.querySelector(".pal-title")?.firstChild?.textContent?.trim() === want);
            item?.click();
            return !!item;
          }, title),
        { timeout: 4000, timeoutMsg: `no command "${title}"` },
      );
      await sleep(600);
    },

    /**
     * Opens the context menu of `sel` (the first match) as a right-click near its start does: the
     * event goes to the element under the pointer, where the app listens.
     */
    async rightClick(sel, menu = ".menu") {
      const el = await app().waitFor(sel);
      await app().browser.execute((e) => {
        e.scrollIntoView({ block: "nearest" });
        const r = e.getBoundingClientRect();
        const x = r.left + Math.min(r.width / 2, 40);
        const y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) ?? e;
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
      }, el);
      await app().waitFor(menu);
    },

    /** Clicks (a real pointer click) the first visible element matching `sel` whose text matches `re`. */
    async clickText(sel, re) {
      let id = null;
      await app().browser.waitUntil(
        async () =>
          (id = await app().browser.execute(
            (s, src, flags) => {
              const el = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length && new RegExp(src, flags).test(e.textContent.trim()));
              if (!el) return null;
              el.id ||= `tour-click-${Math.random().toString(36).slice(2, 8)}`;
              return el.id;
            },
            sel,
            re.source,
            re.flags,
          )),
        { timeout: 5000, timeoutMsg: `no ${sel} ${re}` },
      );
      await app().click(`#${id}`);
      await sleep(200);
    },

    /** The bounding box of the first match of `sel` (null when there is none). */
    rect(sel) {
      return app().browser.execute((s) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null, sel);
    },

    /** Tab moves the focus through `root` and never leaves it; returns the stops it visited. */
    async tabCycle(root, steps = 12) {
      const seen = [];
      for (let i = 0; i < steps; i++) {
        await app().keys(["Tab"]);
        const where = await app().browser.execute((r) => {
          const a = document.activeElement;
          const inside = !!a && !!document.querySelector(r)?.contains(a);
          return { inside, what: a ? `${a.tagName.toLowerCase()}${a.getAttribute("aria-label") ? ` "${a.getAttribute("aria-label")}"` : ""}` : "none", ring: a ? getComputedStyle(a).outlineStyle !== "none" || getComputedStyle(a).boxShadow !== "none" : false };
        }, root);
        seen.push(where);
        if (!where.inside) return { left: where.what, seen };
      }
      return { left: null, seen };
    },
  };
  return tour;
}
