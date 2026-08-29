/* eslint-env node */

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const root = path.resolve(__dirname);
const staging = path.join(root, ".build", "toolchain");
const manifestPath = path.join(staging, "toolchain-manifest.json");
const inProgressPath = path.join(
  root,
  ".build",
  "toolchain.staging-in-progress",
);
const packageVersion = require(path.join(root, "package.json")).version;
const jobRunner = path.join(
  root,
  ".build",
  "acm-job-runner",
  "acm-job-runner.exe",
);
const requiredFiles = [
  "bin/g++.exe",
  "bin/gcc.exe",
  "bin/c++.exe",
  "bin/as.exe",
  "bin/ld.exe",
  "bin/ar.exe",
  "bin/libgcc_s_seh-1.dll",
  "bin/libstdc++-6.dll",
  "bin/libwinpthread-1.dll",
  "bin/libmcfgthread-2.dll",
];

function fail(message) {
  throw new Error(`[acm-builder] ${message}`);
}

function comparablePath(value) {
  return path
    .resolve(value)
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isReparsePoint(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return true;
    return (
      process.platform === "win32" &&
      comparablePath(fs.realpathSync.native(filePath)) !==
        comparablePath(filePath)
    );
  } catch {
    return true;
  }
}

function listFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (isReparsePoint(absolute))
        fail(`工具链包含 reparse point：${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else fail(`工具链包含特殊文件：${absolute}`);
    }
  };
  visit(directory);
  return files;
}

function isSafeManifestPath(value) {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes(":") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    }) ||
    value.startsWith("/")
  )
    return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function validateStaging() {
  if (fs.existsSync(inProgressPath))
    fail("工具链 staging 尚未成功完成，请重新运行 npm run stage:toolchain");
  if (!fs.existsSync(manifestPath))
    fail("缺少 toolchain-manifest.json，请先运行 npm run stage:toolchain");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail("toolchain-manifest.json 无法解析");
  }
  if (
    manifest.formatVersion !== 1 ||
    manifest.productVersion !== packageVersion
  )
    fail("工具链 manifest 版本与当前产品不一致");
  if (!/^x86_64-w64-mingw32(?:-.*)?$/.test(manifest.compiler?.target || ""))
    fail("工具链 manifest 目标不是 x64 MinGW");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    fail("工具链 manifest 文件清单为空");
  const listed = new Set();
  let totalBytes = 0;
  for (const item of manifest.files) {
    if (
      !item ||
      typeof item.path !== "string" ||
      !isSafeManifestPath(item.path) ||
      listed.has(item.path)
    )
      fail("工具链 manifest 文件路径无效或重复");
    const absolute = path.resolve(staging, ...item.path.split("/"));
    if (path.relative(staging, absolute).startsWith(".."))
      fail("工具链 manifest 路径越界");
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(`工具链 manifest 文件不存在或不是普通文件：${item.path}`);
    const buffer = fs.readFileSync(absolute);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (item.bytes !== buffer.byteLength || item.sha256 !== hash)
      fail(`工具链文件大小或 SHA-256 不匹配：${item.path}`);
    listed.add(item.path);
    totalBytes += buffer.byteLength;
  }
  if (manifest.totalBytes !== totalBytes) fail("工具链 manifest 总大小不匹配");
  for (const required of requiredFiles)
    if (!listed.has(required)) fail(`工具链缺少必要文件：${required}`);
  const actual = new Set(
    listFiles(staging)
      .filter((file) => file !== manifestPath)
      .map((file) => path.relative(staging, file).split(path.sep).join("/")),
  );
  if (
    actual.size !== listed.size ||
    [...actual].some((file) => !listed.has(file))
  )
    fail("工具链实际文件集合与 manifest 不一致");
}

if (!fs.existsSync(staging)) {
  throw new Error(
    "缺少 .build/toolchain；Store/ACM 包必须先运行 npm run stage:toolchain，并显式设置 ACM_MINGW_SOURCE。",
  );
}
validateStaging();
if (!fs.existsSync(jobRunner))
  fail("缺少 ACM Job Object helper，请先运行 npm run build:runner-helper");

module.exports = {
  extends: "./electron-builder.appx.cjs",
  extraResources: [
    {
      from: ".build/toolchain",
      to: "toolchain",
      filter: ["**/*"],
    },
    {
      from: ".build/acm-job-runner/acm-job-runner.exe",
      to: "acm-job-runner.exe",
    },
  ],
};
