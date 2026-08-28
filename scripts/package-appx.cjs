/* eslint-env node */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "node_modules", "electron-builder", "cli.js");

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function findArtifact(outputDir) {
  if (!fs.existsSync(outputDir))
    throw new Error(`输出目录不存在：${outputDir}`);
  const artifacts = fs
    .readdirSync(outputDir)
    .filter((name) => /\.(appx|msix)$/i.test(name));
  if (artifacts.length !== 1)
    throw new Error(
      `输出目录应有唯一 AppX/MSIX，实际找到 ${artifacts.length} 个`,
    );
  return path.join(outputDir, artifacts[0]);
}

function clearPreviousArtifacts(outputDir) {
  if (!fs.existsSync(outputDir)) return;
  const generated =
    /^college-student-toolkit-.*-(x64|ia32|arm64)\.(appx|msix)$/i;
  for (const name of fs.readdirSync(outputDir)) {
    if (generated.test(name))
      fs.rmSync(path.join(outputDir, name), { force: true });
  }
}

function main() {
  const env = {
    ...process.env,
    APPX_OUTPUT_DIR: process.env.APPX_OUTPUT_DIR || "release-v0.4.0-msix-local",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
  const outputDir = path.resolve(root, env.APPX_OUTPUT_DIR);
  clearPreviousArtifacts(outputDir);
  const status = run(
    process.execPath,
    [cli, "--config", "electron-builder.acm.cjs", "--win", "appx", "--x64"],
    env,
  );
  if (status !== 0) return status;
  const artifact = findArtifact(outputDir);
  const patcher = path.join(root, "scripts", "patch-appx-min-version.cjs");
  return run(process.execPath, [patcher, artifact], env);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(
    `[package-appx] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
