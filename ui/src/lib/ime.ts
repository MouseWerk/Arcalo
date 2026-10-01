// Key presses that belong to an input-method composition (Japanese, Chinese, dead keys like
// ⌥U for umlauts on a Mac). They finish the text being composed and must not submit or close.

/**
 * Whether a keydown is part of a composition. WebKit (macOS) sends the Enter or Esc that ends a
 * composition after `compositionend`, so `isComposing` is already false there; its keyCode is
 * still 229 („processed by the input method“).
 */
export function isComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}
