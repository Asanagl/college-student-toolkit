import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const electronState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) =>
      name === "userData" ? electronState.userData : electronState.userData,
    getVersion: () => "0.3.0",
  },
  BrowserWindow: class {},
  dialog: {},
}));

import { dataService } from "../../src/main/services/DataService";

const directories: string[] = [];

function createDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "toolkit-data-service-"),
  );
  directories.push(directory);
  return directory;
}

beforeEach(() => {
  electronState.userData = createDirectory();
});

afterEach(async () => {
  await dataService.dispose();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("DataService", () => {
  it("initializes schema 2, seeds defaults, and exposes all repositories", async () => {
    await dataService.init();

    expect(fs.existsSync(path.join(electronState.userData, "data.db"))).toBe(
      true,
    );
    expect(dataService.getRecordCounts()).toEqual({
      schedules: 0,
      courses: 0,
      exams: 0,
      labs: 0,
      grades: 0,
      formulas: 1,
      periods: 12,
    });
    expect(dataService.formulas.getById("default")?.formula).toBe(
      "SUM(credit * gradePoint) / SUM(credit)",
    );
    expect(dataService.periodConfig.getAll()).toHaveLength(12);
    await dataService.init();
  });

  it("keeps data after closing and reopening the database", async () => {
    await dataService.init();
    const course = dataService.courses.add({
      name: "持久化课程",
      teacher: "教师",
      location: "A101",
      startWeek: 1,
      endWeek: 16,
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
      color: "#4285F4",
    });

    dataService.closeDatabase();
    dataService.reopenAfterTransfer();

    expect(dataService.courses.getById(course.id)).toMatchObject({
      name: "持久化课程",
    });
  });

  it("refuses initialization when an existing database has an unsupported schema", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(electronState.userData, "data.db"));
    db.exec("CREATE TABLE unexpected (id TEXT); PRAGMA user_version = 99;");
    db.close();

    await expect(dataService.init()).rejects.toMatchObject({
      code: "DATABASE_INITIALIZATION_FAILED",
    });
    expect(dataService.getRecordCounts).toBeDefined();
  });
});
