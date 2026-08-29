import { defineConfig } from "@playwright/test";

/**
 * Electron E2E is kept as a separate project because it needs a packaged
 * executable and a Windows runner. The packaged project uses the local RC by
 * default and accepts PACKAGED_EXECUTABLE for release-pipeline validation.
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
