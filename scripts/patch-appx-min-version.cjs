/* eslint-env node */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STORE_FLOOR = "10.0.17134.0";
const DEFAULT_MIN_VERSION = "10.0.22621.0";
const DEFAULT_MAX_VERSION = "10.0.26100.0";

function parseVersion(value, label) {
  const parts = String(value).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`${label} 必须是四段 Windows 版本号：${value}`);
  }
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function resolveArtifact() {
  const value = process.argv[2] || process.env.APPX_PATH;
  if (!value) throw new Error("请提供待修复的 AppX/MSIX 路径");
  const artifact = path.resolve(value);
  if (!fs.existsSync(artifact)) throw new Error(`找不到包：${artifact}`);
  if (!/\.(appx|msix)$/i.test(artifact))
    throw new Error(`不是 AppX/MSIX：${artifact}`);
  return artifact;
}

function resolveMakeAppx() {
  const supplied = process.env.MAKEAPPX_PATH?.trim();
  const candidates = supplied ? [supplied] : [];
  const programFiles =
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const root = path.join(programFiles, "Windows Kits", "10", "bin");
  if (fs.existsSync(root)) {
    const versions = fs.readdirSync(root).sort().reverse();
    for (const version of versions) {
      candidates.push(path.join(root, version, "x64", "makeappx.exe"));
    }
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found)
    throw new Error("找不到 Windows SDK makeappx.exe；请设置 MAKEAPPX_PATH");
  return found;
}

function runTool(tool, args, label) {
  const result = spawnSync(tool, args, { stdio: "inherit", windowsHide: true });
  if (result.error)
    throw new Error(`${label} 启动失败：${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${label}失败，退出码：${result.status}`);
}

function setAttribute(tag, name, value) {
  const pattern = new RegExp(`(\\b${name}\\s*=\\s*["'])[^"']*(["'])`);
  if (pattern.test(tag)) return tag.replace(pattern, `$1${value}$2`);
  return tag.replace(/\s*\/>$/, ` ${name}="${value}" />`);
}

function patchManifest(manifestPath, minVersion, maxVersion) {
  let xml = fs.readFileSync(manifestPath, "utf8");
  let count = 0;
  xml = xml.replace(/<TargetDeviceFamily\b[^>]*\/>/g, (tag) => {
    count += 1;
    return setAttribute(
      setAttribute(tag, "MinVersion", minVersion),
      "MaxVersionTested",
      maxVersion,
    );
  });
  if (count === 0) throw new Error("AppxManifest.xml 缺少 TargetDeviceFamily");
  fs.writeFileSync(manifestPath, xml, "utf8");
  return count;
}

function removeGeneratedEntries(directory) {
  for (const name of [
    "AppxBlockMap.xml",
    "[Content_Types].xml",
    "AppxSignature.p7x",
  ]) {
    const entry = path.join(directory, name);
    if (name === "AppxSignature.p7x" && fs.existsSync(entry)) {
      throw new Error("输入包已有签名；请使用未签名 Store-only 包重新构建");
    }
    if (fs.existsSync(entry)) fs.rmSync(entry, { force: true });
  }
}

function replaceArtifact(source, target) {
  if (path.resolve(source) === path.resolve(target)) {
    const staged = `${target}.patched-${process.pid}`;
    fs.copyFileSync(source, staged);
    fs.copyFileSync(staged, target);
    fs.rmSync(staged, { force: true });
    return;
  }
  fs.copyFileSync(source, target);
}

function patchArtifact(input) {
  const minVersion =
    process.env.APPX_MIN_VERSION?.trim() || DEFAULT_MIN_VERSION;
  const maxVersion =
    process.env.APPX_MAX_VERSION_TESTED?.trim() || DEFAULT_MAX_VERSION;
  const minParts = parseVersion(minVersion, "APPX_MIN_VERSION");
  const maxParts = parseVersion(maxVersion, "APPX_MAX_VERSION_TESTED");
  if (
    compareVersions(minParts, parseVersion(STORE_FLOOR, "Store 最低版本")) <= 0
  ) {
    throw new Error(`APPX_MIN_VERSION 必须高于 ${STORE_FLOOR}`);
  }
  if (compareVersions(maxParts, minParts) < 0)
    throw new Error("MaxVersionTested 不能低于 MinVersion");
  const makeappx = resolveMakeAppx();
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-appx-patch-"),
  );
  const unpacked = path.join(tempRoot, "unpacked");
  const output = path.join(tempRoot, "patched.msix");
  fs.mkdirSync(unpacked);
  try {
    runTool(
      makeappx,
      ["unpack", "/p", input, "/d", unpacked, "/o"],
      "MSIX 解包",
    );
    const changed = patchManifest(
      path.join(unpacked, "AppxManifest.xml"),
      minVersion,
      maxVersion,
    );
    removeGeneratedEntries(unpacked);
    runTool(
      makeappx,
      ["pack", "/d", unpacked, "/p", output, "/o", "/h", "SHA256"],
      "MSIX 重打包",
    );
    replaceArtifact(output, input);
    console.log(
      JSON.stringify({
        artifact: input,
        targetFamilies: changed,
        minVersion,
        maxVersionTested: maxVersion,
      }),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  patchArtifact(resolveArtifact());
} catch (error) {
  console.error(
    `[patch-appx-min-version] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
