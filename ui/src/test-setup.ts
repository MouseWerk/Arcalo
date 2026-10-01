// Unit tests run in German by default (most of them check German texts and typed German
// syntax); tests of the English texts switch with `setLang("en")`.

import { beforeEach } from "vitest";
import { setLang } from "./lib/i18n";
import { setFormatPrefs } from "./lib/format";

beforeEach(() => {
  setLang("de");
  setFormatPrefs({ lang: "de", dateFormat: "de", numberFormat: "comma", weekStartsOn: 1, hours: "decimal" });
});
