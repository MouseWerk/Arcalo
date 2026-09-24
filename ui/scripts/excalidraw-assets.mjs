// Copies Excalidraw's fonts into public/excalidraw-assets/ so drawings work offline:
// the package would otherwise fetch them from a CDN (window.EXCALIDRAW_ASSET_PATH
// points here, see src/editor/DrawingEditor.tsx). Runs before `vite` and `vite build`.
// Xiaolai (13 MB, Chinese/Japanese/Korean glyphs) is left out; such text falls back
// to a system font.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(ui, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const out = join(ui, "public/excalidraw-assets/fonts");
const SKIP = new Set(["Xiaolai"]);

if (!existsSync(src)) {
  console.error(`Excalidraw fonts not found at ${src} (npm install?)`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true, filter: (p) => !SKIP.has(p.slice(src.length + 1).split(/[\\/]/)[0]) });
