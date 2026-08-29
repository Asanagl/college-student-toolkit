import { _electron as electron } from "playwright";
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test.setTimeout(60_000);

test("packaged Electron entrypoint starts with an isolated profile and secure renderer", async () => {
  const executable = path.resolve(
    process.env.PACKAGED_EXECUTABLE?.trim() ||
      "release-v0.4.0-msix-local/win-unpacked/大学生工具组.exe",
  );
  if (!fs.existsSync(executable)) {
    throw new Error(`找不到 packaged E2E 可执行文件：${executable}`);
  }
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-entry-"),
  );
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${profile}`],
      env: { ...process.env, COLLEGE_TOOLKIT_STORE_SMOKE: "1" },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page).toHaveTitle("大学生工具组");
    await expect(page.locator(".ant-menu-item")).toHaveCount(6);
    const security = await page.evaluate(() => ({
      hasApi: typeof window.api === "object",
      hasRequire:
        typeof (window as Window & { require?: unknown }).require ===
        "function",
      hasProcess:
        typeof (window as Window & { process?: unknown }).process === "object",
      protocol: window.location.protocol,
    }));
    expect(security).toEqual({
      hasApi: true,
      hasRequire: false,
      hasProcess: false,
      protocol: "file:",
    });
  } finally {
    await app?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
