import { _electron as electron, type Page } from "playwright";
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunnerEvent, RunnerStage } from "../../src/shared/types";

test.setTimeout(120_000);

const defaultExecutable = path.resolve(
  "release-v0.4.0-msix-local/win-unpacked/大学生工具组.exe",
);

type PageWithRunnerEvents = Page & {
  __acmRunnerEvents?: RunnerEvent[];
};

function packagedExecutable(): string {
  const executable = path.resolve(
    process.env.PACKAGED_EXECUTABLE?.trim() || defaultExecutable,
  );
  if (!fs.existsSync(executable))
    throw new Error(`找不到 packaged E2E 可执行文件：${executable}`);
  return executable;
}

function createProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "college-toolkit-acm-e2e-"));
}

async function launchPackaged(profile: string) {
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, COLLEGE_TOOLKIT_STORE_SMOKE: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page).toHaveTitle("大学生工具组");
    return { app, page: page as PageWithRunnerEvents };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function subscribeToRunnerEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & {
      __acmRunnerEvents?: RunnerEvent[];
      __acmRunnerUnsubscribe?: () => void;
    };
    target.__acmRunnerUnsubscribe?.();
    target.__acmRunnerEvents = [];
    target.__acmRunnerUnsubscribe = window.api.acm.onRunnerEvent((event) => {
      target.__acmRunnerEvents?.push(event);
    });
  });
}

async function runnerEvents(page: Page): Promise<RunnerEvent[]> {
  return page.evaluate(() => {
    const target = window as Window & { __acmRunnerEvents?: RunnerEvent[] };
    return target.__acmRunnerEvents ?? [];
  });
}

async function waitForRunnerEvent(
  page: Page,
  stage: RunnerStage,
  statuses: RunnerEvent["status"][],
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(
      ({ expectedStage, expectedStatuses }) => {
        const target = window as Window & {
          __acmRunnerEvents?: RunnerEvent[];
        };
        return (target.__acmRunnerEvents ?? []).some(
          (event) =>
            event.stage === expectedStage &&
            expectedStatuses.includes(event.status),
        );
      },
      { expectedStage: stage, expectedStatuses: statuses },
    );
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 Runner 事件超时：${stage}`);
}

test("packaged ACM workbench compiles and runs a C++17 program", async () => {
  const profile = createProfile();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let page: PageWithRunnerEvents;
  try {
    const session = await launchPackaged(profile);
    app = session.app;
    page = session.page;
    await page
      .locator(".ant-menu-item")
      .filter({ hasText: "ACM 临时 IDE" })
      .click();
    await expect(page).toHaveURL(/#\/acm$/);
    await expect(page.locator(".acm-status-banner")).toContainText(
      "ACM 临时 IDE",
    );

    const newButton = page.getByRole("button", { name: /新建/ }).first();
    await expect(newButton).toBeEnabled({ timeout: 60_000 });
    await newButton.click();
    await page.getByRole("menuitem", { name: "基础 I/O 模板" }).click();
    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();

    const source = [
      "#include <chrono>",
      "#include <iostream>",
      "#include <string>",
      "#include <thread>",
      "int main() {",
      "  std::string name;",
      "  std::getline(std::cin, name);",
      "  std::this_thread::sleep_for(std::chrono::milliseconds(800));",
      '  std::cout << "acm-e2e: " << name << "\\n";',
      "}",
      "",
    ].join("\n");
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(source);
    await expect(editor).toContainText("acm-e2e");
    await page.getByRole("textbox", { name: "程序标准输入" }).fill("runner\n");

    await subscribeToRunnerEvents(page);
    const runButton = page.getByRole("button", { name: "编译并运行" });
    await expect(runButton).toBeEnabled({ timeout: 60_000 });
    await runButton.click();

    await waitForRunnerEvent(page, "compile-finished", ["completed"]);
    await expect(runButton).toBeDisabled();
    await expect(
      page.locator(".acm-command-bar").getByText("运行中"),
    ).toBeVisible();

    await waitForRunnerEvent(page, "run-finished", [
      "completed",
      "failed",
      "cancelled",
      "timeout",
      "output-limit",
    ]);

    const events = await runnerEvents(page);
    const stages = events
      .filter(
        (event) => event.status === "started" || event.status === "completed",
      )
      .map((event) => event.stage);
    expect(stages).toEqual([
      "compile-started",
      "compile-finished",
      "run-started",
      "run-finished",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: "run-finished",
        status: "completed",
      }),
    );
    expect(
      events.some((event) => event.text?.includes("acm-e2e: runner")),
    ).toBe(true);
    await expect(page.getByRole("log")).toContainText("acm-e2e: runner");
    await expect(runButton).toBeEnabled({ timeout: 10_000 });
  } finally {
    await app?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
