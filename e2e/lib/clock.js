// The window's clock moved forward, as for a window left open overnight: `Date` in the page
// (`new Date()`, `Date.now()`) runs `ms` ahead of the real time. Timers keep the real pace, and
// the core keeps the real time, so this tests what the window computes from the date (the day
// it shows, „Heute“, overdue), not what the core does at midnight (Rust tests do that).

/** Puts the window's clock `ms` ahead of the real time (replacing an earlier shift). */
export async function shiftWindowClock(app, ms) {
  await app.browser.execute((offset) => {
    if (!window.__arcaloClock) {
      const Real = Date;
      const clock = { offset: 0 };
      class Shifted extends Real {
        constructor(...args) {
          if (args.length === 0) super(Real.now() + clock.offset);
          else super(...args);
        }
        static now() {
          return Real.now() + clock.offset;
        }
      }
      window.Date = Shifted;
      window.__arcaloClock = clock;
    }
    window.__arcaloClock.offset = offset;
  }, ms);
}

/** The window's local date (YYYY-MM-DD) at its shifted clock. */
export async function windowDay(app) {
  return app.browser.execute(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
}
