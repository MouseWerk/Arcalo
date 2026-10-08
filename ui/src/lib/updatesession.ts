// „Sitzung nach dem Neustart wiederherstellen“ (Settings → Über → Updates): the tabs, panes and
// the active page live in the stored layout anyway; a restart for an update marks that the next
// start reopens exactly them instead of what Settings → Start would open (today's note, the
// start page). The cursor is not restored: the editor keeps no stored caret position.

const KEY = "arcalo.updateSession";
/** A mark older than this belongs to a restart that never happened (the update failed). */
const VALID_MS = 15 * 60 * 1000;

export function saveUpdateSession(now = Date.now()) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: now }));
  } catch {
    /* storage full or off: the start then follows Settings → Start */
  }
}

/** Whether this start follows „Jetzt neu starten“ (read once). */
export function takeUpdateSession(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    const at = raw ? Number(JSON.parse(raw)?.at) : NaN;
    return Number.isFinite(at) && now - at >= 0 && now - at < VALID_MS;
  } catch {
    return false;
  }
}
