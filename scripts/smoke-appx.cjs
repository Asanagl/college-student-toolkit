/* eslint-env node */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const output = process.env.APPX_OUTPUT_DIR || "release-v0.4.0-msix-local";
const unpacked = path.join(root, output, "win-unpacked");
const executable = path.join(unpacked, "大学生工具组.exe");
const electron = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);

function waitForFile(filePath, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() - started >= timeoutMs)
        return reject(new Error(`等待文件超时：${filePath}`));
      setTimeout(poll, 250);
    };
    poll();
  });
}

async function waitForDatabase(
  filePath,
  child,
  scriptPath,
  unpacked,
  timeoutMs = 30000,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `AppX 进程提前退出（code=${child.exitCode}），未完成 SQLite 初始化。`,
      );
    }
    if (fs.existsSync(filePath)) {
      try {
        const result = await queryDatabase(
          filePath,
          scriptPath,
          unpacked,
          true,
        );
        if (result.ready) return;
      } catch {
        // 数据库可能仍处于迁移事务或写锁中，下一轮继续读取。
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待 SQLite schema 2 初始化超时：${filePath}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function queryDatabase(dbPath, scriptPath, unpacked, allowIncomplete = false) {
  const source = [
    "const { app } = require('electron');",
    "const path = require('node:path');",
    "app.whenReady().then(() => {",
    "  const allowIncomplete = process.env.COLLEGE_TOOLKIT_ALLOW_INCOMPLETE === '1';",
    "  const Database = require(path.join(process.env.COLLEGE_TOOLKIT_APP_DIR, 'resources', 'app.asar', 'node_modules', 'better-sqlite3'));",
    "  const db = new Database(process.argv[2], { readonly: true });",
    "  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all().map((row) => row.name);",
    "  const formula = tables.includes('gpa_formula') ? db.prepare(\"SELECT formula FROM gpa_formula WHERE id='default'\").get()?.formula ?? null : null;",
    "  const schema = db.pragma('user_version', { simple: true });",
    "  const expectedTables = ['courses', 'exams', 'gpa_formula', 'grades', 'labs', 'period_config', 'schedule_items'];",
    "  const ready = schema === 2 && JSON.stringify(tables) === JSON.stringify(expectedTables) && formula === 'SUM(credit * gradePoint) / SUM(credit)';",
    "  db.close();",
    "  if (!ready && !allowIncomplete) throw new Error(`数据库尚未完成 schema 2 初始化：${JSON.stringify({ schema, tables, formula })}`);",
    "  console.log(JSON.stringify({ schema, tables, formula, ready }));",
    "  app.exit(0);",
    "}).catch((error) => {",
    "  if (process.env.COLLEGE_TOOLKIT_ALLOW_INCOMPLETE === '1') { console.log(JSON.stringify({ ready: false, error: String(error) })); app.exit(0); return; }",
    "  console.error(error);",
    "  app.exit(1);",
    "});",
  ].join("\n");
  fs.writeFileSync(scriptPath, source, "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [scriptPath, dbPath], {
      cwd: root,
      env: {
        ...process.env,
        COLLEGE_TOOLKIT_APP_DIR: unpacked,
        COLLEGE_TOOLKIT_ALLOW_INCOMPLETE: allowIncomplete ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0)
        return reject(
          new Error(`Electron SQLite 查询失败：${stderr || stdout}`),
        );
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop()));
      } catch {
        reject(new Error(`无法解析 SQLite 查询结果：${stdout}`));
      }
    });
  });
}

function removeProfile(profile) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      const waitUntil = Date.now() + 250;
      while (Date.now() < waitUntil) {
        // Retry only the generated profile; no broad temporary-directory cleanup.
      }
    }
  }
}

async function run() {
  if (!fs.existsSync(executable))
    throw new Error(`找不到 unpacked 可执行文件：${executable}`);
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-msix-smoke-"),
  );
  const queryScript = path.join(profile, "query-db.cjs");
  let appProcess;
  let completed = false;
  try {
    appProcess = spawn(
      executable,
      [`--user-data-dir=${profile}`, "--disable-gpu"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, COLLEGE_TOOLKIT_STORE_SMOKE: "1" },
      },
    );
    let appStdout = "";
    let appStderr = "";
    appProcess.stdout?.on("data", (chunk) => {
      appStdout += chunk.toString();
    });
    appProcess.stderr?.on("data", (chunk) => {
      appStderr += chunk.toString();
    });
    const dbPath = path.join(profile, "data.db");
    try {
      await waitForDatabase(dbPath, appProcess, queryScript, unpacked);
    } catch (error) {
      if (appStdout || appStderr)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nstdout: ${appStdout}\nstderr: ${appStderr}`,
        );
      throw error;
    }
    await waitForFile(path.join(profile, "portable-settings.json"));
    appProcess.kill();
    await waitForExit(appProcess);
    const result = await queryDatabase(dbPath, queryScript, unpacked);
    const expectedTables = [
      "courses",
      "exams",
      "gpa_formula",
      "grades",
      "labs",
      "period_config",
      "schedule_items",
    ];
    if (
      result.schema !== 2 ||
      JSON.stringify(result.tables) !== JSON.stringify(expectedTables)
    )
      throw new Error(
        `Store 包启动后的 schema/表结构不符合预期：${JSON.stringify(result)}`,
      );
    if (result.formula !== "SUM(credit * gradePoint) / SUM(credit)")
      throw new Error(`默认 GPA 公式不符合预期：${result.formula}`);
    console.log(
      JSON.stringify(
        {
          executable,
          profile,
          schema: result.schema,
          tables: result.tables,
          formula: result.formula,
        },
        null,
        2,
      ),
    );
    completed = true;
  } finally {
    if (appProcess && appProcess.exitCode === null) appProcess.kill();
    if (completed) removeProfile(profile);
    else console.error(`[smoke-appx] 保留失败现场供诊断：${profile}`);
  }
}

run().catch((error) => {
  console.error(
    `[smoke-appx] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
