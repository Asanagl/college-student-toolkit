/* eslint-env node */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageRoot = path.resolve(
  process.env.PACKAGED_ROOT?.trim() || "release-v0.4.0-msix-local/win-unpacked",
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
    if (status === 0)
      console.log(
        JSON.stringify({
          mode: "packaged-legacy-fallback",
          packaged: true,
          nativeHelper: false,
          termination: "taskkill-fallback",
          result: "timeout-confirmed",
        }),
      );
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
