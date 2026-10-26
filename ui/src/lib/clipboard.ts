// Copying text. The web clipboard needs transient user activation, and WebKitGTK can deliver a click
// without it while the app is busy (a trusted click, yet writeText fails with NotAllowedError). The
// copy then goes through the app on the desktop. Every text copy comes here (a test checks it), and
// a copy that fails in both ways rejects, so its caller can say so.

import { invoke } from "@tauri-apps/api/core";

export async function copyText(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Not on the phones (no such command there): the first error is the one that counts.
    await invoke("clipboard_write", { text }).catch(() => Promise.reject(e));
  }
}
