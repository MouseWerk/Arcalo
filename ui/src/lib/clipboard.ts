// Copying text, formatted text and images. The web clipboard needs transient user activation, and
// WebKitGTK can deliver a click without it while the app is busy (a trusted click, yet the write
// fails with NotAllowedError). The copy then goes through the app on the desktop. Every copy comes
// here (a test checks it), and a copy that fails in both ways rejects with the web clipboard's
// error, so its caller can say so.

import { invoke } from "@tauri-apps/api/core";

/** The web clipboard first, then the app; on the phones (no such command there) the first error counts. */
async function viaApp(web: () => Promise<void>, app: () => Promise<unknown>): Promise<void> {
  try {
    await web();
  } catch (e) {
    await app().catch(() => Promise.reject(e));
  }
}

const unsupported = () => Promise.reject(new Error("The web clipboard cannot write this here"));
const canWrite = () => typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;

export function copyText(text: string): Promise<void> {
  return viaApp(
    () => (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : unsupported()),
    () => invoke("clipboard_write", { text }),
  );
}

/** Formatted text (`html`) with its plain version (`text`) for programs that do not take HTML. */
export function copyHtml(html: string, text: string): Promise<void> {
  return viaApp(
    () =>
      canWrite()
        ? navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })])
        : unsupported(),
    () => invoke("clipboard_write", { text, html }),
  );
}

/** An image (PNG); the app gets its pixels. */
export function copyImage(png: Blob): Promise<void> {
  return viaApp(
    () => (canWrite() ? navigator.clipboard.write([new ClipboardItem({ "image/png": png })]) : unsupported()),
    async () => {
      const bmp = await createImageBitmap(png);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return invoke("clipboard_write_image", new Uint8Array(data.buffer), { headers: { "x-arcalo-width": String(bmp.width), "x-arcalo-height": String(bmp.height) } });
    },
  );
}
