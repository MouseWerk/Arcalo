// Key presses that belong to an input-method composition (Japanese, Chinese, dead keys like
// ⌥U for umlauts on a Mac). They finish the text being composed and must not submit or close.
// Every key handler that acts on Enter or Escape asks here first (a test checks it).

type KeyLike = { key?: string; code?: string; isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } };

/**
 * Whether a keydown (DOM or React event) is part of a composition. WebKit (macOS) sends the
 * Enter or Esc that ends a composition after `compositionend`, so `isComposing` is already false
 * there; its keyCode is still 229 („processed by the input method“).
 */
export function isComposing(e: KeyLike): boolean {
  const n = e.nativeEvent ?? e;
  return !!n.isComposing || n.keyCode === 229 || e.keyCode === 229;
}

/** `e.key === key` outside a composition: the Enter that submits, the Escape that cancels. */
export function isKey(e: KeyLike, key: string): boolean {
  return e.key === key && !isComposing(e);
}

/**
 * The Tab key, also with Shift: WebKitGTK (Linux) sends Shift+Tab as ISO_Left_Tab, whose key is
 * "Unidentified"; the code still says Tab. Every Tab handler asks here (a test checks it).
 */
export function isTab(e: KeyLike): boolean {
  return e.key === "Tab" || e.code === "Tab";
}
