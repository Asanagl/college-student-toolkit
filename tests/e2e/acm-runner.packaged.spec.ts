import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright";
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

type AcmSession = {
  app: ElectronApplication;
  page: PageWithRunnerEvents;
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

function createCppFixture(content: string): {
  directory: string;
  filePath: string;
} {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-acm-file-"),
  );
  const filePath = path.join(directory, "fixture.cpp");
  fs.writeFileSync(filePath, content, "utf8");
  return { directory, filePath };
}

async function patchAcmDialogs(
  app: ElectronApplication,
  paths: { openPath?: string; savePath?: string },
): Promise<void> {
  await app.evaluate(({ dialog }, value) => {
    const target = dialog as unknown as {
      showOpenDialog: (...args: unknown[]) => Promise<unknown>;
      showSaveDialog: (...args: unknown[]) => Promise<unknown>;
    };
    if (value.openPath) {
      target.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [value.openPath],
      });
    }
    if (value.savePath) {
      target.showSaveDialog = async () => ({
        canceled: false,
        filePath: value.savePath,
      });
    }
  }, paths);
}

async function launchPackaged(profile: string) {
  const executable = packagedExecutable();
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, COLLEGE_TOOLKIT_STORE_SMOKE: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page).toHaveTitle("大学生工具组");
    const runtime = await app.evaluate(({ app: electronApp }) => ({
      packaged: electronApp.isPackaged,
      resourcesPath: process.resourcesPath,
    }));
    expect(runtime.packaged).toBe(true);
    expect(runtime.resourcesPath.toLowerCase()).toBe(
      path.join(path.dirname(executable), "resources").toLowerCase(),
    );
    return { app, page: page as PageWithRunnerEvents };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function openWorkbench(page: Page): Promise<void> {
  await page
    .locator(".ant-menu-item")
    .filter({ hasText: "ACM 临时 IDE" })
    .click();
  await expect(page).toHaveURL(/#\/acm$/);
  await expect(page.locator(".acm-status-banner")).toContainText(
    "ACM 临时 IDE",
  );
}

async function createDocument(
  page: Page,
  template = "基础 I/O 模板",
): Promise<Locator> {
  const newButton = page.getByRole("button", { name: /新建/ }).first();
  await expect(newButton).toBeEnabled({ timeout: 60_000 });
  await newButton.click();
  await page.getByRole("menuitem", { name: template }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  return editor;
}

async function replaceSource(page: Page, source: string): Promise<Locator> {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(source);
  await expect(editor).toContainText(source.split("\n")[0]);
  return editor;
}

async function runWithWorkbench(
  callback: (session: AcmSession) => Promise<void>,
): Promise<void> {
  const profile = createProfile();
  let app: ElectronApplication | undefined;
  try {
    const session = await launchPackaged(profile);
    app = session.app;
    await openWorkbench(session.page);
    await callback(session);
  } finally {
    await app?.close();
    fs.rmSync(profile, { recursive: true, force: true });
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

async function expectRunnerIdle(page: Page): Promise<void> {
  await expect(commandButton(page, "compile")).toBeEnabled();
  await expect(commandButton(page, "run")).toBeEnabled();
  await expect(commandButton(page, "stop")).toBeDisabled();
  await expect(
    page.locator(".acm-command-bar").getByText(/编译中|运行中/),
  ).toHaveCount(0);
}

async function startRunnerAndWait(
  page: Page,
  mode: "compile" | "run",
  status: RunnerEvent["status"],
): Promise<RunnerEvent[]> {
  await subscribeToRunnerEvents(page);
  const button = commandButton(page, mode);
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  await waitForRunnerEvent(
    page,
    mode === "compile" ? "compile-finished" : "run-finished",
    [status],
  );
  return runnerEvents(page);
}

function commandButton(
  page: Page,
  button: "compile" | "run" | "stop",
): Locator {
  const labels = { compile: /^编译$/, run: /^编译并运行$/, stop: /^停止$/ };
  return page.locator(".acm-command-bar button").filter({
    hasText: labels[button],
  });
}

function panelToggle(page: Page, label: "标准输入" | "终端输出"): Locator {
  const labels = { 标准输入: /^标准输入$/, 终端输出: /^终端输出$/ };
  return page.locator(".acm-panel-toggle").filter({ hasText: labels[label] });
}

async function pressWorkbenchShortcut(
  page: Page,
  shortcut: "Control+N" | "Control+O" | "Control+S" | "Control+Shift+S",
): Promise<void> {
  await page.locator(".acm-page-title").click();
  await page.keyboard.press(shortcut);
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

test("packaged ACM reports compile failures and restores controls", async () => {
  await runWithWorkbench(async ({ page }) => {
    await createDocument(page);
    await replaceSource(
      page,
      [
        "#include <iostream>",
        "int main() {",
        "  return missing_symbol;",
        "}",
        "",
      ].join("\n"),
    );
    const events = await startRunnerAndWait(page, "compile", "failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: "compile-finished",
        status: "failed",
        errorCode: "ACM_RUNNER_FAILED",
      }),
    );
    expect(events.some((event) => event.stage === "run-started")).toBe(false);
    await expect(page.getByRole("log")).toContainText("失败");
    await expectRunnerIdle(page);
  });
});

test("packaged compile-only mode does not enter the run phase", async () => {
  await runWithWorkbench(async ({ page }) => {
    await createDocument(page);
    await replaceSource(
      page,
      [
        "#include <iostream>",
        'int main() { std::cout << "compile-only\\n"; }',
        "",
      ].join("\n"),
    );
    await startRunnerAndWait(page, "compile", "completed");
    await page.waitForTimeout(300);
    const events = await runnerEvents(page);
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: "compile-finished",
        status: "completed",
      }),
    );
    expect(events.some((event) => event.stage === "run-started")).toBe(false);
    await expectRunnerIdle(page);
  });
});

test("packaged ACM stop cancels a running program and restores controls", async () => {
  await runWithWorkbench(async ({ page }) => {
    await createDocument(page);
    await replaceSource(
      page,
      [
        "#include <chrono>",
        "#include <thread>",
        "int main() {",
        "  std::this_thread::sleep_for(std::chrono::seconds(30));",
        "}",
        "",
      ].join("\n"),
    );
    await subscribeToRunnerEvents(page);
    await page.getByRole("button", { name: "编译并运行" }).click();
    await waitForRunnerEvent(page, "run-started", ["started"]);
    await expect(commandButton(page, "stop")).toBeEnabled();
    await expect(
      page.locator(".acm-command-bar").getByText("运行中"),
    ).toBeVisible();
    await commandButton(page, "stop").click();
    await waitForRunnerEvent(page, "run-finished", ["cancelled"]);
    const events = await runnerEvents(page);
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: "run-finished",
        status: "cancelled",
        errorCode: "ACM_RUNNER_CANCELLED",
      }),
    );
    await expectRunnerIdle(page);
  });
});

test("packaged ACM run timeout restores controls", async () => {
  await runWithWorkbench(async ({ page }) => {
    await createDocument(page);
    await replaceSource(
      page,
      [
        "#include <chrono>",
        "#include <thread>",
        "int main() {",
        "  std::this_thread::sleep_for(std::chrono::seconds(10));",
        "}",
        "",
      ].join("\n"),
    );
    const events = await startRunnerAndWait(page, "run", "timeout");
    expect(events).toContainEqual(
      expect.objectContaining({
        stage: "run-finished",
        status: "timeout",
        errorCode: "ACM_RUNNER_TIMEOUT",
      }),
    );
    await expect(page.getByRole("log")).toContainText("超时");
    await expectRunnerIdle(page);
  });
});

test("packaged ACM stdout and stderr limits terminate the run", async () => {
  const sources = [
    [
      "#include <iostream>",
      "#include <string>",
      "int main() {",
      "  const std::string chunk(8192, 'o');",
      "  for (int i = 0; i < 600; ++i) std::cout << chunk;",
      "}",
      "",
    ].join("\n"),
    [
      "#include <iostream>",
      "#include <string>",
      "int main() {",
      "  const std::string chunk(8192, 'e');",
      "  for (int i = 0; i < 600; ++i) std::cerr << chunk;",
      "}",
      "",
    ].join("\n"),
  ];
  for (const source of sources) {
    await runWithWorkbench(async ({ page }) => {
      await createDocument(page);
      await replaceSource(page, source);
      const events = await startRunnerAndWait(page, "run", "output-limit");
      expect(events).toContainEqual(
        expect.objectContaining({
          stage: "run-finished",
          status: "output-limit",
          errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
        }),
      );
      await expectRunnerIdle(page);
    });
  }
});

test("packaged ACM keyboard shortcuts cover new, open, save and save-as", async () => {
  const fixture = createCppFixture(
    ["#include <iostream>", 'int main() { std::cout << "opened"; }', ""].join(
      "\n",
    ),
  );
  const saveDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-acm-save-"),
  );
  const savePath = path.join(saveDirectory, "shortcut-save.cpp");
  const saveAsPath = path.join(saveDirectory, "shortcut-save-as.cpp");
  try {
    await runWithWorkbench(async ({ app, page }) => {
      await pressWorkbenchShortcut(page, "Control+N");
      await expect(page.locator(".ant-tabs-tab")).toHaveCount(1);
      await replaceSource(
        page,
        ["#include <iostream>", "int main() { return 0; }", ""].join("\n"),
      );

      await patchAcmDialogs(app, { savePath });
      await pressWorkbenchShortcut(page, "Control+S");
      await expect.poll(() => fs.existsSync(savePath)).toBe(true);
      await expect(page.locator(".acm-dirty-dot")).toHaveCount(0);

      await patchAcmDialogs(app, { savePath: saveAsPath });
      await pressWorkbenchShortcut(page, "Control+Shift+S");
      await expect.poll(() => fs.existsSync(saveAsPath)).toBe(true);
      await expect(page.locator(".acm-editor-meta")).toContainText(
        "shortcut-save-as.cpp",
      );

      await patchAcmDialogs(app, { openPath: fixture.filePath });
      await pressWorkbenchShortcut(page, "Control+O");
      await expect(page.locator(".ant-tabs-tab")).toHaveCount(2);
      await expect(page.locator(".cm-content")).toContainText("opened");
    });
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    fs.rmSync(saveDirectory, { recursive: true, force: true });
  }
});

test("packaged ACM read-only documents route Ctrl+S to save-as", async () => {
  const fixture = createCppFixture(
    ["#include <iostream>", "int main() { return 7; }", ""].join("\n"),
  );
  const saveDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-acm-readonly-"),
  );
  const savePath = path.join(saveDirectory, "readonly-copy.cpp");
  try {
    fs.chmodSync(fixture.filePath, 0o444);
    await runWithWorkbench(async ({ app, page }) => {
      await patchAcmDialogs(app, { openPath: fixture.filePath, savePath });
      await pressWorkbenchShortcut(page, "Control+O");
      await expect(page.locator(".cm-content")).toHaveAttribute(
        "aria-readonly",
        "true",
      );
      await expect(page.getByText("只读", { exact: true })).toBeVisible();

      await pressWorkbenchShortcut(page, "Control+S");
      await expect.poll(() => fs.existsSync(savePath)).toBe(true);
      await expect(page.locator(".cm-content")).toHaveAttribute(
        "aria-readonly",
        "false",
      );
      expect(fs.readFileSync(fixture.filePath, "utf8")).toContain("return 7");
      await expect(page.locator(".acm-editor-meta")).toContainText(
        "readonly-copy.cpp",
      );
    });
  } finally {
    fs.chmodSync(fixture.filePath, 0o666);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    fs.rmSync(saveDirectory, { recursive: true, force: true });
  }
});

test("packaged ACM external changes require explicit overwrite confirmation", async () => {
  const source = [
    "#include <iostream>",
    'int main() { std::cout << "original"; }',
    "",
  ].join("\n");
  const fixture = createCppFixture(source);
  try {
    await runWithWorkbench(async ({ app, page }) => {
      await patchAcmDialogs(app, { openPath: fixture.filePath });
      await pressWorkbenchShortcut(page, "Control+O");
      await expect(page.locator(".cm-content")).toContainText("original");

      fs.writeFileSync(fixture.filePath, "// external replacement\n", "utf8");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.locator(".acm-external-alert")).toBeVisible();

      await pressWorkbenchShortcut(page, "Control+S");
      await page.getByRole("button", { name: "覆盖保存", exact: true }).click();
      await expect
        .poll(() => {
          try {
            return fs.readFileSync(fixture.filePath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        })
        .toBe(source);
      await expect(page.locator(".acm-external-alert")).toHaveCount(0);
    });
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("packaged ACM tabs keep source, stdin and dirty state independent", async () => {
  await runWithWorkbench(async ({ page }) => {
    await pressWorkbenchShortcut(page, "Control+N");
    await replaceSource(
      page,
      ["#include <iostream>", "int main() { return 1; }", ""].join("\n"),
    );
    await page.getByRole("textbox", { name: "程序标准输入" }).fill("stdin-a");

    await pressWorkbenchShortcut(page, "Control+N");
    await replaceSource(
      page,
      ["#include <iostream>", "int main() { return 2; }", ""].join("\n"),
    );
    await page.getByRole("textbox", { name: "程序标准输入" }).fill("stdin-b");
    await expect(page.locator(".acm-dirty-dot")).toHaveCount(2);

    await page.locator(".ant-tabs-tab").nth(0).click();
    await expect(page.locator(".cm-content")).toContainText("return 1");
    await expect(
      page.getByRole("textbox", { name: "程序标准输入" }),
    ).toHaveValue("stdin-a");
    await page.locator(".ant-tabs-tab").nth(1).click();
    await expect(page.locator(".cm-content")).toContainText("return 2");
    await expect(
      page.getByRole("textbox", { name: "程序标准输入" }),
    ).toHaveValue("stdin-b");
    await expect(page.locator(".acm-dirty-dot")).toHaveCount(2);
  });
});

test("packaged ACM workbench exposes interaction and accessibility states", async () => {
  await runWithWorkbench(async ({ page }) => {
    const editor = await createDocument(page, "空白文件");
    await expect(editor).toHaveAttribute("aria-label", "C++ 源码编辑器");
    await expect(editor).toHaveAttribute("aria-readonly", "false");
    await expect(
      page.getByRole("textbox", { name: "程序标准输入" }),
    ).toBeVisible();
    await panelToggle(page, "标准输入").click();
    await expect(
      page.getByRole("textbox", { name: "程序标准输入" }),
    ).toBeHidden();
    await panelToggle(page, "标准输入").click();
    await expect(
      page.getByRole("textbox", { name: "程序标准输入" }),
    ).toBeVisible();

    const log = page.getByRole("log");
    await expect(log).toBeVisible();
    await panelToggle(page, "终端输出").click();
    await expect(log).toBeHidden();
    await panelToggle(page, "终端输出").click();
    await expect(log).toBeVisible();
    await page.getByRole("button", { name: "清空终端" }).click();

    await replaceSource(
      page,
      ["#include <iostream>", "int main() { return 0; }", ""].join("\n"),
    );
    await expect(page.locator(".acm-dirty-dot")).toHaveCount(1);
    await expect(
      page
        .locator(".acm-workbench-header button")
        .filter({ hasText: /^保存$/ }),
    ).toBeEnabled();

    const newButton = page.getByRole("button", { name: /新建/ }).first();
    await newButton.click();
    await page.getByRole("menuitem", { name: "空白文件" }).click();
    await expect(page.locator(".ant-tabs-tab")).toHaveCount(2);
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "aria-readonly",
      "false",
    );

    await page
      .locator(".acm-status-banner")
      .getByRole("button", { name: "禁用" })
      .click();
    await expect(page.locator(".acm-status-banner")).toContainText(
      "插件已禁用",
    );
    await expect(newButton).toBeDisabled();
    await expect(commandButton(page, "compile")).toBeDisabled();
    await expect(commandButton(page, "run")).toBeDisabled();
    await expect(page.locator(".cm-content")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
  });
});

test("packaged ACM IPC rejects invalid runner requests and enforces plugin gate", async () => {
  await runWithWorkbench(async ({ page }) => {
    const invalid = await page.evaluate(() =>
      window.api.acm.startRunner({
        documentId: "not-a-uuid",
        source: "",
        stdin: "",
        mode: "compile",
      }),
    );
    expect(invalid).toMatchObject({
      ok: false,
      errorCode: "VALIDATION_FAILED",
    });

    await page
      .locator(".acm-status-banner")
      .getByRole("button", { name: "禁用" })
      .click();
    await expect(page.locator(".acm-status-banner")).toContainText(
      "插件已禁用",
    );
    const validRequest = {
      documentId: "00000000-0000-0000-0000-000000000001",
      source: "",
      stdin: "",
      mode: "compile" as const,
    };
    await expect(
      page.evaluate(
        (request) => window.api.acm.startRunner(request),
        validRequest,
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: "ACM_DISABLED" });
    await expect(
      page.evaluate(() => window.api.acm.stopRunner()),
    ).resolves.toMatchObject({ ok: false, errorCode: "ACM_DISABLED" });
  });
});
