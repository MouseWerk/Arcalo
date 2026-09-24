// Reading a drawing file: Excalidraw's JSON, or the Markdown form of Obsidian's Excalidraw
// plugin (a `json` or `compressed-json` block under `## Drawing`). Anything else is reported
// as damaged or unknown, so the editor never starts empty over it and overwrites it.

export interface Scene {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export type DrawingLoad =
  | { ok: true; scene: Scene; /** Read from Obsidian's Markdown form (saving writes Excalidraw JSON). */ converted: boolean }
  | { ok: false; reason: string };

const isScene = (v: unknown): v is Scene => !!v && typeof v === "object" && Array.isArray((v as Scene).elements);

function fromJson(text: string, converted: boolean): DrawingLoad {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "Die Datei ist beschädigt (unvollständig oder kein gültiges JSON)." };
  }
  return isScene(value) ? { ok: true, scene: value, converted } : { ok: false, reason: "Die Datei ist keine Excalidraw-Zeichnung (es fehlen die Elemente)." };
}

export function parseDrawing(raw: string): DrawingLoad {
  const text = raw.replace(/^﻿/, "").trim();
  if (!text) return { ok: true, scene: { elements: [] }, converted: false };
  if (text.startsWith("{")) return fromJson(text, false);
  // Obsidian Excalidraw: `## Drawing` followed by a fenced block.
  const compressed = /```compressed-json[^\n]*\n([\s\S]*?)```/.exec(text);
  if (compressed) {
    const json = decompressFromBase64(compressed[1].replace(/\s+/g, ""));
    if (!json) return { ok: false, reason: "Die komprimierte Zeichnung (Obsidian) ist beschädigt." };
    return fromJson(json, true);
  }
  const plain = /```json[^\n]*\n([\s\S]*?)```/.exec(text);
  if (plain) return fromJson(plain[1], true);
  return { ok: false, reason: "Das Format der Datei ist unbekannt." };
}

// ------------------------------------------------ lz-string (compressToBase64 counterpart)

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** `LZString.decompressFromBase64` (what Obsidian's plugin writes); null when damaged. */
export function decompressFromBase64(input: string): string | null {
  if (!input) return "";
  const index = new Map([...BASE64].map((c, i) => [c, i]));
  for (const c of input) if (!index.has(c)) return null;
  return decompress(input.length, 32, (i) => index.get(input.charAt(i)) ?? 0);
}

function decompress(length: number, resetValue: number, next: (i: number) => number): string | null {
  const dictionary: string[] = ["", "", ""];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  const result: string[] = [];
  const data = { val: next(0), position: resetValue, index: 1 };
  const read = (n: number) => {
    let bits = 0;
    for (let power = 1; power !== 1 << n; power <<= 1) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = next(data.index++);
      }
      if (resb > 0) bits |= power;
    }
    return bits;
  };
  let c: string;
  switch (read(2)) {
    case 0:
      c = String.fromCharCode(read(8));
      break;
    case 1:
      c = String.fromCharCode(read(16));
      break;
    default:
      return "";
  }
  dictionary[3] = c;
  let w = c;
  result.push(c);
  for (;;) {
    if (data.index > length) return null;
    let code = read(numBits);
    if (code === 0 || code === 1) {
      dictionary[dictSize++] = String.fromCharCode(read(code === 0 ? 8 : 16));
      code = dictSize - 1;
      enlargeIn--;
    } else if (code === 2) return result.join("");
    if (enlargeIn === 0) {
      enlargeIn = 1 << numBits;
      numBits++;
    }
    let entry: string;
    if (code < dictSize && dictionary[code] !== undefined && code > 2) entry = dictionary[code];
    else if (code === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) {
      enlargeIn = 1 << numBits;
      numBits++;
    }
  }
}
