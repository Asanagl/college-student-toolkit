import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const electronState = { userData: "" };

vi.mock("electron", () => ({
  app: { getPath: () => electronState.userData },
}));

import {
  AcmPluginService,
  type AcmPluginEnvironment,
} from "../../src/main/services/AcmPluginService";
import { portableSettingsService } from "../../src/main/services/PortableSettingsService";

const tempPaths: string[] = [];
const platformCases: Array<{
  name: string;
  environment: Required<AcmPluginEnvironment>;
  supported: boolean;
}> = [
  {
    name: "Windows 11 x64",
    environment: {
      platform: "win32",
      arch: "x64",
      osRelease: "10.0.22621",
    },
    supported: true,
  },
  {
    name: "Windows 10 x64",
    environment: {
      platform: "win32",
      arch: "x64",
      osRelease: "10.0.22620",
    },
    supported: false,
  },
  {
    name: "Windows 11 ARM64",
    environment: {
      platform: "win32",
      arch: "arm64",
      osRelease: "10.0.22621",
    },
    supported: false,
  },
  {
    name: "Linux x64",
    environment: {
      platform: "linux",
      arch: "x64",
      osRelease: "6.8.0",
    },
    supported: false,
  },
];

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
    const service = new AcmPluginService(platformCases[0].environment);

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

  it.each(platformCases)(
    "$name initializes, persists disablement, and retries deterministically",
    async ({ environment, supported }) => {
      const service = new AcmPluginService(environment);
      await service.init();

      expect(service.getStatus()).toMatchObject({
        ok: true,
        data: {
          state: supported ? "ready" : "unsupported",
          enabled: true,
        },
      });
      expect(service.setEnabled(false)).toMatchObject({
        ok: true,
        data: { state: "disabled", enabled: false },
      });
      expect(portableSettingsService.get().acm.enabled).toBe(false);
      await service.dispose();

      await portableSettingsService.dispose();
      await portableSettingsService.init();
      const restored = new AcmPluginService(environment);
      await restored.init();
      expect(restored.getStatus()).toMatchObject({
        ok: true,
        data: {
          state: supported ? "disabled" : "unsupported",
          enabled: false,
        },
      });

      expect(restored.setEnabled(true)).toMatchObject({
        ok: true,
        data: { state: supported ? "ready" : "unsupported", enabled: true },
      });
      expect(portableSettingsService.get().acm.enabled).toBe(true);
      expect(restored.retry()).toMatchObject({
        ok: true,
        data: { state: supported ? "ready" : "unsupported", enabled: true },
      });
      await restored.dispose();
    },
  );

  it.each(platformCases)(
    "$name handles compiler health without crossing platform state",
    async ({ environment, supported }) => {
      const service = new AcmPluginService(environment);
      await service.init();
      service.setCompilerHealth(false, "测试编译器不可用");
      expect(service.getStatus()).toMatchObject({
        ok: true,
        data: supported
          ? {
              state: "degraded",
              errorCode: "ACM_COMPILER_MISSING",
              error: "测试编译器不可用",
            }
          : { state: "unsupported", enabled: true },
      });
      service.setCompilerHealth(true);
      expect(service.getStatus()).toMatchObject({
        ok: true,
        data: supported
          ? { state: "ready", errorCode: undefined, error: undefined }
          : { state: "unsupported", enabled: true },
      });
      await service.dispose();
    },
  );

  it("returns to a non-running state after disposal", async () => {
    const service = new AcmPluginService(platformCases[0].environment);
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
