/* eslint-env node */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const yauzl = require("yauzl");

const root = path.resolve(__dirname, "..");

function resolveArtifact() {
  const supplied = process.argv[2] || process.env.APPX_PATH;
  if (supplied) return path.resolve(root, supplied);
  const output = path.join(
    root,
    process.env.APPX_OUTPUT_DIR || "release-v0.3.0-msix-local",
  );
  const candidates = fs.existsSync(output)
    ? fs.readdirSync(output).filter((name) => /\.(appx|msix)$/i.test(name))
    : [];
  if (candidates.length !== 1) {
    throw new Error(
      `请提供唯一的 AppX/MSIX 路径，当前候选数：${candidates.length}`,
    );
  }
  return path.join(output, candidates[0]);
}

function normalizeName(name) {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  try {
    // MakeAppx percent-encodes non-ASCII entry names while the manifest keeps Unicode.
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

function collectNames(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: true },
      (error, zip) => {
        if (error || !zip)
          return reject(error || new Error("无法打开 AppX/MSIX ZIP"));
        const names = [];
        zip.on("error", reject);
        zip.on("entry", (entry) => {
          names.push({ name: normalizeName(entry.fileName), entry });
          zip.readEntry();
        });
        zip.on("end", () => resolve(names));
        zip.readEntry();
      },
    );
  });
}

function readEntry(filePath, target) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: true },
      (error, zip) => {
        if (error || !zip)
          return reject(error || new Error("无法打开 AppX/MSIX ZIP"));
        let found = false;
        const fail = (reason) => reject(reason);
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          if (normalizeName(entry.fileName) !== target) {
            zip.readEntry();
            return;
          }
          found = true;
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream)
              return fail(streamError || new Error(`无法读取 ${target}`));
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("error", fail);
            stream.on("end", () => resolve(Buffer.concat(chunks)));
          });
        });
        zip.on("end", () => {
          if (!found) fail(new Error(`包内缺少 ${target}`));
        });
        zip.readEntry();
      },
    );
  });
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`));
  return match?.[1] || null;
}

function parseVersion(value, label) {
  const parts = String(value).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`${label} 不是四段 Windows 版本号：${value}`);
  }
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function checkTargetFamilies(xml) {
  const tags = [...xml.matchAll(/<TargetDeviceFamily\b[^>]*\/>/g)].map(
    (match) => match[0],
  );
  if (tags.length === 0)
    throw new Error("AppxManifest.xml 缺少 TargetDeviceFamily");
  const expected =
    process.env.APPX_EXPECTED_MIN_VERSION?.trim() || "10.0.17763.0";
  const expectedParts = parseVersion(expected, "APPX_EXPECTED_MIN_VERSION");
  for (const tag of tags) {
    const minVersion = attribute(tag, "MinVersion");
    if (
      !minVersion ||
      compareVersions(parseVersion(minVersion, "MinVersion"), expectedParts) < 0
    ) {
      throw new Error(
        `TargetDeviceFamily MinVersion 过低：${minVersion}，期望至少 ${expected}`,
      );
    }
  }
  return tags.map((tag) => ({
    name: attribute(tag, "Name"),
    minVersion: attribute(tag, "MinVersion"),
    maxVersionTested: attribute(tag, "MaxVersionTested"),
  }));
}

function checkManifest(xml) {
  const identityTag = xml.match(/<Identity\b[^>]*>/)?.[0];
  const appTag = xml.match(/<Application\b[^>]*>/)?.[0];
  if (!identityTag || !appTag)
    throw new Error("AppxManifest.xml 缺少 Identity 或 Application");
  const identity = {
    name: attribute(identityTag, "Name"),
    publisher: attribute(identityTag, "Publisher"),
    architecture: attribute(identityTag, "ProcessorArchitecture"),
    version: attribute(identityTag, "Version"),
  };
  const applicationId = attribute(appTag, "Id");
  const displayName =
    xml.match(/<DisplayName>([^<]+)<\/DisplayName>/)?.[1] || null;
  const publisherDisplayName =
    xml.match(/<PublisherDisplayName>([^<]+)<\/PublisherDisplayName>/)?.[1] ||
    null;
  const executable = attribute(appTag, "Executable");
  const targetDeviceFamilies = checkTargetFamilies(xml);
  if (identity.architecture !== "x64")
    throw new Error(`AppX 架构不是 x64：${identity.architecture}`);
  const expectedVersion =
    process.env.APPX_EXPECTED_VERSION?.trim() || "0.3.0.0";
  if (identity.version !== expectedVersion)
    throw new Error(
      `Manifest 版本不匹配：${identity.version}，期望 ${expectedVersion}`,
    );
  if (displayName !== "大学生工具组")
    throw new Error(`DisplayName 不匹配：${displayName}`);
  if (!executable || !executable.startsWith("app\\"))
    throw new Error(`Application.Executable 不在 app 目录：${executable}`);
  if (!applicationId)
    throw new Error(
      "Application 缺少 Id，无法核对 Partner Center Application ID",
    );
  const expectedPublisher = process.env.APPX_EXPECTED_PUBLISHER?.trim();
  if (expectedPublisher && identity.publisher !== expectedPublisher) {
    throw new Error(
      `Publisher 不匹配：实际 ${identity.publisher}，期望 ${expectedPublisher}`,
    );
  }
  const expectedApplicationId =
    process.env.APPX_EXPECTED_APPLICATION_ID?.trim();
  if (expectedApplicationId && applicationId !== expectedApplicationId) {
    throw new Error(
      `Application ID 不匹配：实际 ${applicationId}，期望 ${expectedApplicationId}`,
    );
  }
  const expectedPublisherDisplayName =
    process.env.APPX_EXPECTED_PUBLISHER_DISPLAY_NAME?.trim();
  if (
    expectedPublisherDisplayName &&
    publisherDisplayName !== expectedPublisherDisplayName
  ) {
    throw new Error(
      `Publisher Display Name 不匹配：实际 ${publisherDisplayName}，期望 ${expectedPublisherDisplayName}`,
    );
  }
  return {
    identity,
    applicationId,
    displayName,
    publisherDisplayName,
    executable,
    targetDeviceFamilies,
  };
}

function checkPeMachine(buffer) {
  if (buffer.length < 0x40 || buffer.subarray(0, 2).toString() !== "MZ")
    return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (
    peOffset + 6 > buffer.length ||
    buffer.subarray(peOffset, peOffset + 4).toString() !== "PE\0\0"
  )
    return null;
  return `0x${buffer.readUInt16LE(peOffset + 4).toString(16)}`;
}

async function verify() {
  const artifact = resolveArtifact();
  if (!fs.existsSync(artifact))
    throw new Error(`找不到 AppX/MSIX：${artifact}`);
  const entries = await collectNames(artifact);
  const names = entries.map((item) => item.name);
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  const required = [
    "AppxManifest.xml",
    "AppxBlockMap.xml",
    "[Content_Types].xml",
  ];
  for (const name of required) {
    if (!lowerNames.has(name.toLowerCase()))
      throw new Error(`包内缺少 ${name}`);
  }
  const manifestName = names.find(
    (name) => name.toLowerCase() === "appxmanifest.xml",
  );
  const manifest = checkManifest(
    (await readEntry(artifact, manifestName)).toString("utf8"),
  );
  const executableName = normalizeName(manifest.executable).toLowerCase();
  if (!lowerNames.has(executableName))
    throw new Error(`Application.Executable 不存在于包内：${manifest.executable}`);
  const asarName = names.find(
    (name) => name.toLowerCase() === "app/resources/app.asar",
  );
  const expectedNativeName =
    "app/resources/app.asar.unpacked/node_modules/better-sqlite3/build/release/better_sqlite3.node";
  const nativeName = names.find(
    (name) => name.toLowerCase() === expectedNativeName,
  );
  if (!asarName) throw new Error("包内缺少 app/resources/app.asar");
  if (!nativeName)
    throw new Error(`包内缺少 x64 SQLite binding：${expectedNativeName}`);
  const staging = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-appx-"),
  );
  try {
    const asarPath = path.join(staging, "app.asar");
    fs.writeFileSync(asarPath, await readEntry(artifact, asarName));
    const asarNames = asar.listPackage(asarPath).map(normalizeName);
    for (const requiredFile of [
      "dist/index.html",
      "dist-electron/main/main.js",
      "dist-electron/preload/preload.js",
    ]) {
      if (!asarNames.includes(requiredFile))
        throw new Error(`app.asar 缺少 ${requiredFile}`);
    }
    if (
      asarNames.some((name) => name.toLowerCase().endsWith("app-update.yml"))
    ) {
      throw new Error("Store 包不应包含 app-update.yml");
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const machine = checkPeMachine(await readEntry(artifact, nativeName));
  if (machine !== "0x8664")
    throw new Error(`better_sqlite3.node 不是 x64 PE：${machine}`);
  const warnings = [];
  if (manifest.identity.publisher === "CN=ms")
    warnings.push(
      "当前是 electron-builder 本地 Store-only 测试身份，不可直接提交 Store。",
    );
  if (lowerNames.has("app-update.yml"))
    throw new Error("Store 包根目录不应包含 app-update.yml");
  console.log(
    JSON.stringify(
      {
        artifact,
        format: path.extname(artifact),
        entries: names.length,
        manifest,
        nativeBinding: { path: nativeName, machine },
        warnings,
      },
      null,
      2,
    ),
  );
}

verify().catch((error) => {
  console.error(
    `[verify-appx] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
