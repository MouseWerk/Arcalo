// Startup animation (markup and styles in index.html): takes the last theme and accent color,
// stays until the animation has played and the app is ready, then fades out. Skipped in the
// quick-capture/search windows, when switched off (Settings → Darstellung) and under WebDriver.

const KEY = "annalo.splash";
/** How long the mark needs to draw itself and show the name. */
const MIN_MS = 1300;
const FADE_MS = 450;

interface SplashPrefs {
  dark?: boolean;
  accent?: string;
  off?: boolean;
  reduced?: boolean;
}

function read(): SplashPrefs {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as SplashPrefs;
  } catch {
    return {};
  }
}

let last = "";
/** Remembered for the next start; merged with what is stored, written only on a change. */
export function rememberSplash(p: SplashPrefs) {
  const next = JSON.stringify({ ...read(), ...p });
  if (next === last) return;
  last = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private mode or full storage: the next start uses the system colors.
  }
}

let onShown: (() => void) | null = null;

/** The window is on screen: the logo starts drawing itself now. */
export function splashShown() {
  onShown?.();
  onShown = null;
}

export function startSplash(popup: boolean) {
  const el = document.getElementById("splash");
  if (!el) return;
  const p = read();
  const forced = localStorage.getItem("annalo.splash-test") === "1";
  if (popup || p.off || (navigator.webdriver && !forced)) {
    el.remove();
    return;
  }
  if (p.dark !== undefined) el.dataset.theme = p.dark ? "dark" : "light";
  if (p.accent) el.style.setProperty("--splash-accent", p.accent);
  if (p.reduced) el.dataset.reduced = "";
  // The window is still hidden: the animation waits for `splashShown` (splash.css pauses it).
  let started = performance.now();
  onShown = () => {
    started = performance.now();
    el.classList.add("go");
  };
  let done = false;
  const hide = () => {
    if (done) return;
    done = true;
    const wait = p.reduced ? 250 : Math.max(0, MIN_MS - (performance.now() - started));
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), FADE_MS);
    }, wait);
  };
  // The app marks itself ready (body.ready) once settings and the workspace are loaded.
  const watch = new MutationObserver(() => document.body.classList.contains("ready") && (watch.disconnect(), hide()));
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // Never longer than this, whatever happens during loading.
  setTimeout(() => (watch.disconnect(), hide()), 8000);
}
