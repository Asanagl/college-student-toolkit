/* eslint-env node */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname);
const staging = path.join(root, ".build", "toolchain");
if (!fs.existsSync(path.join(staging, "bin", "g++.exe"))) {
  throw new Error(
    "缺少 .build/toolchain；Store/ACM 包必须先运行 npm run stage:toolchain，并显式设置 ACM_MINGW_SOURCE。",
  );
}

module.exports = {
  extends: "./electron-builder.appx.cjs",
  extraResources: [
    {
      from: ".build/toolchain",
      to: "toolchain",
      filter: ["**/*"],
    },
  ],
};
