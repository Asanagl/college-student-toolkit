/* eslint-env node */
"use strict";

const fs = require("node:fs");
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`${label} 启动失败：${errorMessage(result.error)}`);
  return result.status ?? 1;
}

function parseArguments() {
  const args = process.argv.slice(2);
  const build = args[0] === "--build";
  const targetName = args[build ? 1 : 0];
  if (!targetName) throw new Error("缺少要执行的脚本路径");
  const lexicalTarget = path.resolve(root, targetName);
  let target;
  try {
    target = fs.realpathSync(lexicalTarget);
  } catch (error) {
    throw new Error(`无法解析脚本路径：${errorMessage(error)}`);
  }
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(`脚本路径必须位于项目目录内：${targetName}`);
  if (!fs.statSync(target).isFile())
    throw new Error(`脚本不是普通文件：${target}`);
  return { build, target, extraArgs: args.slice(build ? 2 : 1) };
}

function restoreNodeAbi() {
  const npm = npmInvocation();
  return runCommand(
    npm.command,
    [...npm.prefix, "rebuild", "better-sqlite3"],
    "恢复 Node ABI",
  );
}

function prepareElectronAbi() {
  const builder = path.join(root, "node_modules", "electron-builder", "cli.js");
  if (!fs.existsSync(builder))
    throw new Error(`找不到 electron-builder CLI：${builder}`);
  return runCommand(
    process.execPath,
    [builder, "install-app-deps", "--arch=x64"],
    "准备 Electron ABI",
  );
}

function buildElectron() {
  const npm = npmInvocation();
  return runCommand(
    npm.command,
    [...npm.prefix, "run", "build:electron"],
    "构建 Electron",
  );
}

function runTask(task) {
  let status = prepareElectronAbi();
  if (status === 0 && task.build) status = buildElectron();
  if (status === 0)
    status = runCommand(
      process.execPath,
      [task.target, ...task.extraArgs],
      `执行 ${path.basename(task.target)}`,
    );
  return status;
}

function main() {
  let task;
  try {
    task = parseArguments();
  } catch (error) {
    console.error(`[run-with-electron-abi] ${errorMessage(error)}`);
    process.exitCode = 1;
    return;
  }
  let status = 1;
  let failure;
  let restoreFailure;
  try {
    status = runTask(task);
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
      console.error(`[run-with-electron-abi] ${errorMessage(failure)}`);
    if (restoreFailure)
      console.error(
        `[run-with-electron-abi] Node ABI 恢复失败：${errorMessage(restoreFailure)}`,
      );
    process.exitCode = 1;
    return;
  }
  process.exitCode = status;
}

main();
