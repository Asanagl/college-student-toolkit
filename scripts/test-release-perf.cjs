/* eslint-env node */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { performance } = require("node:perf_hooks");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageManifest = require(path.join(root, "package.json"));
const productVersion = String(packageManifest.version || "").trim();
if (!/^\d+\.\d+\.\d+$/.test(productVersion))
  throw new Error(`package.json version 无效：${productVersion}`);
const OCR_COMPONENT = {
  id: "ocr-chi-sim",
  version: "1.0.0",
  assetUrl:
    "https://github.com/Asanagl/college-student-toolkit/releases/download/v0.3.0/ocr-chi-sim-1.0.0.traineddata.gz",
  compressedBytes: 1_710_883,
  extractedBytes: 2_471_033,
  compressedSha256:
    "037B9E59AB3598EF6E892E1DC9AB7D34AE993B555C7296B9E08A2F0675648A9E",
  extractedSha256:
    "9784F7C917C546424B690FCDE708CE1F604A4393D08BB51DDAB146D7D7C794E6",
};
const OCR_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function restartWithElectronRuntime() {
  if (process.versions.electron) return;
  const runtime = path.join(
    root,
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  if (!fs.existsSync(runtime)) return;
  const result = spawnSync(runtime, [__filename, ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

restartWithElectronRuntime();

const { _electron: electron } = require("playwright");
const Database = require("better-sqlite3");
const executable = path.resolve(
  process.env.PACKAGED_EXECUTABLE?.trim() ||
    `release-v${productVersion}-msix-local/win-unpacked/大学生工具组.exe`,
);
const reportPath = path.resolve(
  root,
  process.env.PERF_REPORT_PATH?.trim() ||
    `docs/v${productVersion}-performance-release.json`,
);
let runningReport = null;
const dataset = {
  schedules: 1000,
  courses: 500,
  exams: 1000,
  labs: 1000,
  grades: 10000,
};
const thresholds = {
  sqliteQueryMs: 100,
  sqliteCrudMs: 100,
  ipcListMs: 1000,
  ipcCrudMs: 150,
  pageSwitchMs: 300,
  coldStartMs: 3000,
  reminderP95Ms: 1000,
  reminderMaxMs: 1500,
  backupMs: 5000,
  idleRssMiB: 300,
  soakGrowthRatio: 0.1,
};
const metricPolicy = {
  required: {
    latency: [
      "sqlite.query",
      "sqlite.crud",
      "ipc.lists.schedules",
      "ipc.lists.courses",
      "ipc.lists.exams",
      "ipc.lists.labs",
      "ipc.lists.grades",
      "ipc.lists.gradeDashboard",
      "ipc.crud",
      "pageSwitch.overall",
      "reminder",
      "backup.export",
      "backup.import",
      "coldStart",
    ],
    health: ["idleRss", "soak", "shutdown"],
    ocrEvidence: ["ocr"],
  },
  optional: [
    "pageSwitch.byRoute./schedule",
    "pageSwitch.byRoute./timetable",
    "pageSwitch.byRoute./exam",
    "pageSwitch.byRoute./lab",
    "pageSwitch.byRoute./grade",
  ],
};

function envNumber(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function envFlag(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name] !== "0" && process.env[name] !== "false";
}

function settingsForBenchmark(backgroundImage = null) {
  return {
    portableSettingsVersion: 1,
    themeMode: "system",
    timetable: { semesterStart: null },
    dnd: { enabled: true, startTime: "00:00", endTime: "00:00" },
    notificationHistory: [],
    appearance: {
      material: "none",
      backgroundImage,
      blurRadius: 0,
      clarity: 100,
    },
  };
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE schedule_items (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, start_time TEXT NOT NULL,
      end_time TEXT NOT NULL, reminder_offset INTEGER NOT NULL,
      repeat_rule TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE courses (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, teacher TEXT, location TEXT,
      start_week INTEGER NOT NULL, end_week INTEGER NOT NULL, weekday INTEGER NOT NULL,
      start_period INTEGER NOT NULL, end_period INTEGER NOT NULL, color TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE period_config (
      period_index INTEGER PRIMARY KEY, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      break_after INTEGER NOT NULL, is_lab INTEGER NOT NULL, reminder_offset INTEGER NOT NULL
    );
    CREATE TABLE exams (
      id TEXT PRIMARY KEY, course_name TEXT NOT NULL, date TEXT NOT NULL,
      start_time TEXT NOT NULL, end_time TEXT NOT NULL, location TEXT, seat TEXT,
      notes TEXT, reminder_offsets TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE labs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL,
      start_time TEXT NOT NULL, end_time TEXT NOT NULL, location TEXT, instructor TEXT,
      notes TEXT, reminder_offsets TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE grades (
      id TEXT PRIMARY KEY, course_name TEXT NOT NULL, semester TEXT NOT NULL,
      credit REAL NOT NULL, grade_point REAL NOT NULL, score REAL,
      is_degree_course INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE gpa_formula (
      id TEXT PRIMARY KEY, formula TEXT NOT NULL, is_default INTEGER NOT NULL,
      name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_courses_weekday_week ON courses(weekday, start_week);
    CREATE INDEX idx_exams_date ON exams(date);
    CREATE INDEX idx_labs_date ON labs(date);
    CREATE INDEX idx_grades_semester ON grades(semester);
  `);
}

function seedDatabase(filePath) {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  createSchema(db);
  const now = new Date().toISOString();
  const insertSchedule = db.prepare(`
    INSERT INTO schedule_items
      (id, title, start_time, end_time, reminder_offset, repeat_rule, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCourse = db.prepare(`
    INSERT INTO courses
      (id, name, teacher, location, start_week, end_week, weekday,
       start_period, end_period, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertExam = db.prepare(`
    INSERT INTO exams
      (id, course_name, date, start_time, end_time, location, seat, notes,
       reminder_offsets, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLab = db.prepare(`
    INSERT INTO labs
      (id, name, date, start_time, end_time, location, instructor, notes,
       reminder_offsets, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGrade = db.prepare(`
    INSERT INTO grades
      (id, course_name, semester, credit, grade_point, score,
       is_degree_course, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction(() => {
    for (let index = 0; index < dataset.schedules; index += 1) {
      const id = randomUUID();
      insertSchedule.run(
        id,
        `性能日程 ${index}`,
        "2099-01-01T09:00:00.000Z",
        "2099-01-01T10:00:00.000Z",
        10,
        "none",
        now,
        now,
      );
    }
    for (let index = 0; index < dataset.courses; index += 1) {
      insertCourse.run(
        randomUUID(),
        `性能课程 ${index}`,
        `教师 ${index % 30}`,
        `教学楼 ${index % 20}`,
        1,
        16,
        (index % 7) + 1,
        (index % 12) + 1,
        (index % 12) + 1,
        "#4285F4",
        now,
        now,
      );
    }
    for (let index = 0; index < dataset.exams; index += 1) {
      insertExam.run(
        randomUUID(),
        `性能考试 ${index}`,
        "2099-01-01",
        "09:00",
        "11:00",
        `考场 ${index % 50}`,
        String((index % 60) + 1),
        "性能基准数据",
        "[1440,60]",
        now,
        now,
      );
    }
    for (let index = 0; index < dataset.labs; index += 1) {
      insertLab.run(
        randomUUID(),
        `性能实验 ${index}`,
        "2099-01-01",
        "14:00",
        "16:00",
        `实验楼 ${index % 50}`,
        `实验教师 ${index % 30}`,
        "性能基准数据",
        "[1440,60]",
        now,
        now,
      );
    }
    for (let index = 0; index < dataset.grades; index += 1) {
      insertGrade.run(
        randomUUID(),
        `性能成绩 ${index}`,
        `2026-2027-${(index % 2) + 1}`,
        1 + (index % 4),
        2 + (index % 21) / 10,
        60 + (index % 41),
        index % 3 === 0 ? 1 : 0,
        now,
        now,
      );
    }
    db.prepare(
      `INSERT INTO gpa_formula
       (id, formula, is_default, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "default",
      "SUM(credit * gradePoint) / SUM(credit)",
      1,
      "默认公式",
      now,
      now,
    );
    const periods = [
      [1, "08:00", "08:45"],
      [2, "08:55", "09:40"],
      [3, "09:50", "10:35"],
      [4, "10:55", "11:40"],
      [5, "13:30", "14:15"],
      [6, "14:25", "15:10"],
      [7, "15:20", "16:05"],
      [8, "16:15", "17:00"],
      [9, "18:30", "19:15"],
      [10, "19:25", "20:10"],
      [11, "20:20", "21:05"],
      [12, "21:15", "22:00"],
    ];
    const insertPeriod = db.prepare(
      `INSERT INTO period_config
       (period_index, start_time, end_time, break_after, is_lab, reminder_offset)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, start, end] of periods)
      insertPeriod.run(index, start, end, index === 12 ? 0 : 10, 0, 10);
  });
  transaction();
  db.pragma("user_version = 2");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

function writeBenchmarkSettings(profile, includeBackground) {
  fs.writeFileSync(
    path.join(profile, "portable-settings.json"),
    JSON.stringify(
      settingsForBenchmark(includeBackground ? "benchmark.png" : null),
      null,
      2,
    ),
    "utf8",
  );
  if (!includeBackground) return;
  const directory = path.join(profile, "backgrounds");
  fs.mkdirSync(directory, { recursive: true });
  const source = fs.readFileSync(path.join(root, "resources", "icon.png"));
  const padding = randomBytes(10 * 1024 * 1024 - source.length);
  fs.writeFileSync(
    path.join(directory, "benchmark.png"),
    Buffer.concat([source, padding]),
  );
}

function prepareProfile(includeBackground = false) {
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-perf-"),
  );
  seedDatabase(path.join(profile, "data.db"));
  writeBenchmarkSettings(profile, includeBackground);
  return profile;
}

function unwrap(result, label) {
  if (!result || result.ok !== true)
    throw new Error(`${label} failed: ${result?.error || "unknown IPC error"}`);
  return result.data;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex").toUpperCase();
}

function resolveBenchmarkFile(configured, label) {
  const lexicalPath = path.resolve(root, configured);
  let filePath;
  try {
    filePath = fs.realpathSync(lexicalPath);
  } catch (error) {
    throw new Error(
      `${label} 无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const relativePath = path.relative(root, filePath);
  if (
    !relativePath ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
    throw new Error(`${label} 必须位于项目目录内：${configured}`);
  if (!fs.statSync(filePath).isFile()) throw new Error(`${label} 不是普通文件`);
  return { filePath, relativePath: relativePath.replaceAll(path.sep, "/") };
}

function resolveOcrBenchmarkInput() {
  const archive = process.env.PERF_OCR_ARCHIVE_PATH?.trim();
  const image = process.env.PERF_OCR_IMAGE_PATH?.trim();
  if (!archive && !image) return null;
  if (!archive || !image)
    throw new Error(
      "真实 OCR 性能需要同时设置 PERF_OCR_ARCHIVE_PATH 和 PERF_OCR_IMAGE_PATH",
    );
  const archiveFile = resolveBenchmarkFile(archive, "OCR 压缩资产");
  const archiveData = fs.readFileSync(archiveFile.filePath);
  if (
    archiveData.length !== OCR_COMPONENT.compressedBytes ||
    sha256(archiveData) !== OCR_COMPONENT.compressedSha256
  )
    throw new Error("OCR 压缩资产大小或 SHA-256 与 manifest 不匹配");
  const extractedData = zlib.gunzipSync(archiveData);
  if (
    extractedData.length !== OCR_COMPONENT.extractedBytes ||
    sha256(extractedData) !== OCR_COMPONENT.extractedSha256
  )
    throw new Error("OCR 解压资产大小或 SHA-256 与 manifest 不匹配");
  const imageFile = resolveBenchmarkFile(image, "OCR 识别图片");
  const imageData = fs.readFileSync(imageFile.filePath);
  if (imageData.length === 0 || imageData.length > OCR_IMAGE_MAX_BYTES)
    throw new Error("OCR 识别图片大小不在允许范围内");
  return {
    archive: {
      path: archiveFile.relativePath,
      bytes: archiveData.length,
      sha256: sha256(archiveData),
    },
    extracted: {
      bytes: extractedData.length,
      sha256: sha256(extractedData),
      data: extractedData,
    },
    image: {
      path: imageFile.relativePath,
      bytes: imageData.length,
      sha256: sha256(imageData),
      data: imageData,
    },
  };
}

function seedOcrComponent(profile, input) {
  const target = path.join(
    profile,
    "components",
    OCR_COMPONENT.id,
    OCR_COMPONENT.version,
    "chi_sim.traineddata",
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, input.extracted.data);
}

async function launchPackaged(profile, backupPath, importPath) {
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`],
    env: {
      ...childEnvironment,
      COLLEGE_TOOLKIT_STORE_SMOKE: "1",
      COLLEGE_TOOLKIT_E2E_BACKUP_PATH: backupPath || "",
      COLLEGE_TOOLKIT_E2E_IMPORT_PATH: importPath || "",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => typeof window.api === "object");
  await page.getByText("大学生工具组").first().waitFor();
  return { app, page };
}

async function closeSession(session) {
  if (!session) return;
  try {
    await session.app.close();
  } catch {
    // The process may already have exited after a packaged startup failure.
  }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1,
  );
  return Number(sorted[index].toFixed(2));
}

function summarize(values, limits = {}) {
  if (values.length === 0) {
    return {
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      thresholds: limits,
      skipped: true,
      reason: "该路由在短配置采样轮次中未命中；完整 30 次运行会覆盖所有路由",
    };
  }
  const p95 = percentile(values, 0.95);
  const max = values.length ? Number(Math.max(...values).toFixed(2)) : null;
  const passP95 =
    limits.p95Ms === undefined || (p95 !== null && p95 < limits.p95Ms);
  const passMax =
    limits.maxMs === undefined || (max !== null && max < limits.maxMs);
  return {
    sampleCount: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: p95,
    maxMs: max,
    thresholds: limits,
    pass: passP95 && passMax,
  };
}

async function collectAsync(action, iterations, warmups) {
  for (let index = 0; index < warmups; index += 1) await action();
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await action();
    values.push(performance.now() - started);
  }
  return values;
}

function collectSync(action, iterations, warmups) {
  for (let index = 0; index < warmups; index += 1) action();
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    action();
    values.push(performance.now() - started);
  }
  return values;
}

function createSqliteMetrics(dbPath, iterations, warmups) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  const query = db.prepare(
    "SELECT * FROM grades WHERE semester = ? ORDER BY course_name LIMIT 1000",
  );
  const insert = db.prepare(`
    INSERT INTO schedule_items
      (id, title, start_time, end_time, reminder_offset, repeat_rule, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare("UPDATE schedule_items SET title = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM schedule_items WHERE id = ?");
  const mutation = db.transaction(() => {
    const id = randomUUID();
    const now = new Date().toISOString();
    insert.run(
      id,
      "SQLite 性能 scratch",
      "2099-01-01",
      "2099-01-01",
      10,
      "none",
      now,
      now,
    );
    update.run("SQLite 性能 scratch updated", id);
    remove.run(id);
  });
  const queryValues = collectSync(
    () => query.all("2026-2027-1"),
    iterations,
    warmups,
  );
  const crudValues = collectSync(mutation, iterations, warmups);
  db.close();
  return {
    query: summarize(queryValues, { p95Ms: thresholds.sqliteQueryMs }),
    crud: summarize(crudValues, { p95Ms: thresholds.sqliteCrudMs }),
  };
}

async function createIpcMetrics(page, iterations, warmups) {
  const listTargets = [
    ["schedules", () => page.evaluate(() => window.api.schedule.list())],
    ["courses", () => page.evaluate(() => window.api.timetable.list())],
    ["exams", () => page.evaluate(() => window.api.exam.list())],
    ["labs", () => page.evaluate(() => window.api.lab.list())],
    [
      "grades",
      () =>
        page.evaluate(() =>
          window.api.grade.listPage({
            semester: "2026-2027-1",
            page: 1,
            pageSize: 20,
          }),
        ),
    ],
    [
      "gradeDashboard",
      () => page.evaluate(() => window.api.grade.getDashboard()),
    ],
  ];
  const lists = {};
  for (const [name, action] of listTargets) {
    lists[name] = summarize(
      await collectAsync(
        async () => unwrap(await action(), `list ${name}`),
        iterations,
        warmups,
      ),
      { p95Ms: thresholds.ipcListMs },
    );
  }
  const crudValues = await collectAsync(
    async () => {
      const item = {
        courseName: "IPC 性能 scratch",
        semester: "2026-2027-1",
        credit: 3,
        gradePoint: 3.5,
        score: 88,
        isDegreeCourse: true,
      };
      const added = unwrap(
        await page.evaluate((value) => window.api.grade.add(value), item),
        "grade add",
      );
      unwrap(
        await page.evaluate(
          ({ id }) => window.api.grade.update(id, { score: 89 }),
          added,
        ),
        "grade update",
      );
      unwrap(
        await page.evaluate((id) => window.api.grade.remove(id), added.id),
        "grade remove",
      );
    },
    iterations,
    warmups,
  );
  return {
    lists,
    crud: summarize(crudValues, { p95Ms: thresholds.ipcCrudMs }),
  };
}

async function createPageMetrics(page, iterations, warmups) {
  const routes = [
    ["日程", "schedule"],
    ["课程表", "timetable"],
    ["考试安排", "exam"],
    ["实验提醒", "lab"],
    ["成绩显示", "grade"],
  ];
  const byRoute = Object.fromEntries(
    routes.map(([, route]) => [`/${route}`, []]),
  );
  let cursor = 0;
  const action = async () => {
    const [label, route] = routes[cursor % routes.length];
    cursor += 1;
    const started = performance.now();
    await page.locator(".ant-menu-item").filter({ hasText: label }).click();
    await page.waitForFunction((value) => {
      if (!window.location.hash.endsWith(value)) return false;
      if (value !== "/grade") return true;
      return document.querySelectorAll(".ant-table-tbody tr").length > 0;
    }, `/${route}`);
    return { route: `/${route}`, elapsedMs: performance.now() - started };
  };
  for (let index = 0; index < warmups; index += 1) await action();
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const sample = await action();
    values.push(sample.elapsedMs);
    byRoute[sample.route].push(sample.elapsedMs);
  }
  return {
    overall: summarize(values, { p95Ms: thresholds.pageSwitchMs }),
    byRoute: Object.fromEntries(
      Object.entries(byRoute).map(([route, samples]) => [
        route,
        summarize(samples, { p95Ms: thresholds.pageSwitchMs }),
      ]),
    ),
  };
}

async function createReminderMetrics(page, iterations, warmups) {
  unwrap(
    await page.evaluate(() =>
      window.api.notify.setDnd({
        enabled: true,
        startTime: "00:00",
        endTime: "00:00",
      }),
    ),
    "set dnd",
  );
  const values = await collectAsync(
    async () => {
      unwrap(
        await page.evaluate(() =>
          window.api.notify.send({
            title: "性能提醒",
            body: "不弹出系统通知的 benchmark 记录",
            source: "system",
          }),
        ),
        "notification send",
      );
    },
    iterations,
    warmups,
  );
  return summarize(values, {
    p95Ms: thresholds.reminderP95Ms,
    maxMs: thresholds.reminderMaxMs,
  });
}

async function createBackupMetrics(page, backupPath, iterations, warmups) {
  const exportValues = await collectAsync(
    async () => {
      const result = unwrap(
        await page.evaluate(() => window.api.data.exportBackup()),
        "backup export",
      );
      if (!result || result.bytes < 10 * 1024 * 1024)
        throw new Error("backup fixture is smaller than 10 MiB");
    },
    iterations,
    warmups,
  );
  const importValues = await collectAsync(
    async () => {
      const prepared = unwrap(
        await page.evaluate(() => window.api.data.prepareImport()),
        "backup prepare",
      );
      unwrap(
        await page.evaluate(
          (token) => window.api.data.commitImport(token),
          prepared.inspection.token,
        ),
        "backup commit",
      );
    },
    iterations,
    warmups,
  );
  return {
    archiveBytes: fs.statSync(backupPath).size,
    export: summarize(exportValues, {
      p95Ms: thresholds.backupMs,
      maxMs: thresholds.backupMs,
    }),
    import: summarize(importValues, {
      p95Ms: thresholds.backupMs,
      maxMs: thresholds.backupMs,
    }),
  };
}

async function createOcrMetrics(page, input, iterations, warmups) {
  const status = unwrap(
    await page.evaluate(() => window.api.ocrComponent.getStatus()),
    "OCR status",
  );
  if (status.state !== "ready")
    throw new Error(`OCR 组件未就绪：${status.state}`);
  const imageBase64 = input.image.data.toString("base64");
  const values = await collectAsync(
    async () => {
      unwrap(
        await page.evaluate(
          (encoded) => window.api.importBrowser.runOcr(encoded),
          imageBase64,
        ),
        "OCR recognize",
      );
    },
    iterations,
    warmups,
  );
  return {
    ...status,
    ...summarize(values),
    asset: {
      url: OCR_COMPONENT.assetUrl,
      id: OCR_COMPONENT.id,
      version: OCR_COMPONENT.version,
      compressedBytes: input.archive.bytes,
      compressedSha256: input.archive.sha256,
      extractedBytes: input.extracted.bytes,
      extractedSha256: input.extracted.sha256,
    },
    image: {
      path: input.image.path,
      bytes: input.image.bytes,
      sha256: input.image.sha256,
    },
    evidence: {
      kind: "real-ocr-performance",
      real: true,
      recognition: "packaged OCR IPC with validated Release language data",
    },
  };
}

function isTransientAppMetricsError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Execution context was destroyed");
}

async function collectAppMetrics(app) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await app.evaluate(({ app: electronApp }) =>
        electronApp.getAppMetrics().map((item) => ({
          type: item.type,
          pid: item.pid,
          workingSetSize: item.memory?.workingSetSize || 0,
        })),
      );
    } catch (error) {
      if (!isTransientAppMetricsError(error) || attempt === 3) throw error;
      console.warn(
        `[test-release-perf] app metrics context changed; retrying (${attempt}/3)`,
      );
      await waitMs(attempt * 250);
    }
  }
  throw new Error("app metrics retries exhausted");
}

async function getRssSnapshot(app) {
  const metrics = await collectAppMetrics(app);
  const toMiB = (items) =>
    Number(
      (
        items.reduce((sum, item) => sum + item.workingSetSize * 1024, 0) /
        1024 /
        1024
      ).toFixed(2),
    );
  const gpuProcesses = metrics.filter((item) => item.type === "GPU");
  return {
    totalMiB: toMiB(metrics),
    applicationMiB: toMiB(metrics.filter((item) => item.type !== "GPU")),
    gpuMiB: toMiB(gpuProcesses),
    processes: metrics,
  };
}

async function getRssMiB(app) {
  return (await getRssSnapshot(app)).applicationMiB;
}

async function measureColdStarts(iterations, warmups) {
  const launch = async () => {
    const profile = prepareProfile(false);
    const started = performance.now();
    let session;
    try {
      session = await launchPackaged(profile, null, null);
      await session.page.evaluate(() => window.api.update.getCurrentVersion());
      return performance.now() - started;
    } finally {
      await closeSession(session);
      fs.rmSync(profile, { recursive: true, force: true });
    }
  };
  for (let index = 0; index < warmups; index += 1) await launch();
  const values = [];
  for (let index = 0; index < iterations; index += 1)
    values.push(await launch());
  return summarize(values, { p95Ms: thresholds.coldStartMs });
}

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function measureIdleRss(app, minutes) {
  if (minutes <= 0) return { skipped: true, reason: "PERF_IDLE_MINUTES=0" };
  const baselineSnapshot = await getRssSnapshot(app);
  await waitMs(minutes * 60 * 1000);
  const finalSnapshot = await getRssSnapshot(app);
  return {
    skipped: false,
    rssBasis: "Browser+Tab+Utility（排除 GPU compositor）",
    baselineMiB: baselineSnapshot.applicationMiB,
    finalMiB: finalSnapshot.applicationMiB,
    baselineTotalMiB: baselineSnapshot.totalMiB,
    finalTotalMiB: finalSnapshot.totalMiB,
    baselineGpuMiB: baselineSnapshot.gpuMiB,
    finalGpuMiB: finalSnapshot.gpuMiB,
    baselineProcesses: baselineSnapshot.processes,
    finalProcesses: finalSnapshot.processes,
    pass: finalSnapshot.applicationMiB < thresholds.idleRssMiB,
    thresholdMiB: thresholds.idleRssMiB,
  };
}

async function measureSoak(session, minutes, intervalMs) {
  if (minutes <= 0) return { skipped: true, reason: "PERF_SOAK_MINUTES=0" };
  const started = Date.now();
  const deadline = started + minutes * 60 * 1000;
  const baseline = await getRssMiB(session.app);
  const samples = [];
  let cycles = 0;
  while (Date.now() < deadline) {
    await session.page.evaluate(async () => {
      await Promise.all([
        window.api.schedule.list(),
        window.api.timetable.list(),
        window.api.exam.list(),
        window.api.lab.list(),
        window.api.grade.getDashboard(),
        window.api.grade.listPage({
          semester: "2026-2027-1",
          page: 1,
          pageSize: 20,
        }),
      ]);
    });
    samples.push(await getRssMiB(session.app));
    cycles += 1;
    const remaining = deadline - Date.now();
    if (remaining > 0) await waitMs(Math.min(intervalMs, remaining));
  }
  const final = samples.length ? samples[samples.length - 1] : baseline;
  const growthRatio = baseline > 0 ? (final - baseline) / baseline : 0;
  return {
    skipped: false,
    cycles,
    intervalMs,
    baselineMiB: baseline,
    finalMiB: final,
    peakMiB: samples.length ? Math.max(...samples) : baseline,
    growthRatio: Number(growthRatio.toFixed(4)),
    pass: growthRatio < thresholds.soakGrowthRatio,
    thresholdGrowthRatio: thresholds.soakGrowthRatio,
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function metricAt(metrics, metricPath) {
  return metricPath.split(".").reduce((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return value[key];
  }, metrics);
}

function metricLabel(metricPath) {
  return `metrics.${metricPath}`;
}

function hasPositiveSampleCount(value) {
  return Number.isInteger(value) && value > 0;
}

function hasFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateLatencyMetric(metrics, metricPath) {
  const label = metricLabel(metricPath);
  const metric = metricAt(metrics, metricPath);
  if (!metric || typeof metric !== "object") return [`${label}: missing`];
  const failures = [];
  if (metric.skipped === true) failures.push(`${label}: skipped`);
  if (!hasPositiveSampleCount(metric.sampleCount))
    failures.push(`${label}: missing sampleCount`);
  if (!hasFiniteNumber(metric.p95Ms)) failures.push(`${label}: missing p95Ms`);
  if (metric.skipped !== true && metric.pass !== true)
    failures.push(`${label}: did not pass`);
  return failures;
}

function validateHealthMetric(metrics, metricPath) {
  const label = metricLabel(metricPath);
  const metric = metricAt(metrics, metricPath);
  if (!metric || typeof metric !== "object") return [`${label}: missing`];
  const failures = [];
  if (metric.skipped === true) failures.push(`${label}: skipped`);
  if (metric.skipped !== true && metric.pass !== true)
    failures.push(`${label}: did not pass`);
  return failures;
}

function validateOcrEvidence(metrics, metricPath) {
  const failures = validateLatencyMetric(metrics, metricPath);
  const metric = metricAt(metrics, metricPath);
  if (
    metric &&
    typeof metric === "object" &&
    (metric.evidence?.kind !== "real-ocr-performance" ||
      metric.evidence.real !== true)
  ) {
    failures.push(`${metricLabel(metricPath)}: missing real OCR evidence`);
  }
  return failures;
}

function validateRequiredMetrics(metrics) {
  const failures = [];
  for (const metricPath of metricPolicy.required.latency)
    failures.push(...validateLatencyMetric(metrics, metricPath));
  for (const metricPath of metricPolicy.required.health)
    failures.push(...validateHealthMetric(metrics, metricPath));
  for (const metricPath of metricPolicy.required.ocrEvidence)
    failures.push(...validateOcrEvidence(metrics, metricPath));
  return [...new Set(failures)];
}

function validateOptionalMetrics(metrics) {
  const findings = [];
  for (const metricPath of metricPolicy.optional) {
    const metric = metricAt(metrics, metricPath);
    if (!metric || typeof metric !== "object") {
      findings.push(`${metricLabel(metricPath)}: missing optional metric`);
      continue;
    }
    if (metric.skipped === true)
      findings.push(`${metricLabel(metricPath)}: skipped`);
    if (!hasPositiveSampleCount(metric.sampleCount))
      findings.push(`${metricLabel(metricPath)}: missing sampleCount`);
    if (!hasFiniteNumber(metric.p95Ms))
      findings.push(`${metricLabel(metricPath)}: missing p95Ms`);
    if (metric.skipped !== true && metric.pass !== true)
      findings.push(`${metricLabel(metricPath)}: did not pass`);
  }
  return [...new Set(findings)];
}

function failedMetrics(report) {
  const failures = [];
  const visit = (value, prefix) => {
    if (!value || typeof value !== "object") return;
    if (value.pass === false) failures.push(prefix);
    for (const [key, child] of Object.entries(value)) {
      if (key !== "pass") visit(child, `${prefix}.${key}`);
    }
  };
  visit(report.metrics, "metrics");
  return failures;
}

async function main() {
  if (!fs.existsSync(executable))
    throw new Error(`找不到 packaged executable: ${executable}`);
  const iterations = Math.floor(envNumber("PERF_ITERATIONS", 30, 1));
  const warmups = Math.floor(envNumber("PERF_WARMUPS", 5, 0));
  const idleMinutes = envNumber("PERF_IDLE_MINUTES", 5, 0);
  const soakMinutes = envNumber("PERF_SOAK_MINUTES", 30, 0);
  const soakIntervalMs = envNumber("PERF_SOAK_INTERVAL_MS", 10_000, 100);
  const enforce = envFlag("PERF_ENFORCE", true);
  const ocrBenchmarkInput = resolveOcrBenchmarkInput();
  const mode = enforce ? "release" : "non-release";
  const report = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    executable: path.relative(root, executable).replaceAll(path.sep, "/"),
    host: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpu: os.cpus()[0]?.model || "unknown",
      memoryMiB: Math.round(os.totalmem() / 1024 / 1024),
      node: process.version,
    },
    dataset,
    sampling: {
      iterations,
      warmups,
      idleMinutes,
      soakMinutes,
      soakIntervalMs,
      enforce,
      mode,
    },
    metricPolicy,
    releaseAcceptance: {
      required: enforce,
      status: enforce ? "pending" : "not_release_acceptance",
    },
    thresholds,
    metrics: {},
  };
  runningReport = report;
  const backupProfile = prepareProfile(true);
  const backupPath = path.join(backupProfile, "benchmark-backup.zip");
  let soakProfile;
  let session;
  let soakSession;
  try {
    session = await launchPackaged(backupProfile, backupPath, backupPath);
    report.metrics.sqlite = createSqliteMetrics(
      path.join(backupProfile, "data.db"),
      iterations,
      warmups,
    );
    report.metrics.ipc = await createIpcMetrics(
      session.page,
      iterations,
      warmups,
    );
    report.metrics.pageSwitch = await createPageMetrics(
      session.page,
      iterations,
      warmups,
    );
    report.metrics.reminder = await createReminderMetrics(
      session.page,
      iterations,
      warmups,
    );
    report.metrics.backup = await createBackupMetrics(
      session.page,
      backupPath,
      iterations,
      warmups,
    );
    report.metrics.coldStart = await measureColdStarts(iterations, warmups);

    await closeSession(session);
    session = undefined;
    soakProfile = prepareProfile(false);
    if (ocrBenchmarkInput) seedOcrComponent(soakProfile, ocrBenchmarkInput);
    soakSession = await launchPackaged(soakProfile, null, null);
    // Measure the application's idle footprint before OCR initializes its WASM worker. The
    // optional OCR worker is sampled separately below so its one-time activation does not
    // turn the normal idle-RSS gate into an implicit OCR-memory gate.
    report.metrics.idleRss = await measureIdleRss(soakSession.app, idleMinutes);
    report.metrics.ocr = ocrBenchmarkInput
      ? await createOcrMetrics(
          soakSession.page,
          ocrBenchmarkInput,
          iterations,
          warmups,
        )
      : {
          ...unwrap(
            await soakSession.page.evaluate(() =>
              window.api.ocrComponent.getStatus(),
            ),
            "OCR status",
          ),
          skipped: true,
          reason:
            "未提供真实 OCR Release 资产和识别图片；不伪造线上 OCR 性能证据",
          evidence: {
            kind: "real-ocr-performance",
            real: false,
            reason: "本次运行未执行真实 OCR 识别",
          },
        };
    report.metrics.soak = await measureSoak(
      soakSession,
      soakMinutes,
      soakIntervalMs,
    );
    report.metrics.shutdown = {
      backupAppClosed: false,
      soakAppClosed: false,
      pass: false,
    };
    await closeSession(soakSession);
    soakSession = undefined;
    report.metrics.shutdown = {
      backupAppClosed: true,
      soakAppClosed: true,
      pass: true,
    };
    const observedFailures = failedMetrics(report);
    const requiredFailures = validateRequiredMetrics(report.metrics);
    const optionalFindings = validateOptionalMetrics(report.metrics);
    report.observedFailures = observedFailures;
    report.failures = requiredFailures;
    report.warnings = optionalFindings;
    report.status = enforce
      ? requiredFailures.length
        ? "failed"
        : "passed"
      : "completed_non_release";
    report.releaseAcceptance = {
      required: enforce,
      status: enforce
        ? requiredFailures.length
          ? "failed"
          : "passed"
        : "not_release_acceptance",
    };
    report.finishedAt = new Date().toISOString();
    writeReport(report);
    console.log(
      JSON.stringify(
        {
          report: reportPath,
          status: report.status,
          releaseAcceptance: report.releaseAcceptance.status,
          failures: report.failures,
          warnings: report.warnings,
        },
        null,
        2,
      ),
    );
    if (report.status === "failed") process.exitCode = 1;
  } finally {
    await closeSession(session);
    await closeSession(soakSession);
    fs.rmSync(backupProfile, { recursive: true, force: true });
    if (soakProfile) fs.rmSync(soakProfile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (runningReport) {
    runningReport.status = runningReport.sampling.enforce
      ? "failed"
      : "failed_non_release";
    runningReport.failures = [
      `runner: ${error instanceof Error ? error.message : String(error)}`,
    ];
    runningReport.releaseAcceptance = {
      required: runningReport.sampling.enforce,
      status: runningReport.sampling.enforce
        ? "failed"
        : "not_release_acceptance",
    };
    runningReport.finishedAt = new Date().toISOString();
    writeReport(runningReport);
  }
  console.error(
    `[test-release-perf] ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exitCode = 1;
});
