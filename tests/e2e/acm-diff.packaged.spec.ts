import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcmDiffEvent } from "../../src/shared/types";

test.setTimeout(120_000);

const executable = path.resolve(
  process.env.PACKAGED_EXECUTABLE?.trim() ||
    "release-v0.4.0-msix-local/win-unpacked/大学生工具组.exe",
);

function createProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "college-toolkit-diff-e2e-"));
}

async function launch(profile: string): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  if (!fs.existsSync(executable))
    throw new Error(`找不到 packaged E2E 可执行文件：${executable}`);
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, COLLEGE_TOOLKIT_STORE_SMOKE: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("body")).toContainText("大学生工具组");
  return { app, page };
}

async function openDiff(page: Page): Promise<void> {
  await page.locator(".ant-menu-item").filter({ hasText: "ACM 对拍" }).click();
  await expect(page).toHaveURL(/#\/acm-diff$/);
  // Parallel packaged Electron launches can delay the initial plugin/notice
  // IPC round-trip; wait for the page state instead of treating load pressure
  // as a routing failure.
  await expect(page.locator(".acm-diff-page")).toBeVisible({
    timeout: 15_000,
  });
}

async function setSource(page: Page, reference: string, candidate: string) {
  const editors = page.locator(".acm-diff-editor-card .cm-content");
  await editors.nth(0).fill(reference);
  await editors.nth(1).fill(candidate);
}

async function captureDiffEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & {
      __acmDiffEvents?: AcmDiffEvent[];
      __acmDiffEventsUnsubscribe?: () => void;
    };
    target.__acmDiffEvents = [];
    target.__acmDiffEventsUnsubscribe?.();
    target.__acmDiffEventsUnsubscribe = window.api.acm.onDiffEvent((event) => {
      target.__acmDiffEvents?.push(event);
    });
  });
}

async function readDiffEvents(page: Page): Promise<AcmDiffEvent[]> {
  return page.evaluate(() => {
    const target = window as Window & { __acmDiffEvents?: AcmDiffEvent[] };
    return target.__acmDiffEvents ?? [];
  });
}

const VALID_SOURCE = `#include <iostream>
int main() { int value = 0; if (!(std::cin >> value)) return 1; std::cout << value + 1 << "\\n"; }
`;
const WA_SOURCE = VALID_SOURCE.replace("value + 1", "value + 2");
const BROKEN_SOURCE = "int main() { this is not valid C++; }";

test("packaged ACM diff starts blank, compares tokens, isolates failures, and discards page state", async () => {
  const profile = createProfile();
  let session: { app: ElectronApplication; page: Page };
  try {
    session = await launch(profile);
  } catch (error) {
    fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  const { app, page } = session;
  try {
    await openDiff(page);
    const editors = page.locator(".acm-diff-editor-card .cm-content");
    await expect(editors).toHaveCount(2);
    await expect(editors.nth(0)).toHaveText("");
    await expect(editors.nth(1)).toHaveText("");

    await captureDiffEvents(page);
    await setSource(page, VALID_SOURCE, VALID_SOURCE);
    await page
      .getByPlaceholder("输入将同时提供给标准程序和待测程序")
      .fill("41\n");
    await page.getByRole("button", { name: "开始对拍" }).click();
    await expect(page.getByText("AC：输出一致", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const matchEvents = await readDiffEvents(page);
    const matchEvent = matchEvents.find((event) => event.stage === "compare");
    expect(matchEvent?.result).toMatchObject({ status: "match" });
    expect(matchEvent?.result?.referenceOutput?.stdout).toContain("42");
    expect(matchEvent?.result?.candidateOutput?.stdout).toContain("42");
    await expect(page.locator(".acm-diff-outputs")).toContainText(
      "标准程序输出",
    );
    await expect(page.locator(".acm-diff-outputs")).toContainText(
      "待测程序输出",
    );

    await setSource(page, VALID_SOURCE, WA_SOURCE);
    await page.getByRole("button", { name: "开始对拍" }).click();
    await expect(page.getByText("WA：输出不一致", { exact: true })).toBeVisible(
      {
        timeout: 60_000,
      },
    );
    await expect(page.locator(".acm-diff-difference")).toContainText(
      "首个差异",
    );

    await captureDiffEvents(page);
    await setSource(page, "int main() { return 1; }", VALID_SOURCE);
    await page.getByRole("button", { name: "开始对拍" }).click();
    await expect(
      page.getByText("标准程序失败 / 对拍无效", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const referenceFailureEvents = await readDiffEvents(page);
    expect(
      referenceFailureEvents.filter((event) => event.stage === "candidate-run"),
    ).toHaveLength(0);

    await setSource(page, VALID_SOURCE, BROKEN_SOURCE);
    await page.getByRole("button", { name: "开始对拍" }).click();
    await expect(
      page.getByText("待测程序编译失败", { exact: true }),
    ).toBeVisible({
      timeout: 60_000,
    });

    await page.locator(".ant-menu-item").filter({ hasText: "日程" }).click();
    await openDiff(page);
    await expect(editors.nth(0)).toHaveText("");
    await expect(editors.nth(1)).toHaveText("");
    await expect(
      page.getByPlaceholder("输入将同时提供给标准程序和待测程序"),
    ).toHaveValue("");
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
