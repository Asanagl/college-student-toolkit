/* eslint-env node */
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const required = [
  "APPX_IDENTITY_NAME",
  "APPX_APPLICATION_ID",
  "APPX_PUBLISHER",
  "APPX_PUBLISHER_DISPLAY_NAME",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(
    `Store 构建缺少 Partner Center 身份字段：${missing.join(", ")}。` +
      " 这些字段不是密码，不要提供账号或私钥。",
  );
}
if (process.env.APPX_PUBLISHER.trim() === "CN=ms") {
  throw new Error("Store 构建不能使用本地测试 publisher CN=ms。");
}

const packageVersion = process.env.APPX_PACKAGE_VERSION?.trim() || "";
const legacyBuildNumber = process.env.APPX_BUILD_NUMBER?.trim() || "";
if (legacyBuildNumber || process.env.APPX_SET_BUILD_NUMBER === "true") {
  throw new Error(
    "Partner Center 不接受非零第四段版本号；请使用 APPX_PACKAGE_VERSION=0.3.1 这样的三段版本。",
  );
}
if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error(
    "Store 构建必须显式设置 APPX_PACKAGE_VERSION（三段纯数字，例如 0.3.1）。",
  );
}
const packageVersionParts = packageVersion.split(".").map(Number);
if (packageVersionParts.some((part) => part > 65535)) {
  throw new Error("APPX_PACKAGE_VERSION 的每一段不能大于 65535。");
}

const root = path.resolve(__dirname, "..");
const env = {
  ...process.env,
  APPX_OUTPUT_DIR: process.env.APPX_OUTPUT_DIR || "release-v0.5.0-msix-store",
};
const result = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "package-appx.cjs")],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
