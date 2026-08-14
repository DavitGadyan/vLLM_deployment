import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * End-to-end tests run against the real stack (`make dev`), not mocks.
 *
 * The behaviours worth testing here — a config change altering an answer,
 * escalation instead of a hallucination, a citation resolving to its source —
 * all depend on the backend, the vector store and the model agreeing. Mocking
 * any of those would leave the test asserting the mock.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Generation on a single L4 can take a few seconds under load.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  // Model responses are the slow part; the default 30s is not enough headroom.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
