// q124 round 7, hunt C: „Rückgängig“ of a settings change gives back what the change took away.
// R7C-1: removing an AI provider deleted its API key from the credential store at once; the undo
// brought the provider back without its key (every request then failed with 401). R7C-2: the chat
// retention („30 Tage“) deleted the old chats the moment it was chosen, and every chat deleted
// in the minute before: its own „Rückgängig“ then failed, and the settings undo brought back the
// setting, not the chats. Both now wait until the change can no longer be undone (a short wait
// here, `ARCALO_UNDO_GRACE_SECS`).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch({ env: { ARCALO_UNDO_GRACE_SECS: "6" } });
});
after(async () => {
  await app?.close();
});

const settings = async () => (await app.invoke("settings_get")).settings;
const save = async (patch) => app.invoke("settings_save", { settings: { ...(await settings()), ...patch } });
const provider = (id, name) => ({ id, name, kind: "openai_compatible", base_url: "http://127.0.0.1:4999/v1", local: false, enabled: true, bypass_proxy: true, api_version: "", models: [] });
const waitUntil = (f, timeoutMsg, timeout = 15000) => app.browser.waitUntil(f, { timeout, interval: 300, timeoutMsg });

test("removing a provider and taking it back keeps its API key (R7C-1)", async () => {
  await save({ providers: [provider("firma", "Firma"), provider("zweit", "Zweit")] });
  await app.invoke("provider_key_set", { id: "firma", key: "sk-firma-123" });
  await app.invoke("provider_key_set", { id: "zweit", key: "sk-zweit-456" });
  const before = await settings();
  assert.deepEqual((await app.invoke("settings_get")).provider_keys.sort(), ["firma", "zweit"]);

  // Removed (the row menu's „Entfernen“), then „Rückgängig“: the settings as before.
  await save({ providers: before.providers.filter((p) => p.id !== "firma") });
  await app.browser.pause(1000);
  await save({ providers: before.providers });
  assert.deepEqual((await app.invoke("settings_get")).provider_keys.sort(), ["firma", "zweit"], "the key came back with the provider");

  // Removed for good: its key goes once the undo is over, the other one stays.
  await save({ providers: before.providers.filter((p) => p.id !== "zweit") });
  await app.browser.pause(9000);
  await save({ providers: before.providers });
  assert.deepEqual((await app.invoke("settings_get")).provider_keys, ["firma"], "the removed provider's key was deleted after the undo time");
});

test("choosing „30 Tage“ and taking it back keeps the old chats and a chat deleted just before (R7C-2)", async () => {
  const create = async (title) => {
    const c = await app.invoke("chat_create", { title });
    await app.invoke("chat_append", { id: c.id, messages: [{ role: "user", content: title }], pageId: null, private: false });
    return c.id;
  };
  const old = await create("Alte Frage zum Budget");
  const recent = await create("Frage von heute");
  const db = new DatabaseSync(path.join(app.dataDir, "workspace.db"));
  db.prepare("UPDATE chat_conversations SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 45 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z"), old);
  db.close();
  const ids = async () => (await app.invoke("chat_list", { query: "", archived: true })).map((c) => c.id).sort((a, b) => a - b);

  // A chat deleted (its toast offers „Rückgängig“ for a minute), then the retention changed and taken back.
  await app.invoke("chat_delete", { id: recent });
  const ai = (await settings()).ai;
  await save({ ai: { ...ai, chat_history: "30" } });
  await app.browser.pause(1000);
  await save({ ai: { ...ai, chat_history: "all" } });
  await app.browser.pause(8000);
  assert.deepEqual(await ids(), [old], "the old chat is still there after the undo");
  await app.invoke("chat_restore", { id: recent });
  assert.deepEqual(await ids(), [old, recent].sort((a, b) => a - b), "the deleted chat can still be taken back");

  // Kept at „30 Tage“: the old chat goes once the change can no longer be undone.
  await save({ ai: { ...ai, chat_history: "30" } });
  assert.ok((await ids()).includes(old), "not at once");
  await waitUntil(async () => !(await ids()).includes(old), "the old chat was not removed after the undo time");
  assert.deepEqual(await ids(), [recent]);
});
