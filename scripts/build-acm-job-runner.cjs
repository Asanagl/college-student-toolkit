/* eslint-env node */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "native", "acm-job-runner.cpp");
const outputRoot = path.join(root, ".build", "acm-job-runner");
const output = path.join(outputRoot, "acm-job-runner.exe");
const temporary = path.join(
  outputRoot,
  `acm-job-runner-${process.pid}-${crypto.randomUUID()}.tmp.exe`,
);

function fail(message) {
  throw new Error(`[build-acm-job-runner] ${message}`);
}

function compilerPath() {
  const staged = path.join(root, ".build", "toolchain", "bin", "g++.exe");
  if (fs.existsSync(staged)) return staged;
  const explicit = process.env.ACM_MINGW_SOURCE?.trim();
  if (explicit) return path.join(path.resolve(explicit), "bin", "g++.exe");
  fail("缺少 .build/toolchain/bin/g++.exe，请先运行 npm run stage:toolchain");
}

function isX64Pe(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 0x40 || buffer.subarray(0, 2).toString() !== "MZ")
    return false;
  const offset = buffer.readUInt32LE(0x3c);
  return (
    offset + 6 <= buffer.length &&
    buffer.subarray(offset, offset + 4).toString() === "PE\0\0" &&
    buffer.readUInt16LE(offset + 4) === 0x8664
  );
}

function build() {
  if (process.platform !== "win32")
    fail("Job Object helper 仅支持 Windows 构建");
  if (!fs.existsSync(source)) fail(`缺少源文件：${source}`);
  const compiler = compilerPath();
  if (!fs.existsSync(compiler)) fail(`找不到 g++.exe：${compiler}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.rmSync(temporary, { force: true });
  try {
    execFileSync(
      compiler,
      [
        source,
        "-std=c++17",
        "-O2",
        "-s",
        "-static",
        "-static-libgcc",
        "-static-libstdc++",
        "-mconsole",
        "-municode",
        "-o",
        temporary,
      ],
      {
        cwd: root,
        windowsHide: true,
        stdio: "inherit",
        env: {
          ...process.env,
          PATH: [process.env.PATH?.trim(), path.dirname(compiler)]
            .filter(Boolean)
            .join(path.delimiter),
        },
      },
    );
    if (!fs.existsSync(temporary) || !isX64Pe(temporary))
      fail("生成的 helper 不是 x64 PE");
    fs.rmSync(output, { force: true });
    fs.renameSync(temporary, output);
    console.log(`[build-acm-job-runner] built ${output}`);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

try {
  build();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
