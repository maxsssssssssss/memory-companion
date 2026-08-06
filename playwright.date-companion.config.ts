import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.DATE_COMPANION_E2E_BASE_URL ?? "http://127.0.0.1:3210";
const testMatch = process.env.DATE_COMPANION_E2E_SPEC ?? "date-companion-fixture.spec.ts";
const outputDir = process.env.DATE_COMPANION_E2E_ARTIFACT_DIR
  ? `${process.env.DATE_COMPANION_E2E_ARTIFACT_DIR}/playwright`
  : "test-results/date-companion-fixture";

export default defineConfig({
  testDir: "./e2e",
  testMatch,
  timeout: 240_000,
  expect: {
    timeout: 20_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
