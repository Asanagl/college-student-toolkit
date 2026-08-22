import { defineConfig } from "@playwright/test";

/**
 * Electron E2E is kept as a separate project because it needs a packaged
 * executable and a Windows runner.  The smoke placeholder is deliberately
 * skipped until a packaged RC path is supplied by the release pipeline.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  projects: [
    {
      name: "electron",
      testMatch: /.*\.spec\.ts/,
      testIgnore: /.*\.packaged\.spec\.ts/,
    },
    {
      name: "packaged",
      testMatch: /.*\.packaged\.spec\.ts/,
    },
  ],
});
