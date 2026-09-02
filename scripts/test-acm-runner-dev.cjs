/* eslint-env node */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const electronExecutable = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);
const viteExecutable = path.join(
  root,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);
const port = 5174;
const timeoutSource = [
  "#include <chrono>",
  "#include <thread>",
  "int main() {",
  "  std::this_thread::sleep_for(std::chrono::seconds(10));",
  "}",
  "",
].join("\n");

function supportedHost() {
  if (process.platform !== "win32" || process.arch !== "x64") return false;
  const build = Number.parseInt(os.release().split(".")[2] ?? "0", 10);
  return Number.isInteger(build) && build >= 22621;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDevServer(child, url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Vite 提前退出（code=${child.exitCode}）`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The server is still starting; keep polling the local endpoint.
    }
    await delay(200);
  }
  throw new Error("等待开发 Vite 服务超时");
}

function stopProcessTree(child) {
  const pid = child?.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = path.join(
      process.env.SystemRoot?.trim() || "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    try {
      execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // The test-owned server may have exited between the check and taskkill.
    }
    return;
  }
  child.kill("SIGTERM");
}

async function waitForEnabled(locator, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await delay(200);
  }
  throw new Error(`${label} 在开发入口中未启用`);
}

async function subscribeToRunnerEvents(page) {
  await page.evaluate(() => {
    const target = window;
    target.__acmRunnerEvents = [];
    target.__acmRunnerUnsubscribe?.();
    target.__acmRunnerUnsubscribe = window.api.acm.onRunnerEvent((event) => {
      target.__acmRunnerEvents.push(event);
    });
  });
}

async function waitForRunnerEvent(page, predicate, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = await page.evaluate(predicate);
    if (found) return;
    await delay(100);
  }
  throw new Error(`等待开发 Runner 事件超时：${label}`);
}

function powershellTarget() {
  return path.join(
    process.env.SystemRoot?.trim() || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return;
  const taskkill = path.join(
    process.env.SystemRoot?.trim() || "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  try {
    spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // Cleanup is best effort after the assertion has captured the failure.
  }
}

async function runDevelopmentBreakawayProbe() {
  const probe = path.join(root, "scripts", "acm-job-breakaway-probe.ps1");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-dev-breakaway-"),
  );
  const marker = path.join(directory, "marker.txt");
  let runner;
  let extraPids = [];
  try {
    runner = spawn(
      powershellTarget(),
      ["-NoProfile", "-NonInteractive", "-File", probe],
      {
        cwd: directory,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ACM_JOB_RUNNER_MARKER: marker },
      },
    );
    const deadline = Date.now() + 10_000;
    let values = [];
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) {
        values = fs
          .readFileSync(marker, "utf8")
          .split(/\r?\n/)
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value));
        if (values.length >= 4) break;
      }
      await delay(100);
    }
    if (values.length < 4)
      throw new Error("等待 development breakaway 探针结果超时");
    const [shellPid, childPid, breakawayCreated, , breakawayPid] = values;
    extraPids = [shellPid, childPid, breakawayPid].filter(
      (pid) => Number.isInteger(pid) && pid > 0,
    );
    if (breakawayCreated === 0)
      throw new Error("开发入口没有 helper 时 breakaway 仍失败，对照无效");
    if (processExists(runner.pid) && !runner.kill())
      throw new Error("无法结束 development breakaway wrapper");
    console.log(
      JSON.stringify({
        mode: "development",
        nativeHelper: false,
        strategy: "development-allows-create-breakaway-from-job",
        breakawayCreated: true,
        targetPids: extraPids,
      }),
    );
  } finally {
    if (runner?.pid && processExists(runner.pid)) killPid(runner.pid);
    extraPids.forEach(killPid);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function assertDevelopmentRuntime(runtime) {
  if (runtime.packaged) throw new Error("开发 smoke 意外启动为 packaged 模式");
  const helperPath = path.join(runtime.resourcesPath, "acm-job-runner.exe");
  if (fs.existsSync(helperPath))
    throw new Error(`开发入口意外发现 native helper：${helperPath}`);
}

async function launchDevelopmentApp(profile, serverUrl) {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [root, `--user-data-dir=${profile}`],
    env: { ...process.env, VITE_DEV_SERVER_URL: serverUrl },
  });
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    packaged: electronApp.isPackaged,
    resourcesPath: process.resourcesPath,
  }));
  assertDevelopmentRuntime(runtime);
  return { app, runtime };
}

async function openWorkbench(app) {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  if ((await page.title()) !== "大学生工具组")
    throw new Error("开发入口标题不正确");
  await page
    .locator(".ant-menu-item")
    .filter({ hasText: "ACM 临时 IDE" })
    .click();
  await page.getByRole("button", { name: /新建/ }).first().click();
  await page.getByRole("menuitem", { name: "基础 I/O 模板" }).click();
  const editor = page.locator(".cm-content");
  await editor.waitFor({ state: "visible" });
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(timeoutSource);
  return { page, runButton: page.getByRole("button", { name: "编译并运行" }) };
}

async function runTimeoutProbe(page, runButton) {
  await waitForEnabled(runButton, "编译并运行按钮");
  await subscribeToRunnerEvents(page);
  await runButton.click();
  await waitForRunnerEvent(
    page,
    () =>
      (window.__acmRunnerEvents ?? []).some(
        (event) => event.stage === "run-started" && event.status === "started",
      ),
    "run-started",
  );
  await waitForRunnerEvent(
    page,
    () =>
      (window.__acmRunnerEvents ?? []).some(
        (event) =>
          event.stage === "run-finished" &&
          event.status === "timeout" &&
          event.errorCode === "ACM_RUNNER_TIMEOUT",
      ),
    "run-finished/timeout",
  );
}

async function run() {
  if (!supportedHost()) {
    console.log("ACM development fallback smoke skipped: Windows 11 x64 only.");
    return;
  }
  if (!fs.existsSync(electronExecutable))
    throw new Error(`找不到 Electron：${electronExecutable}，请先构建依赖。`);
  if (!fs.existsSync(viteExecutable))
    throw new Error(`找不到 Vite：${viteExecutable}，请先 npm ci。`);

  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-acm-dev-"),
  );
  const serverUrl = `http://127.0.0.1:${port}`;
  const vite = spawn(
    process.execPath,
    [
      viteExecutable,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: root, env: { ...process.env }, windowsHide: true, stdio: "ignore" },
  );
  let app;
  try {
    await waitForDevServer(vite, serverUrl);
    const session = await launchDevelopmentApp(profile, serverUrl);
    app = session.app;
    const { page, runButton } = await openWorkbench(app);
    await runTimeoutProbe(page, runButton);
    await runDevelopmentBreakawayProbe();
    console.log(
      JSON.stringify({
        mode: "development",
        packaged: session.runtime.packaged,
        nativeHelper: false,
        termination: "taskkill-fallback",
        result: "timeout-confirmed",
        breakaway: "allowed-without-job-object",
      }),
    );
  } finally {
    await app?.close();
    stopProcessTree(vite);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(
    `[test-acm-runner-dev] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
