// Helpers of the guided Git sync setup's tests (403-405): open it from Settings → Sicherung, fill
// its fields, press its main button, and screenshots of a step in light and dark at 900 and
// 1280 px.

/** Settings → Sicherung, scrolled to the Git sync group. */
export async function openBackupSettings(app) {
  // A setup a failed test left open is closed first.
  if (await app.browser.execute(() => !!document.querySelector(".gs-body"))) {
    await app.keys(["Escape"]);
    await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".gs-body")));
  }
  // Wide enough for the settings' section list beside the sidebar and the side panel.
  await app.browser.setWindowSize(1480, 920);
  if (!(await app.browser.execute(() => !!document.querySelector(".settings-nav")))) {
    await app.keys(["Control", ","]);
    await app.waitFor(".settings-nav");
  }
  // The section list may be folded in a narrow window: the section is chosen through its item.
  await app.browser.execute(() => document.querySelector('.settings-nav-item[data-section="backup"]').click());
  await app.waitText(".set-group-head h2", /^(Git-Synchronisierung|Git sync)$/);
}

/** Opens the setup („einrichten…“ or „Neu einrichten…“). */
export async function openSetup(app) {
  await openBackupSettings(app);
  const btn = await app.waitFor(".gs-open");
  await btn.scrollIntoView({ block: "center" });
  await app.click(".gs-open");
  await app.waitFor(".gs-body");
}

/** Sets an input like typing (React sees the change). */
export async function fill(app, sel, value) {
  await app.waitFor(sel);
  await app.browser.execute(
    (s, v) => {
      const el = document.querySelector(s);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    sel,
    value,
  );
}

/** The setup's main button (Weiter, Prüfen, Speichern …). */
export async function primary(app) {
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".gs-primary")?.disabled), { timeout: 15000, timeoutMsg: "the main button stays disabled" });
  await app.click(".gs-primary");
}

export const step = (app) => app.browser.execute(() => document.querySelector('.gs-steps li[aria-current="step"]')?.textContent?.replace(/^\d/, "").trim() ?? (document.querySelector(".gs-done") ? "done" : null));

/** Waits until the setup shows step `name` (its label). */
export async function onStep(app, name) {
  await app.browser.waitUntil(async () => (await step(app)) === name, { timeout: 15000, timeoutMsg: `step ${name} not reached (now ${await step(app)})` });
}

/** The problem the setup shows: its kind and its words. */
export async function problem(app, timeout = 20000) {
  await app.waitFor(".gs-problem", timeout);
  return app.browser.execute(() => {
    const p = document.querySelector(".gs-problem");
    return { kind: p.dataset.kind, title: p.querySelector(".gs-problem-title")?.textContent ?? "", text: p.innerText };
  });
}

/** Waits for the check to end; returns each step's state. */
export async function checked(app, timeout = 30000) {
  await app.browser.waitUntil(
    async () =>
      app.browser.execute(() => {
        const rows = [...document.querySelectorAll(".gs-check")];
        return rows.length > 0 && rows.every((r) => r.dataset.state !== "running");
      }),
    { timeout, timeoutMsg: "the check did not end" },
  );
  return app.browser.execute(() => Object.fromEntries([...document.querySelectorAll(".gs-check")].map((r) => [r.dataset.step, r.dataset.state])));
}

/** Picks the repository `full` from the list (searching for it first). */
export async function pick(app, full) {
  await app.waitFor(".gs-repo");
  await fill(app, '.gs-search input', full.split("/").pop());
  await app.browser.waitUntil(async () => app.browser.execute((f) => [...document.querySelectorAll(".gs-repo-name")].some((n) => n.textContent === f), full), { timeoutMsg: `${full} not listed` });
  await app.browser.execute((f) => [...document.querySelectorAll(".gs-repo")].find((r) => r.querySelector(".gs-repo-name").textContent === f).click(), full);
  await app.browser.waitUntil(async () => app.browser.execute((f) => document.querySelector('.gs-repo[aria-selected="true"] .gs-repo-name')?.textContent === f, full));
}

/** Chooses „Auswählen“, „Neu anlegen“ or „Adresse eingeben“ in the repository step. */
export async function mode(app, index) {
  await app.browser.execute((i) => document.querySelectorAll('.gs-body .segmented [role="radio"]')[i].click(), index);
  await app.browser.pause(100);
}

/** Saves the theme (and language), as a user would, and waits until the window shows it. */
export async function look(app, theme) {
  const view = await app.invoke("settings_get");
  if (view.settings.theme !== theme) await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.documentElement.dataset.theme)) === theme, { timeoutMsg: `${theme} not applied` });
}

/**
 * Screenshots of the open setup in light and dark at 900 and 1280 px (back to 1280 light after);
 * fails when the dialog does not fit the window or anything in it scrolls sideways.
 */
export async function shots(app, name) {
  for (const width of [900, 1280]) {
    await app.browser.setWindowSize(width, 860);
    await app.browser.pause(200);
    for (const theme of ["light", "dark"]) {
      await look(app, theme);
      const fit = await app.browser.execute(() => {
        const d = document.querySelector(".dialog");
        const r = d.getBoundingClientRect();
        const over = [...d.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible" && getComputedStyle(el).textOverflow !== "ellipsis" && !["CODE", "INPUT"].includes(el.tagName)).map((el) => el.className);
        return { inside: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight, over };
      });
      if (!fit.inside || fit.over.length) throw new Error(`${name} at ${width} ${theme}: ${JSON.stringify(fit)}`);
      await app.shot(`gitsetup-${name}-${width}-${theme}`);
    }
  }
  await look(app, "light");
  await app.browser.setWindowSize(1480, 920);
}
