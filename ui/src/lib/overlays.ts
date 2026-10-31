// Whether something over the views has the keys: a dialog, a menu, the palette, a date picker, a
// select's list or the issue view. A view's own window shortcuts (the calendar's Esc, arrows, `n`)
// stay quiet then; the issue view (`.iv`) was missing, so Esc there cleared the calendar's selection
// instead of closing the issue.

export const OVERLAYS = ".dialog, .menu, .palette, .calendar, .select-pop, .iv";

export const overlayOpen = () => !!document.querySelector(OVERLAYS);
