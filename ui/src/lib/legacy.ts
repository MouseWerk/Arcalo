// The names of 1.14 and earlier (Annalo) that the UI still reads: storage keys, file formats,
// links in notes and theme ids. Everything here only reads; what is written uses the new names.
// The branding guard (branding.test.ts) allows the old name in this file only.

/** Prefix of the localStorage keys of 1.14 and earlier (`annalo.sidebar`). */
const OLD_PREFIX = "annalo.";
const NEW_PREFIX = "arcalo.";
/** Set once the keys were copied; later starts skip the copy. */
export const STORAGE_COPIED = "arcalo.storage-copied";

/**
 * Copies every `annalo.*` key to its `arcalo.*` name once (on the first start of 1.15), so the
 * layout, panels, collapsed sections and drafts stay as they were. A key that already has a value
 * under the new name keeps it; the old keys stay (an older version started again finds them).
 * Returns the number of keys copied.
 */
export function copyLegacyStorage(store: Storage | undefined = globalThis.localStorage): number {
  if (!store) return 0;
  try {
    if (store.getItem(STORAGE_COPIED)) return 0;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(OLD_PREFIX)) keys.push(k);
    }
    let copied = 0;
    for (const k of keys) {
      const target = NEW_PREFIX + k.slice(OLD_PREFIX.length);
      const value = store.getItem(k);
      if (value === null || store.getItem(target) !== null) continue;
      store.setItem(target, value);
      copied++;
    }
    store.setItem(STORAGE_COPIED, "1");
    return copied;
  } catch {
    // Storage blocked or full: the defaults apply, as on a first start.
    return 0;
  }
}

/** The settings export format of 1.14 and earlier. */
export const LEGACY_SETTINGS_FORMAT = "annalo-settings";
/** The start page board export format of 1.14 and earlier. */
export const LEGACY_BOARD_FORMAT = "annalo-dashboard";
/** The built-in themes' ids of 1.14 and earlier, and the current ones. */
export const LEGACY_THEME_IDS: Record<string, string> = { "annalo-light": "arcalo-light", "annalo-dark": "arcalo-dark" };

/** The current id of a theme id (the built-in themes of 1.14 and earlier had other ids). */
export const currentThemeId = (id: string) => LEGACY_THEME_IDS[id] ?? id;

/** Both schemes of links to e-mails, for regular expressions: `arcalo-mail` and the old one. */
export const MAIL_SCHEME_SOURCE = `(?:arcalo|annalo)-mail`;
const MAIL_LINK = new RegExp(`^${MAIL_SCHEME_SOURCE}:\\/\\/([0-9a-z]+)\\/?$`, "i");

/** The id of a link to an e-mail (`arcalo-mail://<id>`, or `annalo-mail://<id>` of 1.14), else null. */
export function mailLinkId(href: string | null | undefined): string | null {
  const m = MAIL_LINK.exec((href ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}
