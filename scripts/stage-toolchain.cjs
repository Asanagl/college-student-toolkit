/* eslint-env node */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.resolve(process.env.ACM_MINGW_SOURCE || "");
const staging = path.join(root, ".build", "toolchain");
const MAX_STAGED_BYTES = 512 * 1024 * 1024;
const REQUIRED_BINARIES = [
  "g++.exe",
  "gcc.exe",
  "c++.exe",
  "cc1plus.exe",
  "cc1.exe",
  "as.exe",
  "ld.exe",
  "collect2.exe",
  "ar.exe",
  "libstdc++-6.dll",
  "libgcc_s_seh-1.dll",
  "libwinpthread-1.dll",
  "libmcfgthread-2.dll",
];

function fail(message) {
  throw new Error(`[stage-toolchain] ${message}`);
}

function ensureDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
    fail(`${label} 不存在：${directory}`);
}

function copyFile(relativePath) {
  const from = path.join(source, relativePath);
  const target = path.join(staging, relativePath);
  if (!fs.existsSync(from)) return false;
  const stat = fs.lstatSync(from);
  if (!stat.isFile() || stat.isSymbolicLink())
    fail(`工具链条目不是普通文件：${relativePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(from, target);
  return true;
}

function copyDirectory(relativePath) {
  const from = path.join(source, relativePath);
  if (!fs.existsSync(from)) return false;
  const stat = fs.lstatSync(from);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail(`工具链目录不是普通目录：${relativePath}`);
  fs.cpSync(from, path.join(staging, relativePath), {
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
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const binary of REQUIRED_BINARIES) {
    if (!copyFile(path.join("bin", binary)))
      fail(`缺少必要二进制：bin/${binary}`);
  }
  const version = findGccVersion();
  const directories = [
    path.join("include", "c++", version),
    path.join("include", "x86_64-w64-mingw32"),
    "include",
    path.join("lib", "gcc", "x86_64-w64-mingw32", version),
    path.join("libexec", "gcc", "x86_64-w64-mingw32", version),
    path.join("lib", "x86_64-w64-mingw32"),
  ];
  for (const directory of directories) {
    if (!copyDirectory(directory)) fail(`缺少必要目录：${directory}`);
  }
  const licenseNames = fs
    .readdirSync(source)
    .filter((name) => /^(?:license|copying|notice|build-info)/i.test(name));
  for (const name of licenseNames) copyFile(name);
  return { version, licenseNames };
}

function listFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`staging 含有符号链接：${absolute}`);
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
  const files = listFiles(staging)
    .map((absolute) => {
      const relative = path
        .relative(staging, absolute)
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
      path.join(staging, "bin", "g++.exe"),
      ["-dumpfullversion"],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    target = execFileSync(
      path.join(staging, "bin", "g++.exe"),
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

function main() {
  if (!process.env.ACM_MINGW_SOURCE?.trim())
    fail("必须显式设置 ACM_MINGW_SOURCE，拒绝猜测或从 PATH 复制工具链");
  const metadata = copyClosure();
  const manifest = collectManifest(metadata);
  fs.writeFileSync(
    path.join(staging, "toolchain-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[stage-toolchain] staged ${manifest.files.length} files (${manifest.totalBytes} bytes)`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
