import { describe, expect, it } from "vitest";
import { decompressFromBase64, parseDrawing } from "./drawingFormat";

// `LZString.compressToBase64`, as Obsidian's Excalidraw plugin writes it (test helper).
function compressToBase64(input: string): string {
  const KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const bitsPerChar = 6;
  const dict = new Map<string, number>();
  const toCreate = new Set<string>();
  let w = "";
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const out: string[] = [];
  let val = 0;
  let pos = 0;
  const bit = (b: number) => {
    val = (val << 1) | b;
    if (pos === bitsPerChar - 1) {
      pos = 0;
      out.push(KEY.charAt(val));
      val = 0;
    } else pos++;
  };
  const bitsOf = (value: number, n: number) => {
    for (let i = 0; i < n; i++) {
      bit(value & 1);
      value >>= 1;
    }
  };
  const emit = (s: string) => {
    if (toCreate.has(s)) {
      const code = s.charCodeAt(0);
      if (code < 256) {
        bitsOf(0, numBits);
        bitsOf(code, 8);
      } else {
        bitsOf(1, numBits);
        bitsOf(code, 16);
      }
      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = 1 << numBits;
        numBits++;
      }
      toCreate.delete(s);
    } else bitsOf(dict.get(s)!, numBits);
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 1 << numBits;
      numBits++;
    }
  };
  for (const c of input) {
    if (!dict.has(c)) {
      dict.set(c, dictSize++);
      toCreate.add(c);
    }
    const wc = w + c;
    if (dict.has(wc)) w = wc;
    else {
      emit(w);
      dict.set(wc, dictSize++);
      w = c;
    }
  }
  if (w !== "") emit(w);
  bitsOf(2, numBits);
  for (;;) {
    val <<= 1;
    if (pos === bitsPerChar - 1) {
      out.push(KEY.charAt(val));
      break;
    }
    pos++;
  }
  const res = out.join("");
  return res + ["", "===", "==", "="][res.length % 4];
}

const scene = { type: "excalidraw", version: 2, elements: [{ id: "a", type: "rectangle", x: 1, y: 2 }], appState: { viewBackgroundColor: "#ffffff" }, files: {} };

describe("parseDrawing", () => {
  it("reads Excalidraw JSON", () => {
    expect(parseDrawing(JSON.stringify(scene))).toEqual({ ok: true, scene, converted: false });
    expect(parseDrawing("")).toEqual({ ok: true, scene: { elements: [] }, converted: false });
  });

  it("reports a truncated or foreign file instead of starting empty", () => {
    const cut = JSON.stringify(scene).slice(0, 40);
    expect(parseDrawing(cut)).toMatchObject({ ok: false, reason: expect.stringMatching(/beschädigt/) });
    expect(parseDrawing('{"hallo": 1}')).toMatchObject({ ok: false, reason: expect.stringMatching(/keine Excalidraw/) });
    expect(parseDrawing("irgendein Text")).toMatchObject({ ok: false, reason: expect.stringMatching(/unbekannt/) });
  });

  it("reads Obsidian's compressed-json and json forms", () => {
    const b64 = compressToBase64(JSON.stringify(scene));
    expect(decompressFromBase64(b64)).toBe(JSON.stringify(scene));
    // The plugin wraps the data in lines.
    const wrapped = b64.replace(/(.{64})/g, "$1\n\n");
    const md = `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n## Text Elements\n%%\n## Drawing\n\`\`\`compressed-json\n${wrapped}\n\`\`\`\n%%`;
    expect(parseDrawing(md)).toEqual({ ok: true, scene, converted: true });
    const plain = `## Drawing\n\`\`\`json\n${JSON.stringify(scene)}\n\`\`\`\n`;
    expect(parseDrawing(plain)).toEqual({ ok: true, scene, converted: true });
    expect(parseDrawing("## Drawing\n```compressed-json\nNICHTS\n```")).toMatchObject({ ok: false });
  });

  it("decompresses text with umlauts and long repetitions", () => {
    const text = "Größe äöü ß € ".repeat(200) + "終わり";
    expect(decompressFromBase64(compressToBase64(text))).toBe(text);
  });
});
