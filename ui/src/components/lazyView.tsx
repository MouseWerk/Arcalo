// Views loaded when first needed (a smaller script at start), and fetched in the background
// once the app is idle: after that they open without a loading state.

import { lazy, type ComponentType, type JSX } from "react";

export interface LazyView<P extends object> {
  (props: P): JSX.Element;
  /** Loads the view's code now (idempotent). */
  preload: () => Promise<unknown>;
}

export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>): LazyView<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = () =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (e) => {
        pending = null;
        throw e;
      },
    ));
  const Lazy = lazy(() => preload().then((c) => ({ default: c })));
  const View = (props: P) => {
    const Loaded = loaded;
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  };
  return Object.assign(View, { preload });
}

/** Loads `views` in the background once the app has settled after the start. */
export function preloadWhenIdle(views: { preload: () => Promise<unknown> }[], delay = 1200) {
  const run = () => views.forEach((v) => v.preload().catch(() => {}));
  const timer = window.setTimeout(() => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
    else run();
  }, delay);
  return () => window.clearTimeout(timer);
}
