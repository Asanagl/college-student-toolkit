/* eslint-env node */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const required = [
  "dist/index.html",
  "dist-electron/main/main.js",
  "dist-electron/preload/preload.js",
  "dist-electron/preload/importBrowserPreload.js",
];

for (const relative of required) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `缺少构建产物 ${relative}，请先运行 npm run build:electron`,
    );
  }
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
if (packageJson.main !== "dist-electron/main/main.js") {
  throw new Error("package.json main 必须指向主进程构建产物");
}

const nativeBinding = path.join(
  root,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
if (!fs.existsSync(nativeBinding)) {
  throw new Error(
    "缺少 better-sqlite3 原生绑定，请先执行 electron-builder install-app-deps",
  );
}

const source = fs.readFileSync(
  path.join(root, "src", "shared", "types.ts"),
  "utf8",
);
if (
  !source.includes("DATA_EXPORT_BACKUP") ||
  !source.includes("OCR_COMPONENT_INSTALL")
) {
  throw new Error("共享 IPC 契约缺少 v0.3.0 数据备份或 OCR 通道");
}

console.log(
  "Package smoke prerequisites passed: renderer, main, preload, and entrypoint are present.",
);
