/* eslint-env node */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.resolve(process.env.ACM_MINGW_SOURCE || "");
const buildRoot = path.join(root, ".build");
const staging = path.join(buildRoot, "toolchain");
const inProgressPath = path.join(buildRoot, "toolchain.staging-in-progress");
let workingStaging = null;
const MAX_STAGED_BYTES = 512 * 1024 * 1024;
const REQUIRED_BINARIES = [
  "g++.exe",
  "gcc.exe",
  "c++.exe",
  "as.exe",
  "ld.exe",
  "ar.exe",
  "libstdc++-6.dll",
  "libgcc_s_seh-1.dll",
  "libwinpthread-1.dll",
  "libmcfgthread-2.dll",
];

function fail(message) {
  throw new Error(`[stage-toolchain] ${message}`);
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

function ensureDirectory(directory, label) {
  if (
    !fs.existsSync(directory) ||
    isReparsePoint(directory) ||
    !fs.lstatSync(directory).isDirectory()
  )
    fail(`${label} 不存在：${directory}`);
}

function copyFile(relativePath) {
  const from = path.join(source, relativePath);
  const target = path.join(workingStaging, relativePath);
  if (!fs.existsSync(from)) return false;
  const stat = fs.lstatSync(from);
  if (!stat.isFile() || isReparsePoint(from))
    fail(`工具链条目不是普通文件：${relativePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(from, target);
  return true;
}

function copyDirectory(relativePath) {
  const from = path.join(source, relativePath);
  if (!fs.existsSync(from)) return false;
  const stat = fs.lstatSync(from);
  if (!stat.isDirectory() || isReparsePoint(from))
    fail(`工具链目录不是普通目录：${relativePath}`);
  listFiles(from);
  fs.cpSync(from, path.join(workingStaging, relativePath), {
    recursive: true,
    dereference: false,
    errorOnExist: false,
  });
  return true;
}

function findGccVersion() {
  const gccRoot = path.join(source, "lib", "gcc", "x86_64-w64-mingw32");
  ensureDirectory(gccRoot, "GCC 目标目录");
  const versions = fs
    .readdirSync(gccRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    );
  if (versions.length === 0) fail("找不到 x86_64-w64-mingw32 GCC 版本目录");
  return versions[0];
}

function copyClosure() {
  ensureDirectory(source, "ACM_MINGW_SOURCE");
  workingStaging = path.join(
    buildRoot,
    `toolchain-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  fs.rmSync(workingStaging, { recursive: true, force: true });
  fs.mkdirSync(workingStaging, { recursive: true });
  for (const binary of REQUIRED_BINARIES) {
    if (!copyFile(path.join("bin", binary)))
      fail(`缺少必要二进制：bin/${binary}`);
  }
  const version = findGccVersion();
  const directories = [
    path.join("lib", "gcc", "x86_64-w64-mingw32", version),
    path.join("libexec", "gcc", "x86_64-w64-mingw32", version),
    path.join("x86_64-w64-mingw32", "include"),
    path.join("x86_64-w64-mingw32", "lib"),
  ];
  for (const directory of directories) {
    if (!copyDirectory(directory)) fail(`缺少必要目录：${directory}`);
  }
  const licenseNames = fs
    .readdirSync(source)
    .filter((name) => /^(?:license|copying|notice|build-info)/i.test(name));
  for (const name of licenseNames) {
    const stat = fs.lstatSync(path.join(source, name));
    if (stat.isDirectory()) copyDirectory(name);
    else if (stat.isFile()) copyFile(name);
    else fail(`许可证条目不是普通文件或目录：${name}`);
  }
  return { version, licenseNames };
}

function listFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (isReparsePoint(absolute))
        fail(`工具链含有 reparse point：${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else fail(`staging 含有特殊文件：${absolute}`);
    }
  };
  visit(directory);
  return files;
}

function collectManifest(metadata) {
  let totalBytes = 0;
  const files = listFiles(workingStaging)
    .map((absolute) => {
      const relative = path
        .relative(workingStaging, absolute)
        .split(path.sep)
        .join("/");
      const buffer = fs.readFileSync(absolute);
      totalBytes += buffer.byteLength;
      return {
        path: relative,
        bytes: buffer.byteLength,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (totalBytes > MAX_STAGED_BYTES)
    fail(`工具链闭包超过 ${MAX_STAGED_BYTES} 字节上限：${totalBytes}`);
  let version = "unknown";
  let target = "unknown";
  try {
    version = execFileSync(
      path.join(workingStaging, "bin", "g++.exe"),
      ["-dumpfullversion"],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    target = execFileSync(
      path.join(workingStaging, "bin", "g++.exe"),
      ["-dumpmachine"],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    fail("无法从 staging g++ 读取版本或目标架构");
  }
  if (!/^x86_64-w64-mingw32(?:-.*)?$/.test(target))
    fail(`工具链目标不是 x64 MinGW：${target}`);
  return {
    formatVersion: 1,
    productVersion: require(path.join(root, "package.json")).version,
    compiler: {
      version,
      target,
      flags: ["-std=c++17", "-O2", "-pipe", "-Wall", "-Wextra"],
    },
    totalBytes,
    files,
    generatedAt: new Date().toISOString(),
    ...metadata,
  };
}

function promoteStaging() {
  const backup = path.join(
    buildRoot,
    `toolchain-previous-${process.pid}-${crypto.randomUUID()}.bak`,
  );
  let backedUp = false;
  try {
    if (fs.existsSync(staging)) {
      fs.renameSync(staging, backup);
      backedUp = true;
    }
    fs.renameSync(workingStaging, staging);
    workingStaging = null;
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(inProgressPath, { force: true });
  } catch (error) {
    if (backedUp && !fs.existsSync(staging)) {
      try {
        fs.renameSync(backup, staging);
      } catch {
        // Keep the backup when restoration is not possible.
      }
    }
    throw error;
  }
}

function main() {
  if (!process.env.ACM_MINGW_SOURCE?.trim())
    fail("必须显式设置 ACM_MINGW_SOURCE，拒绝猜测或从 PATH 复制工具链");
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.writeFileSync(
    inProgressPath,
    `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
    "utf8",
  );
  const metadata = copyClosure();
  const manifest = collectManifest(metadata);
  fs.writeFileSync(
    path.join(workingStaging, "toolchain-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  promoteStaging();
  console.log(
    `[stage-toolchain] staged ${manifest.files.length} files (${manifest.totalBytes} bytes)`,
  );
}

try {
  main();
} catch (error) {
  if (workingStaging)
    fs.rmSync(workingStaging, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
