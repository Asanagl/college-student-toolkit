import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const electronState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userData },
}));

import { PortableSettingsService } from "../../src/main/services/PortableSettingsService";

const tempPaths: string[] = [];

function createDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-settings-"));
  tempPaths.push(directory);
  return directory;
}

describe("PortableSettingsService", () => {
  let service: PortableSettingsService;

  beforeEach(() => {
    electronState.userData = createDirectory();
    service = PortableSettingsService.getInstance();
  });

  afterEach(async () => {
    await service.dispose();
    for (const directory of tempPaths.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  it("creates portable defaults without importing machine-only state", async () => {
    expect(service.getFilePath()).toBe(
      path.join(electronState.userData, "portable-settings.json"),
    );
    await service.init();

    expect(service.get()).toMatchObject({
      portableSettingsVersion: 2,
      acm: { enabled: true },
      timetable: { semesterStart: null },
      notificationHistory: [],
    });
    expect(
      fs.existsSync(
        path.join(electronState.userData, "portable-settings.json"),
      ),
    ).toBe(true);
  });

  it("normalizes a valid current snapshot and preserves nested updates", async () => {
    const settingsPath = path.join(
      electronState.userData,
      "portable-settings.json",
    );
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        portableSettingsVersion: 1,
        themeMode: "light",
        timetable: { semesterStart: "2026-03-02" },
        dnd: { enabled: true, startTime: "23:00", endTime: "07:00" },
        notificationHistory: [
          {
            id: "history-1",
            title: "提醒",
            body: "内容",
            source: "system",
            timestamp: "2026-03-02T00:00:00.000Z",
            delivered: true,
          },
        ],
        appearance: {
          material: "acrylic",
          backgroundImage: "scene.png",
          blurRadius: 18,
          clarity: 82,
        },
      }),
    );

    await service.init();
    expect(service.get()).toMatchObject({
      portableSettingsVersion: 2,
      themeMode: "light",
      timetable: { semesterStart: "2026-03-02" },
      notificationHistory: [{ id: "history-1" }],
      appearance: { backgroundImage: "scene.png", blurRadius: 18 },
      acm: { enabled: true },
    });

    service.update({ themeMode: "dark" });
    expect(service.get().themeMode).toBe("dark");
  });

  it("migrates legacy settings and removes only the obsolete hard-coded semester date", async () => {
    fs.writeFileSync(
      path.join(electronState.userData, "theme-preference.json"),
      JSON.stringify({ mode: "dark" }),
    );
    fs.writeFileSync(
      path.join(electronState.userData, "timetable.json"),
      JSON.stringify({ semesterStart: "2025-09-01" }),
    );
    fs.writeFileSync(
      path.join(electronState.userData, "appearance-preference.json"),
      JSON.stringify({
        material: "acrylic",
        backgroundImage: "scene.png",
        blurRadius: 18,
        clarity: 82,
      }),
    );
    fs.writeFileSync(
      path.join(electronState.userData, "notification.json"),
      JSON.stringify({
        dnd: { enabled: true, startTime: "23:00", endTime: "07:00" },
        notificationHistory: [
          {
            id: "legacy-history",
            title: "提醒",
            body: "内容",
            source: "system",
            timestamp: "2026-02-01T00:00:00.000Z",
            delivered: true,
          },
          { invalid: true },
        ],
      }),
    );

    await service.init();

    expect(service.get()).toMatchObject({
      themeMode: "dark",
      timetable: { semesterStart: null },
      dnd: { enabled: true, startTime: "23:00", endTime: "07:00" },
      notificationHistory: [{ id: "legacy-history" }],
      appearance: {
        material: "acrylic",
        backgroundImage: "scene.png",
        blurRadius: 18,
        clarity: 82,
      },
    });
  });

  it("keeps a valid custom legacy semester date", async () => {
    fs.writeFileSync(
      path.join(electronState.userData, "timetable.json"),
      JSON.stringify({ semesterStart: "2026-02-16" }),
    );

    await service.init();

    expect(service.get().timetable.semesterStart).toBe("2026-02-16");
  });

  it("isolates malformed current settings and falls back to defaults", async () => {
    const settingsPath = path.join(
      electronState.userData,
      "portable-settings.json",
    );
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        portableSettingsVersion: 1,
        themeMode: "dark",
        timetable: { semesterStart: "2026-02-30" },
      }),
    );

    await service.init();

    expect(service.get().themeMode).toBe("system");
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(
      fs
        .readdirSync(electronState.userData)
        .some((name) => name.startsWith("portable-settings.json.invalid.")),
    ).toBe(true);
  });

  it("rejects unsafe replacement values", async () => {
    await service.init();
    const invalid = service.get();
    invalid.timetable.semesterStart = "2026-02-30";

    expect(() => service.replace(invalid)).toThrow("便携设置格式无效");
  });
});
