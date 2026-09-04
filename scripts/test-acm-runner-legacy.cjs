/* eslint-env node */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageRoot = path.resolve(
  process.env.PACKAGED_ROOT?.trim() || "release-v0.5.0-msix-local/win-unpacked",
);
const executableName = "大学生工具组.exe";
const helperName = "acm-job-runner.exe";

function fail(message) {
  throw new Error(`[test-acm-runner-legacy] ${message}`);
}

function linkFile(source, target) {
  fs.linkSync(source, target);
}

function linkDirectory(source, target) {
  try {
    fs.symlinkSync(source, target, "junction");
  } catch (error) {
    fail(`无法创建 packaged overlay junction ${target}: ${error.message}`);
  }
}

function linkEntry(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) linkDirectory(source, target);
  else if (stat.isFile()) linkFile(source, target);
  else fail(`packaged 产物包含不支持的文件类型：${source}`);
}

function validatePackageRoot() {
  if (process.platform !== "win32" || process.arch !== "x64") return false;
  const executable = path.join(packageRoot, executableName);
  const resources = path.join(packageRoot, "resources");
  const helper = path.join(resources, helperName);
  if (!fs.existsSync(executable))
    fail(`找不到 packaged executable：${executable}`);
  if (!fs.existsSync(resources))
    fail(`找不到 packaged resources：${resources}`);
  if (!fs.existsSync(helper) || !fs.statSync(helper).isFile())
    fail(`原始 packaged helper 不存在：${helper}`);
  return true;
}

function createOverlay() {
  const overlay = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-acm-legacy-package-"),
  );
  const sourceResources = path.join(packageRoot, "resources");
  const targetResources = path.join(overlay, "resources");
  try {
    for (const entry of fs.readdirSync(packageRoot)) {
      if (entry === "resources") continue;
      linkEntry(path.join(packageRoot, entry), path.join(overlay, entry));
    }
    fs.mkdirSync(targetResources);
    for (const entry of fs.readdirSync(sourceResources)) {
      if (entry === helperName) continue;
      linkEntry(
        path.join(sourceResources, entry),
        path.join(targetResources, entry),
      );
    }
    const executable = path.join(overlay, executableName);
    const helper = path.join(targetResources, helperName);
    if (!fs.existsSync(executable)) fail("overlay executable 未创建");
    if (fs.existsSync(helper)) fail("overlay 意外包含 native helper");
    return { overlay, executable };
  } catch (error) {
    fs.rmSync(overlay, { recursive: true, force: true });
    throw error;
  }
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

async function runLegacyBreakawayProbe(overlay) {
  const helper = path.join(overlay, "resources", helperName);
  if (fs.existsSync(helper)) fail("overlay 仍然包含 native helper");
  const probe = path.join(root, "scripts", "acm-job-breakaway-probe.ps1");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-legacy-breakaway-"),
  );
  const marker = path.join(directory, "marker.txt");
  let runner;
  let extraPids = [];
  try {
    runner = spawn(
      powershellTarget(),
      ["-NoProfile", "-NonInteractive", "-File", probe],
      {
        cwd: overlay,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ACM_JOB_RUNNER_MARKER: marker,
        },
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (values.length < 4) fail("等待 legacy breakaway 探针结果超时");
    const [shellPid, childPid, breakawayCreated, , breakawayPid] = values;
    extraPids = [shellPid, childPid, breakawayPid].filter(
      (pid) => Number.isInteger(pid) && pid > 0,
    );
    if (breakawayCreated === 0)
      fail("缺少 helper 的 packaged overlay 仍拒绝 CREATE_BREAKAWAY_FROM_JOB");
    if (processExists(runner.pid) && !runner.kill())
      fail("无法结束 legacy breakaway wrapper");
    console.log(
      JSON.stringify({
        overlay,
        nativeHelper: false,
        strategy: "legacy-overlay-allows-create-breakaway-from-job",
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

function runTimeoutProbe(executable) {
  const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
  if (!fs.existsSync(cli)) fail(`找不到 Playwright CLI：${cli}`);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "test",
      "tests/e2e/acm-runner.packaged.spec.ts",
      "--project=packaged",
      "-g",
      "packaged ACM run timeout restores controls",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PACKAGED_EXECUTABLE: executable,
        COLLEGE_TOOLKIT_LEGACY_FALLBACK_SMOKE: "1",
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error)
    fail(`启动 packaged fallback probe 失败：${result.error.message}`);
  return result.status ?? 1;
}

async function cleanup(directory) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      if (!fs.existsSync(directory)) return true;
    } catch (error) {
      if (attempt === 7) {
        console.warn(
          `[test-acm-runner-legacy] overlay 清理失败：${error.message}`,
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function run() {
  if (!validatePackageRoot()) {
    console.log(
      "ACM packaged legacy fallback smoke skipped: Windows x64 only.",
    );
    return;
  }
  const session = createOverlay();
  let status = 1;
  try {
    status = runTimeoutProbe(session.executable);
    if (status === 0) {
      await runLegacyBreakawayProbe(session.overlay);
      console.log(
        JSON.stringify({
          mode: "packaged-legacy-fallback",
          packaged: true,
          nativeHelper: false,
          termination: "taskkill-fallback",
          result: "timeout-confirmed",
          breakaway: "allowed-without-job-object",
        }),
      );
    }
  } finally {
    const cleaned = await cleanup(session.overlay);
    if (!cleaned) status = 1;
  }
  process.exitCode = status;
}

run().catch((error) => {
  console.error(
    `[test-acm-runner-legacy] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
