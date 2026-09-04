import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PortableSettings } from "../../src/shared/types";

const electronState = vi.hoisted(() => {
  class FakeStore<T extends Record<string, unknown>> {
    private value: T;

    constructor(options: { defaults: T }) {
      this.value = structuredClone(options.defaults);
    }

    get<K extends keyof T>(key: K, fallback?: T[K]): T[K] {
      return this.value[key] ?? (fallback as T[K]);
    }

    set<K extends keyof T>(key: K | T, value?: T[K]): void {
      if (typeof key === "string") this.value[key] = value as T[K];
      else this.value = { ...this.value, ...structuredClone(key) };
    }
  }

  return { userData: "", FakeStore };
});

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userData },
  Notification: { isSupported: () => false },
}));
vi.mock("electron-store", () => ({ default: electronState.FakeStore }));

import { TimetableService } from "../../src/main/services/TimetableService";
import { portableSettingsService } from "../../src/main/services/PortableSettingsService";

const directories: string[] = [];
const defaults: PortableSettings = {
  portableSettingsVersion: 2,
  themeMode: "system",
  timetable: { semesterStart: null },
  dnd: { enabled: false, startTime: "22:00", endTime: "08:00" },
  notificationHistory: [],
  appearance: {
    material: "none",
    backgroundImage: null,
    blurRadius: 0,
    clarity: 100,
  },
  acm: { enabled: true, noticeDismissedVersion: null },
};

beforeEach(async () => {
  electronState.userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "toolkit-timetable-"),
  );
  directories.push(electronState.userData);
  await portableSettingsService.dispose();
  await portableSettingsService.init();
  portableSettingsService.replace(defaults);
  await TimetableService.getInstance().dispose();
});

afterEach(async () => {
  await TimetableService.getInstance().dispose();
  await portableSettingsService.dispose();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("TimetableService", () => {
  it("persists semester preferences and applies portable settings", async () => {
    const service = TimetableService.getInstance();
    expect(service.getPreferences()).toEqual({
      ok: true,
      data: { semesterStart: null },
    });
    await service.init();
    expect(service.getPreferences()).toMatchObject({
      data: { semesterStart: null },
    });
    expect(service.setSemesterStart("2026-08-17")).toMatchObject({
      data: { semesterStart: "2026-08-17" },
    });
    portableSettingsService.update({
      timetable: { semesterStart: "2026-08-24" },
    });
    service.applyPortableSettings();
    expect(service.getPreferences()).toMatchObject({
      data: { semesterStart: "2026-08-24" },
    });
  });

  it("computes weeks and deduplicates a matching course reminder", async () => {
    const service = TimetableService.getInstance();
    const computeWeek = (
      service as unknown as { computeCurrentWeek: (date: Date) => number }
    ).computeCurrentWeek.bind(service);
    expect(computeWeek(new Date(2026, 7, 16))).toBe(0);
    await service.init();
    await service.init();
    service.setSemesterStart("2026-08-17");
    expect(computeWeek(new Date(2026, 7, 16))).toBe(1);
    expect(computeWeek(new Date(2026, 7, 17, 7, 50))).toBe(1);
    expect(computeWeek(new Date(2026, 7, 31, 7, 50))).toBe(3);
    service.setSemesterStart("2026-08-23");
    expect(computeWeek(new Date(2026, 7, 23, 7, 50))).toBe(1);
    service.setSemesterStart("2026-08-17");
    service.setSemesterStart(null);
    expect(computeWeek(new Date(2026, 7, 17))).toBe(0);
    service.setSemesterStart("not-a-date");
    expect(computeWeek(new Date(2026, 7, 17))).toBe(0);
    service.setSemesterStart("2026-08-17");

    const checkAndNotify = (
      service as unknown as {
        checkAndNotify: (
          course: {
            id: string;
            name: string;
            location?: string;
            startWeek: number;
            endWeek: number;
            weekday: number;
            startPeriod: number;
            endPeriod: number;
            color: string;
            createdAt: string;
            updatedAt: string;
          },
          periods: Array<{
            index: number;
            startTime: string;
            endTime: string;
            breakAfter: number;
            isLab: boolean;
            reminderOffset: number;
          }>,
          now: Date,
          currentWeek: number,
        ) => Promise<void>;
      }
    ).checkAndNotify.bind(service);
    const course = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "课程",
      location: "A101",
      startWeek: 1,
      endWeek: 16,
      weekday: 1 as const,
      startPeriod: 1,
      endPeriod: 2,
      color: "#4285F4",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    const periods = [
      {
        index: 1,
        startTime: "08:00",
        endTime: "08:45",
        breakAfter: 10,
        isLab: false,
        reminderOffset: 10,
      },
    ];
    const now = new Date(2026, 7, 17, 7, 50);
    await checkAndNotify(course, periods, now, 1);
    await checkAndNotify(course, periods, now, 1);
    await checkAndNotify(course, periods, now, 2);
    await checkAndNotify(course, periods, now, 1);
    await checkAndNotify(course, [], now, 1);

    await checkAndNotify(course, periods, now, 0);
    await checkAndNotify(course, periods, now, 17);
    await checkAndNotify({ ...course, weekday: 2 as const }, periods, now, 1);
    await checkAndNotify(course, [{ ...periods[0], startTime: "bad" }], now, 1);
    await checkAndNotify(course, periods, new Date(2026, 7, 17, 10, 0), 1);

    await checkAndNotify(
      { ...course, id: "22222222-2222-4222-8222-222222222222", weekday: 7 },
      periods,
      new Date(2026, 7, 23, 7, 50),
      1,
    );

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await (service as unknown as { tick: () => Promise<void> }).tick();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("keeps pre-initialization preferences safe", async () => {
    const service = TimetableService.getInstance();
    expect(service.setSemesterStart("2026-08-17")).toMatchObject({
      ok: true,
      data: { semesterStart: null },
    });
    service.applyPortableSettings();
  });
});
