import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port in dev and serves the built files in release.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  // Workers go to their own folder: the CSP allows workers from there (`worker-src`).
  worker: { format: "es", rolldownOptions: { output: { entryFileNames: "workers/[name]-[hash].js", chunkFileNames: "workers/[name]-[hash].js" } } },
});
