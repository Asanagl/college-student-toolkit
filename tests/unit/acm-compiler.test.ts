import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const electronState = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => electronState.userData,
  },
}));

import { AcmCompilerService } from "../../src/main/services/AcmCompilerService";

const directories: string[] = [];

beforeEach(() => {
  electronState.userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "toolkit-acm-compiler-"),
  );
  directories.push(electronState.userData);
});

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("AcmCompilerService", () => {
  it("persists automatic selection without modifying PATH", async () => {
    const service = new AcmCompilerService();
    await service.init();
    expect(service.getSelection()).toEqual({
      ok: true,
      data: { mode: "auto", path: null },
    });
    expect(service.setSelection({ mode: "auto", path: null })).toEqual({
      ok: true,
      data: { mode: "auto", path: null },
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(electronState.userData, "acm-toolchain.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      mode: "auto",
      path: null,
    });
    await service.dispose();
  });

  it("rejects non-g++ and device paths in user mode", async () => {
    const service = new AcmCompilerService();
    await service.init();
    expect(
      service.setSelection({ mode: "user", path: "C:\\tools\\clang++.exe" }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_COMPILER_INVALID",
    });
    expect(
      service.setSelection({ mode: "user", path: "\\\\.\\pipe\\g++.exe" }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_COMPILER_INVALID",
    });
    expect(service.setSelection({ mode: "user", path: null })).toMatchObject({
      ok: false,
      errorCode: "ACM_COMPILER_INVALID",
    });
  });

  it("reports an unavailable explicit compiler without throwing", async () => {
    const service = new AcmCompilerService();
    await service.init();
    service.setSelection({ mode: "user", path: "C:\\missing\\g++.exe" });
    const result = await service.probe();
    expect(result).toMatchObject({
      ok: true,
      data: { available: false, reason: "指定的 g++ 不可用" },
    });
    await service.dispose();
  });
});
