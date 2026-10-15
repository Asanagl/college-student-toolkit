import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Unit and component tests intentionally run without Electron.  Main-process
 * tests should inject Electron at their boundary; parser and OCR tests stay
 * pure so they can run on a clean CI runner as well as on Windows.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@renderer": path.resolve(__dirname, "src/renderer"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**", "dist-electron/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage",
      include: [
        "src/shared/gpa.ts",
        "src/main/validation.ts",
        "src/main/preload.ts",
        "src/main/services/parsers/**/*.ts",
        "src/main/services/*OcrParser.ts",
        "src/main/services/repositories/**/*.ts",
        "src/main/services/DatabaseMigrator.ts",
        "src/main/services/DataService.ts",
        "src/main/services/DataTransferService.ts",
        "src/main/services/OcrComponentService.ts",
        "src/main/services/PortableSettingsService.ts",
        "src/main/services/ReminderScheduler.ts",
        "src/main/services/TimetableService.ts",
        "src/main/services/NotificationService.ts",
        "src/main/services/UpdateChannel.ts",
        "src/main/services/ImportBrowserService.ts",
      ],
      exclude: [
        "src/main/services/parsers/**/types.ts",
        "src/main/services/parsers/index.ts",
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
