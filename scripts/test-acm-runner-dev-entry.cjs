/* eslint-env node */
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function npmInvocation() {
  const configured = process.env.npm_execpath?.trim();
  const cli =
    configured && configured.toLowerCase().endsWith(".js")
      ? configured
      : path.join(
          path.dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
  return { command: process.execPath, prefix: [cli] };
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`${label} 启动失败：${result.error.message}`);
  return result.status ?? 1;
}

function restoreNodeAbi() {
  const npm = npmInvocation();
  return runCommand(
    npm.command,
    [...npm.prefix, "rebuild", "better-sqlite3"],
    "恢复 Node ABI",
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runSmoke() {
  const node = process.execPath;
  const electronBuilder = path.join(
    root,
    "node_modules",
    "electron-builder",
    "cli.js",
  );
  let status = runCommand(
    node,
    [electronBuilder, "install-app-deps", "--arch=x64"],
    "准备 Electron ABI",
  );
  const npm = npmInvocation();
  if (status === 0)
    status = runCommand(
      npm.command,
      [...npm.prefix, "run", "build:electron"],
      "构建 Electron",
    );
  if (status === 0)
    status = runCommand(
      node,
      [path.join("scripts", "test-acm-runner-dev.cjs")],
      "运行 ACM 开发 smoke",
    );
  return status;
}

function run() {
  let status = 1;
  let failure;
  let restoreFailure;
  try {
    status = runSmoke();
  } catch (error) {
    failure = error;
  } finally {
    try {
      const restoreStatus = restoreNodeAbi();
      if (restoreStatus !== 0) {
        restoreFailure = new Error(`恢复 Node ABI 退出码：${restoreStatus}`);
        status = 1;
      }
    } catch (error) {
      restoreFailure = error;
      status = 1;
    }
  }
  if (failure || restoreFailure) {
    if (failure)
      console.error(`[test-acm-runner-dev-entry] ${errorMessage(failure)}`);
    if (restoreFailure)
      console.error(
        `[test-acm-runner-dev-entry] Node ABI 恢复失败：${errorMessage(restoreFailure)}`,
      );
    process.exitCode = 1;
    return;
  }
  process.exitCode = status;
}

run();
