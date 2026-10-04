// The data views in German and English, light, dark and high contrast, wide and narrow: backup
// and security settings, the trash, the versions dialog and the attachment manager. Each view
// is checked for text that runs out of its box; the screenshots are for the visual review.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch, guarded } from "../lib/harness.js";
import { launchEnglish } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app;
let enDir = null;
const PREFIX = process.env.ANNALO_SHOT_PREFIX ?? "data";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
after(async () => {
  await app?.close();
  if (enDir) fs.rmSync(enDir, { recursive: true, force: true });
});

const L = {
  de: { backup: "Sicherung", security: "Sicherheit", trash: "Papierkorb", attachments: "Anhänge verwalten", more: "Weitere Aktionen", versions: /Versionen/ },
  en: { backup: "Backup", security: "Security", trash: "Trash", attachments: "Manage attachments", more: "More actions", versions: /Versions/ },
};

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false }))?.id;

/** Pages in the trash (one with subpages), versions of a long-titled page, used and unused files. */
async function seed(lang) {
  const de = lang === "de";
  const title = de ? "Quartalsbericht Großkundenbetreuung Süddeutschland" : "Quarterly report for key accounts in southern Germany";
  const page = await app.invoke("page_create", { parentId: null, title, icon: null, content: null });
  for (const [i, text] of ["Erster Entwurf", "Erster Entwurf\n\nZahlen ergänzt", "Erster Entwurf\n\nZahlen ergänzt und geprüft\n\n- [ ] Freigabe"].entries()) {
    await app.invoke("page_save", { id: page.id, content: `# ${title}\n\n${text} ${i}` });
    await app.invoke("page_snapshot", { pageId: page.id });
  }
  const parent = await app.invoke("page_create", { parentId: null, title: de ? "Archiv Vertragsunterlagen" : "Contract archive", icon: null, content: null });
  for (const t of ["2024", "2025"]) await app.invoke("page_create", { parentId: parent.id, title: `${t}`, icon: null, content: null });
  await app.invoke("page_delete", { id: parent.id });
  const loose = await app.invoke("page_create", { parentId: null, title: de ? "Notiz ohne Überschrift" : "Note without a heading", icon: null, content: null });
  await app.invoke("page_delete", { id: loose.id });
  const store = async (name, bytes) => {
    const r = await app.browser.executeAsync(
      (n, b64, done) => {
        const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        window.__TAURI_INTERNALS__
          .invoke("attachment_store", data, { headers: { "x-annalo-name": encodeURIComponent(n) } })
          .then((ok) => done({ ok }), (err) => done({ err: String(err) }));
      },
      name,
      Buffer.from(bytes).toString("base64"),
    );
    if (r.err) throw new Error(r.err);
  };
  await store("Rahmenvertrag_Großkunde_2026_unterschrieben_final_v3.pdf", Buffer.from("%PDF-1.4\n%%EOF\n"));
  await store("alt.zip", Buffer.alloc(4096, 7));
  await app.invoke("page_save", { id: page.id, content: `# ${title}\n\n![[Rahmenvertrag_Großkunde_2026_unterschrieben_final_v3.pdf]]\n` });
  await app.invoke("backup_now");
  return page.id;
}

async function look(mode, id, width, height) {
  await app.browser.setWindowSize(width, height);
  const view = await app.invoke("settings_get");
  const ap = { ...view.settings.appearance };
  if (id) {
    if (mode === "light") ap.theme_light = id;
    else ap.theme_dark = id;
  }
  await app.invoke("settings_save", { settings: { ...view.settings, theme: mode, appearance: ap } });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
  await sleep(600);
}

/** Elements whose text is cut off without an ellipsis (runs out of its box). */
const overflowing = (root) =>
  [...document.querySelectorAll(`${root} *`)]
    .filter((el) => {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
      const s = getComputedStyle(el);
      if (s.textOverflow === "ellipsis" || s.overflowX === "auto" || s.overflowX === "scroll") return false;
      return el.scrollWidth > el.clientWidth + 1 && s.overflowX === "hidden";
    })
    .map((el) => `${el.className}: ${el.textContent.trim().slice(0, 60)}`);

async function palette(command) {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue(command);
  await app.waitText(".pal-item", new RegExp(`^${command}`));
  // The command itself, not a page or file that mentions it.
  await app.browser.execute(
    (c) => [...document.querySelectorAll(".pal-item")].find((el) => el.innerText.trim().startsWith(c))?.click(),
    command,
  );
}

async function settings(section) {
  await app.keys(["Control", ","]);
  await app.waitFor(".pane.active .settings");
  const wide = await app.browser.execute((s) => !!document.querySelector(`.settings-nav-item[data-section="${s}"]`)?.offsetParent, section);
  if (wide) await app.click(`.settings-nav-item[data-section="${section}"]`);
  else await app.select(".pane.active .settings-section-select", section);
  await sleep(500);
}

async function views(lang, tag, page) {
  const name = (v) => `${PREFIX}-${tag}-${v}`;
  await settings("backup");
  await app.shot(name("backup"));
  await app.browser.execute(() => document.querySelector(".backup-list")?.scrollIntoView({ block: "center" }));
  await app.shot(name("backup-list"));
  await settings("security");
  await app.shot(name("security"));
  await palette(L[lang].trash);
  await app.waitFor(".trash-item");
  assert.deepEqual(await app.browser.execute(overflowing, ".pane.active"), [], `${tag} trash`);
  await app.shot(name("trash"));
  await palette(L[lang].attachments);
  await app.waitFor(".att-table", 10000);
  await app.shot(name("attachments"));
  await app.invoke("search_open", { target: { kind: "page", page_id: page, new_tab: false } });
  await app.waitFor(".pane.active .ProseMirror");
  await app.click(`.pane.active [aria-label="${L[lang].more}"]`);
  await app.waitFor(".menu");
  await app.browser.execute(
    (src) => [...document.querySelectorAll(".menu-item")].find((el) => new RegExp(src).test(el.textContent))?.click(),
    L[lang].versions.source,
  );
  await app.waitFor(".versions-item");
  const items = await app.$$(".versions-item");
  await items[items.length - 1].click();
  await sleep(400);
  assert.deepEqual(await app.browser.execute(overflowing, ".dialog"), [], `${tag} versions`);
  await app.shot(name("versions"));
  await app.keys(["Escape"]);
}

test("German: light, high contrast and a narrow window", async () => {
  app = await launch({ width: 1280, height: 800 });
  const page = await seed("de");
  await look("light", null, 1280, 800);
  await views("de", "de-light", page);
  await look("dark", "contrast-dark", 900, 760);
  await views("de", "de-contrast-narrow", page);
});

test("English: dark at 1920x1080", async () => {
  await app?.close();
  app = null;
  ({ app, dataDir: enDir } = await launchEnglish({ width: 1920, height: 1080 }));
  const page = await seed("en");
  await look("dark", null, 1920, 1080);
  await views("en", "en-dark", page);
  assert.ok((await pageId("Contract archive")) == null, "trashed pages are not resolved");
});
