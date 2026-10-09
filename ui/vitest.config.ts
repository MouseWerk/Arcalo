import { defineConfig } from "vitest/config";

// One time zone for every machine: German local time, so the clock changes (DST) are tested.
process.env.TZ = "Europe/Berlin";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    // Some tests drive a whole editor or scan every stylesheet (1-2 s alone); next to a Rust build
    // they took over the 5 s default. Budgets that matter are asserted in the tests themselves.
    testTimeout: 20_000,
  },
});
