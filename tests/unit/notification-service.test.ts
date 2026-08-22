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

  class FakeNotification {
    static supported = true;
    static shown: Array<Record<string, unknown>> = [];

    constructor(options: Record<string, unknown>) {
      FakeNotification.shown.push(options);
    }

    show(): void {}
  }

  return {
    userData: "",
    FakeStore,
    FakeNotification,
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userData },
  Notification: Object.assign(electronState.FakeNotification, {
    isSupported: () => electronState.FakeNotification.supported,
  }),
}));
vi.mock("electron-store", () => ({ default: electronState.FakeStore }));

import { NotificationService } from "../../src/main/services/NotificationService";
import { portableSettingsService } from "../../src/main/services/PortableSettingsService";

const directories: string[] = [];
const defaults: PortableSettings = {
  portableSettingsVersion: 1,
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
};

beforeEach(async () => {
  electronState.userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "toolkit-notify-"),
  );
  directories.push(electronState.userData);
  await portableSettingsService.dispose();
  await portableSettingsService.init();
  portableSettingsService.replace(defaults);
  await NotificationService.getInstance().dispose();
  electronState.FakeNotification.supported = true;
  electronState.FakeNotification.shown = [];
});

afterEach(async () => {
  await NotificationService.getInstance().dispose();
  await portableSettingsService.dispose();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("NotificationService", () => {
  it("records and displays a notification outside DND", async () => {
    const service = NotificationService.getInstance();
    await service.init();

    const result = await service.send({
      title: "测试提醒",
      body: "正文",
      source: "system",
    });

    expect(result).toEqual({ ok: true, data: true });
    expect(electronState.FakeNotification.shown).toHaveLength(1);
    expect(await service.getHistory()).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ delivered: true, title: "测试提醒" })],
    });
  });

  it("suppresses notifications during DND and summarizes them afterwards", async () => {
    const service = NotificationService.getInstance();
    await service.init();
    await service.setDnd({
      enabled: true,
      startTime: "00:00",
      endTime: "00:00",
    });

    expect(
      await service.send({
        title: "静默提醒",
        body: "正文",
        source: "schedule",
      }),
    ).toEqual({ ok: true, data: false });
    expect(electronState.FakeNotification.shown).toHaveLength(0);
    expect(await service.flushDndSummary(new Date(2026, 7, 21, 12, 0))).toEqual(
      {
        ok: true,
        data: false,
      },
    );

    await service.setDnd({
      enabled: false,
      startTime: "00:00",
      endTime: "00:00",
    });
    expect(await service.flushDndSummary(new Date(2026, 7, 21, 12, 0))).toEqual(
      {
        ok: true,
        data: true,
      },
    );
    expect((await service.getHistory()).data?.[0].summarized).toBe(true);
  });

  it("handles unsupported notification hosts, history clearing and uninitialized calls", async () => {
    const service = NotificationService.getInstance();
    expect(await service.getDnd()).toMatchObject({ ok: false });
    expect(await service.setDnd(defaults.dnd)).toMatchObject({ ok: false });
    expect(await service.getHistory()).toMatchObject({ ok: false });
    expect(await service.clearHistory()).toMatchObject({ ok: false });
    expect(
      await service.send({ title: "未初始化", body: "", source: "system" }),
    ).toMatchObject({
      ok: false,
    });
    expect(await service.flushDndSummary()).toMatchObject({ ok: false });
    await service.init();
    await service.init();
    electronState.FakeNotification.supported = false;
    expect(
      await service.send({
        title: "无系统通知",
        body: "正文",
        source: "system",
      }),
    ).toEqual({ ok: true, data: false });
    expect(await service.clearHistory()).toEqual({ ok: true, data: true });
    expect((await service.getHistory()).data).toEqual([]);
    expect(await service.flushDndSummary()).toMatchObject({
      ok: true,
      data: false,
    });
  });

  it("covers disabled, same-day, cross-day and all-day DND intervals", async () => {
    const service = NotificationService.getInstance();
    await service.init();
    const isInDndNow = (
      service as unknown as {
        isInDndNow: (config: PortableSettings["dnd"], date: Date) => boolean;
      }
    ).isInDndNow.bind(service);

    expect(
      isInDndNow(
        { enabled: false, startTime: "09:00", endTime: "12:00" },
        new Date(2026, 7, 21, 10, 0),
      ),
    ).toBe(false);
    expect(
      isInDndNow(
        { enabled: true, startTime: "09:00", endTime: "12:00" },
        new Date(2026, 7, 21, 10, 0),
      ),
    ).toBe(true);
    expect(
      isInDndNow(
        { enabled: true, startTime: "09:00", endTime: "12:00" },
        new Date(2026, 7, 21, 12, 0),
      ),
    ).toBe(false);
    expect(
      isInDndNow(
        { enabled: true, startTime: "22:00", endTime: "08:00" },
        new Date(2026, 7, 21, 23, 0),
      ),
    ).toBe(true);
    expect(
      isInDndNow(
        { enabled: true, startTime: "22:00", endTime: "08:00" },
        new Date(2026, 7, 21, 12, 0),
      ),
    ).toBe(false);
    expect(
      isInDndNow(
        { enabled: true, startTime: "10:00", endTime: "10:00" },
        new Date(2026, 7, 21, 12, 0),
      ),
    ).toBe(true);
    expect(
      isInDndNow(
        { enabled: true, startTime: "bad", endTime: "12:00" },
        new Date(2026, 7, 21, 23, 30),
      ),
    ).toBe(false);
  });

  it("summarizes suppressed history even when native notifications are unavailable", async () => {
    const service = NotificationService.getInstance();
    await service.init();
    await service.setDnd({
      enabled: true,
      startTime: "00:00",
      endTime: "00:00",
    });
    await service.send({ title: "静默", body: "正文", source: "system" });
    await service.setDnd({
      enabled: false,
      startTime: "00:00",
      endTime: "00:00",
    });
    electronState.FakeNotification.supported = false;

    expect(await service.flushDndSummary(new Date(2026, 7, 21, 12, 0))).toEqual(
      { ok: true, data: false },
    );
    expect((await service.getHistory()).data?.[0].summarized).toBe(true);
  });

  it("keeps only the newest 100 notification records and applies portable settings", async () => {
    const service = NotificationService.getInstance();
    await service.init();
    await service.applyPortableSettings();
    for (let index = 0; index < 101; index += 1) {
      await service.send({
        title: `通知 ${index}`,
        body: "正文",
        source: "system",
      });
    }

    const history = await service.getHistory();
    expect(history.data).toHaveLength(100);
    expect(history.data?.[0].title).toBe("通知 100");
  });
});
