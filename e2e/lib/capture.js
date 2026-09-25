// Drives the quick-capture window (label "capture"): a second webview, reached by switching
// WebDriver's window handle. `capture_show` stands in for the global shortcut.

/** Opens the capture window and switches to it; `toMain()` switches back. */
export async function openCapture(app) {
  const b = app.browser;
  const main = app.mainHandle ?? (app.mainHandle = await b.getWindowHandle());
  await b.switchToWindow(main);
  await app.invoke("capture_show");
  let handle = app.captureHandle;
  if (!handle) {
    await b.waitUntil(
      async () => {
        for (const h of await b.getWindowHandles()) {
          if (h === main) continue;
          await b.switchToWindow(h);
          if ((await b.execute(() => location.hash)) === "#capture") {
            handle = h;
            return true;
          }
        }
        await b.switchToWindow(main);
        return false;
      },
      { timeout: 10000, timeoutMsg: "capture window not found" },
    );
    app.captureHandle = handle;
  }
  await b.switchToWindow(handle);
  await b.waitUntil(() => b.execute(() => document.body.classList.contains("ready")), { timeout: 10000, timeoutMsg: "capture window not ready" });
  await b.waitUntil(() => b.execute(() => document.activeElement?.classList.contains("capture-input") ?? false), { timeout: 5000, timeoutMsg: "capture input not focused" });
  return {
    toMain: () => b.switchToWindow(main),
    toCapture: () => b.switchToWindow(handle),
  };
}

/** Whether the capture window is shown (asked from the window itself). */
export async function captureVisible(app) {
  return app.browser.executeAsync((done) =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "capture" }).then(done, () => done(null)),
  );
}

/** The Markdown of the page titled `title` (null when there is none). */
export async function pageContent(app, title) {
  const page = await findPage(app, title);
  return page ? (await app.invoke("page_get", { id: page.id })).content : null;
}

/** The page titled `title` in the tree (not in the trash), or null. */
export async function findPage(app, title) {
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.title === title) return n;
      const hit = walk(n.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(await app.invoke("workspace_tree"));
}

/** The Markdown of today's daily note. */
export async function dailyContent(app) {
  const page = await app.invoke("daily_note", { date: null });
  return (await app.invoke("page_get", { id: page.id })).content;
}
