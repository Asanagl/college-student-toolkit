import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const electronState = { userData: "" };

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userData },
}));

import { AcmPluginService } from "../../src/main/services/AcmPluginService";
import { portableSettingsService } from "../../src/main/services/PortableSettingsService";

const tempPaths: string[] = [];
const platformSupported =
  process.platform === "win32" &&
  process.arch === "x64" &&
  Number.parseInt(os.release().split(".")[2] ?? "0", 10) >= 22621;

function createDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "toolkit-acm-plugin-"),
  );
  tempPaths.push(directory);
  return directory;
}

beforeEach(async () => {
  electronState.userData = createDirectory();
  await portableSettingsService.dispose();
  await portableSettingsService.init();
  portableSettingsService.update({ acm: { enabled: true } });
});

afterEach(async () => {
  await portableSettingsService.dispose();
  for (const directory of tempPaths.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("AcmPluginService", () => {
  it("rejects writes before initialization and reports the trusted manifest", () => {
    const service = new AcmPluginService();

    expect(service.setEnabled(false)).toMatchObject({
      ok: false,
      errorCode: "ACM_PLUGIN_INVALID",
    });
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: {
        state: "initializing",
        enabled: true,
        manifest: {
          id: "acm-code-workbench",
          pluginApiVersion: 1,
          capabilities: ["acm.documents", "acm.compiler", "acm.runner"],
        },
      },
    });
  });

  it("initializes as ready on the supported host and can be disabled", async () => {
    const service = new AcmPluginService();
    await service.init();

    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: platformSupported ? "ready" : "unsupported" },
    });
    if (!platformSupported) return;

    expect(service.isEnabled()).toBe(true);
    expect(service.setEnabled(false)).toMatchObject({
      ok: true,
      data: { state: "disabled", enabled: false },
    });
    expect(service.isEnabled()).toBe(false);
  });

  it("keeps the disabled setting across retry and restores the enabled state", async () => {
    const service = new AcmPluginService();
    await service.init();
    expect(service.setEnabled(false)).toMatchObject({
      ok: true,
      data: { enabled: false },
    });

    expect(service.retry()).toMatchObject({
      ok: true,
      data: { state: "disabled", enabled: false },
    });
    portableSettingsService.update({ acm: { enabled: true } });
    expect(service.retry()).toMatchObject({
      ok: true,
      data: {
        state: platformSupported ? "ready" : "unsupported",
        enabled: true,
      },
    });
  });

  it("reports compiler degradation and clears it after recovery", async () => {
    const service = new AcmPluginService();
    await service.init();
    if (!platformSupported) {
      expect(service.isEnabled()).toBe(false);
      return;
    }

    service.setCompilerHealth(false, "测试编译器不可用");
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: {
        state: "degraded",
        errorCode: "ACM_COMPILER_MISSING",
        error: "测试编译器不可用",
      },
    });
    expect(service.isEnabled()).toBe(true);

    service.setCompilerHealth(true);
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: "ready", errorCode: undefined, error: undefined },
    });
  });

  it("returns to a non-running state after disposal", async () => {
    const service = new AcmPluginService();
    await service.init();
    await service.dispose();

    expect(service.isEnabled()).toBe(false);
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: "disabled" },
    });
    expect(service.setEnabled(true)).toMatchObject({
      ok: false,
      errorCode: "ACM_PLUGIN_INVALID",
    });
  });
});
