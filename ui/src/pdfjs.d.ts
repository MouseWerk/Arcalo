// pdf.js ships no types for its worker module; lib/pdf.ts only preloads it for the main-thread "fake worker".
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
