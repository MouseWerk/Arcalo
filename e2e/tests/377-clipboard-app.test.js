// The app's own clipboard, used when the web clipboard refuses a copy (WebKitGTK without user
// activation): text, formatted text with its plain version, and an image from its pixels; an image
// whose size does not match its pixels is refused.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

/** The image command with its pixels as the request body, as lib/clipboard.ts sends it. */
const image = (width, height, bytes) =>
  app.browser.executeAsync(
    (w, h, n, done) =>
      window.__TAURI_INTERNALS__
        .invoke("clipboard_write_image", new Uint8Array(n).fill(200), { headers: { "x-arcalo-width": String(w), "x-arcalo-height": String(h) } })
        .then(() => done("ok"), (e) => done(`err ${e}`)),
    width,
    height,
    bytes,
  );

test("text, formatted text and an image go onto the clipboard through the app", async () => {
  await app.invoke("clipboard_write", { text: "/data/arcalo" });
  await app.invoke("clipboard_write", { text: "Hallo Welt", html: "<p><b>Hallo</b> Welt</p>" });
  assert.equal(await image(3, 2, 3 * 2 * 4), "ok");
  assert.match(await image(3, 2, 5), /^err .*size/);
  assert.deepEqual(await app.consoleErrors(), []);
});
