import { defineConfig } from "vitest/config";

// One time zone for every machine: German local time, so the clock changes (DST) are tested.
process.env.TZ = "Europe/Berlin";

export default defineConfig({
  test: { environment: "happy-dom", include: ["src/**/*.test.ts"], setupFiles: ["src/test-setup.ts"] },
});
