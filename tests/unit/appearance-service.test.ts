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

  return { userData: "", showOpenDialog: vi.fn(), FakeStore };
});
const fsPromiseMocks = vi.hoisted(() => ({ copyFile: vi.fn() }));

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: electronState.showOpenDialog },
}));
vi.mock("electron-store", () => ({ default: electronState.FakeStore }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: fsPromiseMocks.copyFile };
});
vi.mock("../../src/main/services/WindowService", () => ({
  WindowService: { isAcrylicSupported: () => false },
  windowService: {
    getMainWindow: () => null,
    setBackgroundMaterial: vi.fn(),
  },
}));

import { appearanceService } from "../../src/main/services/AppearanceService";
import { portableSettingsService } from "../../src/main/services/PortableSettingsService";

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

const directories: string[] = [];

async function initializeWithBackground(
  backgroundImage: string | null = null,
): Promise<void> {
  portableSettingsService.replace({
    ...defaults,
    appearance: { ...defaults.appearance, backgroundImage },
  });
  if (backgroundImage) {
    const directory = path.join(electronState.userData, "backgrounds");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, backgroundImage), validPng);
  }
  await appearanceService.init();
}

beforeEach(async () => {
  fsPromiseMocks.copyFile.mockImplementation((source, destination) => {
    fs.copyFileSync(source, destination);
  });
  electronState.userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "toolkit-appearance-"),
  );
  directories.push(electronState.userData);
  await appearanceService.dispose();
  await portableSettingsService.dispose();
  await portableSettingsService.init();
  portableSettingsService.replace(defaults);
});

afterEach(async () => {
  await appearanceService.dispose();
  await portableSettingsService.dispose();
  vi.restoreAllMocks();
  while (directories.length > 0)
    fs.rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("AppearanceService background replacement", () => {
  it("commits a new background before deleting the old owned file", async () => {
    await initializeWithBackground("old.png");
    const source = path.join(electronState.userData, "new.png");
    fs.writeFileSync(source, validPng);

    const fileName = await appearanceService.uploadBackgroundImage(source);

    expect(fileName).toMatch(/\.png$/);
    expect(
      fs.existsSync(
        path.join(electronState.userData, "backgrounds", "old.png"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(electronState.userData, "backgrounds", fileName)),
    ).toBe(true);
    expect(portableSettingsService.get().appearance.backgroundImage).toBe(
      fileName,
    );
  });

  it("preserves the existing background when copying the replacement fails", async () => {
    await initializeWithBackground("old.png");
    const source = path.join(electronState.userData, "new.png");
    fs.writeFileSync(source, validPng);
    fsPromiseMocks.copyFile.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      appearanceService.uploadBackgroundImage(source),
    ).rejects.toThrow("disk full");

    expect(
      fs.existsSync(
        path.join(electronState.userData, "backgrounds", "old.png"),
      ),
    ).toBe(true);
    expect(portableSettingsService.get().appearance.backgroundImage).toBe(
      "old.png",
    );
    expect(appearanceService.getBackgroundImageUrl()).toBe(
      "app-background:///old.png",
    );
  });

  it("preserves the old configuration and file when settings persistence fails", async () => {
    await initializeWithBackground("old.png");
    const source = path.join(electronState.userData, "new.png");
    fs.writeFileSync(source, validPng);
    vi.spyOn(portableSettingsService, "update").mockImplementation(() => {
      throw new Error("settings unavailable");
    });

    await expect(
      appearanceService.uploadBackgroundImage(source),
    ).rejects.toThrow("settings unavailable");

    expect(
      fs.existsSync(
        path.join(electronState.userData, "backgrounds", "old.png"),
      ),
    ).toBe(true);
    expect(portableSettingsService.get().appearance.backgroundImage).toBe(
      "old.png",
    );
    expect(appearanceService.getBackgroundImageUrl()).toBe(
      "app-background:///old.png",
    );
  });
});
