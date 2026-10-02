// Settings apply at once (typing once it pauses): helpers that wait until a change is stored.

/**
 * Leaves the focused field (a field applies on blur) and waits until no settings save is
 * pending any more.
 */
export async function settingsSettled(app, timeout = 8000) {
  await app.browser.execute(() => {
    const el = document.activeElement;
    if (el && el !== document.body && el.closest?.(".settings")) el.blur();
  });
  await app.browser.waitUntil(async () => app.browser.execute(() => !document.querySelector(".settings[data-pending]")), {
    timeout,
    timeoutMsg: "settings still saving",
  });
}

/** The stored settings (`settings_get`). */
export async function storedSettings(app) {
  return (await app.invoke("settings_get")).settings;
}

/** Clicks „Rückgängig“ / „Undo“ in the newest toast that offers it. */
export async function clickUndo(app) {
  await app.browser.waitUntil(
    async () =>
      app.browser.execute(() => {
        const b = [...document.querySelectorAll(".toast button")].reverse().find((x) => /^(Rückgängig|Undo)$/.test(x.textContent.trim()));
        b?.click();
        return !!b;
      }),
    { timeout: 8000, timeoutMsg: "no undo in a toast" },
  );
}
