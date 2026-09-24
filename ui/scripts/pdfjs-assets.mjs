// Copies what pdf.js loads at run time into public/pdfjs/ so PDFs render offline (see
// src/lib/pdf.ts): the standard fonts (PDFs that use Helvetica, Times, … without embedding
// them) and the JavaScript fallbacks of the JPEG 2000 / JBIG2 image decoders. The WebAssembly
// builds are left out: the app's CSP does not allow WebAssembly, pdf.js falls back to the
// JavaScript decoders. CMaps for CJK fonts that are not embedded are left out too (1.7 MB).
// Runs before `vite` and `vite build`.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(ui, "node_modules/pdfjs-dist");
const out = join(ui, "public/pdfjs");

if (!existsSync(src)) {
  console.error(`pdfjs-dist not found at ${src} (npm install?)`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(join(src, "standard_fonts"), join(out, "standard_fonts"), { recursive: true });
mkdirSync(join(out, "wasm"), { recursive: true });
for (const f of ["openjpeg_nowasm_fallback.js", "jbig2_nowasm_fallback.js", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_JBIG2", "LICENSE_OPENJPEG", "LICENSE_JBIG2"]) {
  cpSync(join(src, "wasm", f), join(out, "wasm", f));
}
