import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeTriggerTime,
  parseLocalDateTime,
  ReminderScheduler,
  type ReminderDataSource,
  type ReminderNotificationSink,
  type ReminderTimetableSource,
} from "../../src/main/services/ReminderScheduler";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  Notification: { isSupported: () => false },
}));

const tempPaths: string[] = [];

function createFixture(
  now: Date,
  semesterStart: string | null,
): {
  data: ReminderDataSource;
  notifications: ReminderNotificationSink;
  timetable: ReminderTimetableSource;
  delivered: string[];
  flushed: Date[];
} {
  const delivered: string[] = [];
  const flushed: Date[] = [];
  const data: ReminderDataSource = {
    schedules: { list: () => [] },
    exams: { list: () => [] },
    labs: { list: () => [] },
    courses: {
      list: () => [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "离散数学",
          startWeek: 1,
          endWeek: 16,
          weekday: 5,
          startPeriod: 1,
          endPeriod: 2,
          color: "#4285F4",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
    },
    periodConfig: {
      getAll: () => [
        {
          index: 1,
          startTime: "10:00",
          endTime: "10:45",
          breakAfter: 10,
          isLab: false,
          reminderOffset: 10,
        },
      ],
    },
  };
  const notifications: ReminderNotificationSink = {
    send: async (payload) => {
      delivered.push(payload.source);
      return { ok: true, data: true };
    },
    flushDndSummary: async (time) => {
      flushed.push(time);
      return { ok: true, data: false };
    },
  };
  const timetable: ReminderTimetableSource = {
    getPreferences: () => ({ ok: true, data: { semesterStart } }),
  };
  return { data, notifications, timetable, delivered, flushed };
}

function createStatePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-reminder-"));
  tempPaths.push(directory);
  return path.join(directory, "reminder-state.json");
}

afterEach(() => {
  while (tempPaths.length > 0)
    fs.rmSync(tempPaths.pop() as string, { recursive: true, force: true });
});

describe("ReminderScheduler", () => {
  it("triggers a course reminder once and persists the deduplication key", async () => {
    const now = new Date(2026, 7, 21, 9, 50, 0);
    const fixture = createFixture(now, "2026-08-17");
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });

    await scheduler.init();
    await scheduler.recompute();
    await scheduler.dispose();

    expect(fixture.delivered).toEqual(["timetable"]);
    expect(fixture.flushed).toHaveLength(2);
    expect(
      JSON.parse(
        fs.readFileSync(
          (scheduler as unknown as { statePath: string }).statePath,
          "utf8",
        ),
      ).sent,
    ).not.toEqual({});
  });

  it("does not schedule courses before the semester or for invalid event times", async () => {
    const now = new Date(2026, 7, 21, 9, 50, 0);
    const fixture = createFixture(now, null);
    fixture.data.exams.list = () => [
      {
        id: "22222222-2222-4222-8222-222222222222",
        courseName: "非法考试",
        date: "2026-02-31",
        startTime: "10:00",
        endTime: "11:00",
        reminderOffsets: [10],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });

    await scheduler.init();
    await scheduler.dispose();

    expect(fixture.delivered).toEqual([]);
  });

  it("delivers all four reminder sources and includes optional locations", async () => {
    const now = new Date(2026, 7, 21, 9, 50, 0);
    const fixture = createFixture(now, "2026-08-17");
    const eventDate = "2026-08-21";
    const eventTime = "10:00";
    fixture.data.schedules.list = () => [
      {
        id: "33333333-3333-4333-8333-333333333333",
        title: "日程",
        startTime: new Date(2026, 7, 21, 10, 0).toISOString(),
        endTime: new Date(2026, 7, 21, 11, 0).toISOString(),
        reminderOffset: 10,
        repeatRule: "none",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    fixture.data.exams.list = () => [
      {
        id: "44444444-4444-4444-8444-444444444444",
        courseName: "考试",
        date: eventDate,
        startTime: eventTime,
        endTime: "11:00",
        location: "教学楼",
        reminderOffsets: [10],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    fixture.data.labs.list = () => [
      {
        id: "55555555-5555-4555-8555-555555555555",
        name: "实验",
        date: eventDate,
        startTime: eventTime,
        endTime: "11:00",
        location: "实验楼",
        reminderOffsets: [10],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    fixture.data.courses.list = () => [
      {
        id: "66666666-6666-4666-8666-666666666666",
        name: "课程",
        location: "一教",
        startWeek: 1,
        endWeek: 16,
        weekday: 5,
        startPeriod: 1,
        endPeriod: 2,
        color: "#4285F4",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });

    await scheduler.init();

    expect(fixture.delivered).toEqual(["schedule", "exam", "lab", "timetable"]);
    await scheduler.dispose();
  });

  it("supports daily, weekly and month-end occurrences", async () => {
    const now = new Date(2026, 7, 21, 9, 50, 0);
    const fixture = createFixture(now, null);
    fixture.data.courses.list = () => [];
    fixture.data.schedules.list = () => [
      {
        id: "77777777-7777-4777-8777-777777777777",
        title: "每日",
        startTime: new Date(2026, 7, 20, 10, 0).toISOString(),
        endTime: new Date(2026, 7, 20, 11, 0).toISOString(),
        reminderOffset: 10,
        repeatRule: "daily",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        title: "每周",
        startTime: new Date(2026, 7, 14, 10, 0).toISOString(),
        endTime: new Date(2026, 7, 14, 11, 0).toISOString(),
        reminderOffset: 10,
        repeatRule: "weekly",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        title: "每月",
        startTime: new Date(2026, 6, 21, 10, 0).toISOString(),
        endTime: new Date(2026, 6, 21, 11, 0).toISOString(),
        reminderOffset: 10,
        repeatRule: "monthly",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });

    await scheduler.init();

    expect(fixture.delivered).toHaveLength(3);
  });

  it("filters invalid dates, semester ranges, weekdays and missing periods", async () => {
    const now = new Date(2026, 7, 21, 9, 50, 0);
    const fixture = createFixture(now, "not-a-date");
    fixture.data.schedules.list = () => [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "无效日程",
        startTime: "not-a-date",
        endTime: "not-a-date",
        reminderOffset: 10,
        repeatRule: "none",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    fixture.data.labs.list = () => [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "无效实验",
        date: "2026-02-31",
        startTime: "10:00",
        endTime: "11:00",
        reminderOffsets: [10],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    fixture.data.periodConfig.getAll = () => [];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });

    await scheduler.init();

    expect(fixture.delivered).toEqual([]);
    expect(parseLocalDateTime("2026-02-31", "10:00")).toBeNull();
    expect(parseLocalDateTime("2026-08-21", "25:00")).toBeNull();
    expect(parseLocalDateTime("bad", "bad")).toBeNull();
    expect(computeTriggerTime(now, 10).getTime()).toBe(
      now.getTime() - 10 * 60_000,
    );
  });

  it("does not persist a failed delivery and retries it on the next scan", async () => {
    const now = new Date(2026, 7, 21, 9, 50, 0);
    const fixture = createFixture(now, null);
    fixture.data.courses.list = () => [];
    fixture.data.schedules.list = () => [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        title: "重试提醒",
        startTime: new Date(2026, 7, 21, 10, 0).toISOString(),
        endTime: new Date(2026, 7, 21, 11, 0).toISOString(),
        reminderOffset: 10,
        repeatRule: "none",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    let attempts = 0;
    fixture.notifications.send = async (payload) => {
      attempts += 1;
      fixture.delivered.push(payload.source);
      return attempts === 1
        ? { ok: false, error: "通知失败" }
        : { ok: true, data: true };
    };
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });

    await scheduler.init();
    await scheduler.recompute();

    expect(attempts).toBe(2);
    expect(fixture.delivered).toEqual(["schedule", "schedule"]);
  });

  it("prunes stale and malformed state and keeps the timer lifecycle safe", async () => {
    const now = new Date(2026, 7, 21, 9, 50, 0);
    const statePath = createStatePath();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        sent: {
          stale: new Date(now.getTime() - 31 * 24 * 60 * 60_000).toISOString(),
          malformed: "not-a-timestamp",
          numeric: 123,
          recent: new Date(now.getTime() - 60_000).toISOString(),
        },
      }),
    );
    const fixture = createFixture(now, null);
    fixture.data.courses.list = () => [];
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath,
      setTimeout: (handler) => {
        callbacks.push(handler);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle) => cleared.push(handle),
    });

    await scheduler.init();
    await scheduler.init();
    expect(callbacks).toHaveLength(1);
    callbacks[0]();
    await Promise.resolve();
    await scheduler.dispose();
    expect(cleared.length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).sent).toEqual({
      recent: expect.any(String),
    });
  });

  it("handles future semesters, Sunday courses, missing periods and out-of-window events", async () => {
    const now = new Date(2026, 7, 23, 9, 50, 0);
    const futureFixture = createFixture(now, "2026-09-01");
    futureFixture.data.courses.list = () => [];
    const futureScheduler = new ReminderScheduler({
      dataService: futureFixture.data,
      notificationService: futureFixture.notifications,
      timetableService: futureFixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });
    await futureScheduler.init();
    expect(futureFixture.delivered).toEqual([]);
    await futureScheduler.dispose();

    const fixture = createFixture(now, "2026-08-17");
    fixture.data.courses.list = () => [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "周日课程",
        startWeek: 1,
        endWeek: 2,
        weekday: 7,
        startPeriod: 1,
        endPeriod: 1,
        color: "#4285F4",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "超出周次",
        startWeek: 9,
        endWeek: 10,
        weekday: 7,
        startPeriod: 1,
        endPeriod: 1,
        color: "#4285F4",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        name: "缺少节次",
        startWeek: 1,
        endWeek: 2,
        weekday: 7,
        startPeriod: 9,
        endPeriod: 9,
        color: "#4285F4",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ];
    fixture.data.periodConfig.getAll = () => [
      {
        index: 1,
        startTime: "bad",
        endTime: "10:45",
        breakAfter: 10,
        isLab: false,
        reminderOffset: 10,
      },
    ];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => now,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });
    await scheduler.init();
    expect(fixture.delivered).toEqual([]);
    await scheduler.recompute();
    await scheduler.dispose();

    const nearest = (
      scheduler as unknown as {
        nearestOccurrence: (
          start: Date,
          rule: string,
          value: Date,
        ) => Date | null;
      }
    ).nearestOccurrence(new Date(2026, 7, 21, 10, 0), "corrupt", now);
    expect(nearest).toBeNull();

    const uninitialized = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      statePath: "",
    });
    await uninitialized.recompute();
    await uninitialized.dispose();
  });

  it("补扫上一次扫描到当前时间之间的休眠窗口", async () => {
    let currentNow = new Date(2026, 7, 21, 9, 0, 0);
    const fixture = createFixture(currentNow, null);
    fixture.data.courses.list = () => [];
    fixture.data.exams.list = () => [
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        courseName: "休眠窗口考试",
        date: "2026-08-21",
        startTime: "10:00",
        endTime: "11:00",
        reminderOffsets: [0],
        createdAt: currentNow.toISOString(),
        updatedAt: currentNow.toISOString(),
      },
    ];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => currentNow,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });

    await scheduler.init();
    expect(fixture.delivered).toEqual([]);
    currentNow = new Date(2026, 7, 21, 10, 1, 0);
    await scheduler.recompute();

    expect(fixture.delivered).toEqual(["exam"]);
    expect(
      JSON.parse(
        fs.readFileSync(
          (scheduler as unknown as { statePath: string }).statePath,
          "utf8",
        ),
      ).lastScan,
    ).toBe(currentNow.toISOString());
    await scheduler.dispose();
  });

  it("合并并发重算，避免同一提醒在异步发送期间重复投递", async () => {
    let currentNow = new Date(2026, 7, 21, 9, 0, 0);
    const fixture = createFixture(currentNow, null);
    fixture.data.courses.list = () => [];
    fixture.data.exams.list = () => [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        courseName: "并发考试",
        date: "2026-08-21",
        startTime: "10:00",
        endTime: "11:00",
        reminderOffsets: [0],
        createdAt: currentNow.toISOString(),
        updatedAt: currentNow.toISOString(),
      },
    ];
    const scheduler = new ReminderScheduler({
      dataService: fixture.data,
      notificationService: fixture.notifications,
      timetableService: fixture.timetable,
      now: () => currentNow,
      statePath: createStatePath(),
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    });
    await scheduler.init();

    let release: (() => void) | undefined;
    let calls = 0;
    const sendStarted = new Promise<void>((resolve) => {
      fixture.notifications.send = async () => {
        calls += 1;
        resolve();
        await new Promise<void>((wait) => {
          release = wait;
        });
        return { ok: true, data: true };
      };
    });
    currentNow = new Date(2026, 7, 21, 10, 0, 0);
    const first = scheduler.recompute();
    const second = scheduler.recompute();
    await sendStarted;
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    await scheduler.dispose();
  });
});
