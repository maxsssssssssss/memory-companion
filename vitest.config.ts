import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Developer credentials and historical acceptance snapshots are not test inputs.
  envDir: false,
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: [
      ...configDefaults.exclude,
      "e2e/**", ".data/**", "output/**", "reports/**", "tmp/**",
      "test-results/**", "playwright-report/**",
      // These have their own Node runners, not Vitest suites.
      "scripts/lib/work-review-evaluation-diagnostics.test.mjs",
      "scripts/learning-local/*.test.mjs",
      "scripts/cloud/*.test.mjs",
      "scripts/lib/owned-process.test.mjs",
      "scripts/learning-mode-comparison/native-fetch.test.mjs"
    ],
    globals: true,
    setupFiles: ["./src/test/setup.ts"]
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
