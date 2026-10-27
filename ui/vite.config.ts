import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { hoverOnly } from "./src/lib/hoverMedia";

// Tauri expects a fixed port in dev and serves the built files in release.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Hover styles only where a pointer can hover: a tap on a touch screen leaves no tinted row
  // and no control shown only on hover (src/lib/hoverMedia.ts; the full app on Android, 1.20).
  css: { postcss: { plugins: [hoverOnly()] } },
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  // Two pages: the desktop app (and its small windows, and the full app on Android's large screens)
  // and the Android phone app, which loads only its own chunks (`mobile.html`, the Android
  // window's address in tauri.android.conf.json; it goes over to `index.html` on a large screen).
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rolldownOptions: { input: { main: resolve(__dirname, "index.html"), mobile: resolve(__dirname, "mobile.html") } },
  },
  // Workers go to their own folder: the CSP allows workers from there (`worker-src`).
  worker: { format: "es", rolldownOptions: { output: { entryFileNames: "workers/[name]-[hash].js", chunkFileNames: "workers/[name]-[hash].js" } } },
});
