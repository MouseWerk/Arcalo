// Helpers for the sidebar's page tree (1.19 tests): rows by title, pages opened like a user
// would from elsewhere, the open folders as stored, reloads and the drag events WebKitGTK does
// not produce under WebDriver.

export function treeHelpers(getApp) {
  const app = () => getApp();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** The row of `title`, scrolled into view in the same step (a large tree renders only rows in view). */
  const findRow = (title) =>
    app().browser.execute((t) => {
      const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
      r?.scrollIntoView({ block: "nearest" });
      return r ?? null;
    }, title);

  async function row(title) {
    await app().browser.waitUntil(async () => (await findRow(title)) != null, { timeout: 8000, timeoutMsg: `no tree row ${title}` });
    await app().browser.pause(50);
    return app().browser.$(await findRow(title));
  }

  /** What a row says about itself (without scrolling it). */
  const rowState = (title) =>
    app().browser.execute((t) => {
      const r = [...document.querySelectorAll(".sidebar .tree-row")].find((x) => x.querySelector(".tree-label")?.textContent === t);
      if (!r) return null;
      const sc = r.closest(".sidebar-scroll").getBoundingClientRect();
      const b = r.getBoundingClientRect();
      return {
        id: Number(r.dataset.id),
        expanded: r.getAttribute("aria-expanded"),
        current: r.getAttribute("aria-current"),
        selected: r.getAttribute("aria-selected"),
        level: Number(r.getAttribute("aria-level")),
        setsize: r.getAttribute("aria-setsize"),
        posinset: r.getAttribute("aria-posinset"),
        inView: b.top >= sc.top - 1 && b.bottom <= sc.bottom + 1,
        classes: r.className,
        focused: document.activeElement === r,
      };
    }, title);

  // The open folders of this workspace (stored per data folder).
  const expanded = () => app().browser.execute(() => JSON.parse(localStorage.getItem(`arcalo.expanded.${window.__ARCALO_WORKSPACE__}`) ?? "null"));

  async function reload() {
    await app().browser.execute(() => location.reload());
    await app().browser.pause(300);
    await app().browser.waitUntil(() => app().browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000, timeoutMsg: "not ready after reload" });
    await app().waitFor(".sidebar .tree-row");
  }

  /** Opens a page from outside the tree (as the search window does). */
  async function openPage(id, title) {
    await app().invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
    await app().browser.waitUntil(async () => (await app().browser.execute(() => document.querySelector(".pane.active > .pane-content:not([hidden]) .page-title")?.value)) === title, {
      timeout: 8000,
      timeoutMsg: `${title} did not open`,
    });
  }

  const create = (title, parentId = null, content = "") => app().invoke("page_create", { parentId, title, icon: null, content });
  const pathOrder = async (parentId) => {
    const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
    const all = flat(await app().invoke("workspace_tree"));
    return parentId == null ? (await app().invoke("workspace_tree")).map((n) => n.title) : (all.find((p) => p.id === parentId)?.children ?? []).map((c) => c.title);
  };

  const menuClick = (label) =>
    app().browser.execute((l) => {
      const item = [...document.querySelectorAll(".menu-item")].find((b) => b.querySelector(".menu-label")?.textContent.trim() === l);
      if (!item) return false;
      item.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      item.click();
      return true;
    }, label);
  const menuItem = (label) =>
    app().browser.execute((l) => {
      const item = [...document.querySelectorAll(".menu-item")].find((b) => b.querySelector(".menu-label")?.textContent.trim() === l);
      return item ? { disabled: item.disabled, hint: item.querySelector(".menu-hint")?.textContent ?? null } : null;
    }, label);
  /** The context menu of a row (a contextmenu event: WebDriver's right click also clicks the row in WebKitGTK). */
  async function rowMenu(title) {
    const r = await row(title);
    await app().browser.execute((el) => {
      const b = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: b.left + 30, clientY: b.top + b.height / 2 }));
    }, r);
    await app().waitFor(".menu");
  }
  async function closeMenus() {
    for (let i = 0; i < 3; i++) if ((await app().$$(".menu")).length) await app().keys(["Escape"]);
  }

  const toastAction = (label) =>
    app().browser.execute((l) => {
      const b = [...document.querySelectorAll(".toast button")].find((x) => x.textContent.trim() === l);
      b?.click();
      return !!b;
    }, label);

  /**
   * A drag from the row of `from` to `to` (a row title, or a CSS selector with `css: true`) at
   * `y` (0 top, 1 bottom of the target). Returns what the drop target showed while hovered.
   */
  const drag = (from, to, { y = 0.5, css = false, drop = true } = {}) =>
    app().browser.execute(
      (f, t, y, css, drop) => {
        const byTitle = (x) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === x);
        const src = byTitle(f);
        const dst = css ? document.querySelector(t) : byTitle(t);
        if (!src || !dst) return { error: `missing ${src ? t : f}` };
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        const r = dst.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height * y };
        dst.dispatchEvent(new DragEvent("dragenter", at));
        const over = new DragEvent("dragover", at);
        dst.dispatchEvent(over);
        return { accepted: over.defaultPrevented, types: [...dt.types], data: dt.getData("application/x-arcalo-pages") };
      },
      from,
      to,
      y,
      css,
      drop,
    ).then(async (res) => {
      // The marker shows after React rendered; read it, then drop on the same target.
      await sleep(80);
      const shown = await app().browser.execute(() => ({
        hint: document.querySelector(".tree-drop-hint")?.textContent ?? null,
        inside: [...document.querySelectorAll(".tree-row.drop-inside .tree-label")].map((x) => x.textContent),
        line: [...document.querySelectorAll(".tree-row.drop-before .tree-label, .tree-row.drop-after .tree-label")].map((x) => x.textContent),
        root: !!document.querySelector(".tree-end.drop-root"),
      }));
      if (drop && !res.error)
        await app().browser.execute(
          (t, y, css, f) => {
            const byTitle = (x) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === x);
            const dst = css ? document.querySelector(t) : byTitle(t);
            const src = byTitle(f);
            const r = dst.getBoundingClientRect();
            const dt = new DataTransfer();
            dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height * y }));
            src?.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
          },
          to,
          y,
          css,
          from,
        );
      else await app().browser.execute((f) => [...document.querySelectorAll(".sidebar .tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === f)?.dispatchEvent(new DragEvent("dragend", { bubbles: true })), from);
      return { ...res, ...shown };
    });

  return { findRow, row, rowState, expanded, reload, openPage, create, pathOrder, menuClick, menuItem, rowMenu, closeMenus, toastAction, drag, sleep };
}
