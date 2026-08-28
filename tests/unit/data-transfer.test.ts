import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import archiver from "archiver";
import { createHash } from "node:crypto";

const dialogMock = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.3.0",
    getPath: () => os.tmpdir(),
  },
  BrowserWindow: class {},
  dialog: dialogMock,
}));

import { DataTransferService } from "../../src/main/services/DataTransferService";
import type { PortableSettings } from "../../src/shared/types";

const settings: PortableSettings = {
  portableSettingsVersion: 1,
  themeMode: "dark",
  timetable: { semesterStart: "2026-08-17" },
  dnd: { enabled: false, startTime: "22:00", endTime: "08:00" },
  notificationHistory: [],
  appearance: {
    material: "none",
    backgroundImage: null,
    blurRadius: 0,
    clarity: 100,
  },
};

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const tempPaths: string[] = [];

class FakeDataService {
  reopenCount = 0;
  failReopenCount = 0;

  closeDatabase(): void {}

  reopenAfterTransfer(): void {
    this.reopenCount += 1;
    if (this.failReopenCount > 0) {
      this.failReopenCount -= 1;
      throw new Error("reopen failed");
    }
  }

  getRecordCounts() {
    return {
      schedules: 0,
      courses: 0,
      exams: 0,
      labs: 0,
      grades: 0,
      formulas: 1,
      periods: 1,
    };
  }
}

class FakeSettings {
  value = structuredClone(settings);

  get(): PortableSettings {
    return structuredClone(this.value);
  }

  replace(next: PortableSettings): PortableSettings {
    this.value = structuredClone(next);
    return this.get();
  }
}

class FileBackedSettings extends FakeSettings {
  constructor(private readonly filePath: string) {
    super();
  }

  getFilePath(): string {
    return this.filePath;
  }
}

function makeDatabase(filePath: string): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE schedule_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, reminder_offset INTEGER NOT NULL, repeat_rule TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT NOT NULL, teacher TEXT, location TEXT, start_week INTEGER NOT NULL, end_week INTEGER NOT NULL, weekday INTEGER NOT NULL, start_period INTEGER NOT NULL, end_period INTEGER NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE period_config (period_index INTEGER PRIMARY KEY, start_time TEXT NOT NULL, end_time TEXT NOT NULL, break_after INTEGER NOT NULL, is_lab INTEGER NOT NULL, reminder_offset INTEGER NOT NULL);
    CREATE TABLE exams (id TEXT PRIMARY KEY, course_name TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, location TEXT, seat TEXT, notes TEXT, reminder_offsets TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, location TEXT, instructor TEXT, notes TEXT, reminder_offsets TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE grades (id TEXT PRIMARY KEY, course_name TEXT NOT NULL, semester TEXT NOT NULL, credit REAL NOT NULL, grade_point REAL NOT NULL, score REAL, is_degree_course INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE gpa_formula (id TEXT PRIMARY KEY, formula TEXT NOT NULL, is_default INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO period_config VALUES (1, '08:00', '08:45', 10, 0, 10);
    INSERT INTO gpa_formula VALUES ('default', 'SUM(credit * gradePoint) / SUM(credit)', 1, '默认公式', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 2;
  `);
  db.close();
}

function createDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-backup-"));
  tempPaths.push(directory);
  return directory;
}

function writeZip(
  filePath: string,
  entries: Array<{ name: string; content: Buffer | string }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    for (const entry of entries)
      archive.append(entry.content, { name: entry.name });
    void archive.finalize();
  });
}

function manifestFor(
  db: Buffer,
  setting: Buffer,
  databaseSchemaVersion = 2,
  files = [
    {
      path: "data/data.db",
      bytes: db.length,
      sha256: createHash("sha256").update(db).digest("hex"),
    },
    {
      path: "settings/portable-settings.json",
      bytes: setting.length,
      sha256: createHash("sha256").update(setting).digest("hex"),
    },
  ],
) {
  return JSON.stringify({
    backupFormatVersion: 2,
    databaseSchemaVersion,
    portableSettingsVersion: 1,
    appVersion: "0.3.0",
    exportedAt: "2026-08-21T00:00:00.000Z",
    includesBackground: false,
    recordCounts: {
      schedules: 0,
      courses: 0,
      exams: 0,
      labs: 0,
      grades: 0,
      formulas: 1,
      periods: 1,
    },
    files,
  });
}

afterEach(() => {
  delete process.env.COLLEGE_TOOLKIT_E2E_BACKUP_PATH;
  delete process.env.COLLEGE_TOOLKIT_E2E_IMPORT_PATH;
  vi.clearAllMocks();
  while (tempPaths.length > 0)
    fs.rmSync(tempPaths.pop() as string, { recursive: true, force: true });
});

describe("Backup v2 transfer", () => {
  it("exports and imports a v2 archive with manifest hashes", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const data = new FakeDataService();
    const sourceSettings = new FakeSettings();
    const service = new DataTransferService(
      dbPath,
      data as never,
      sourceSettings,
      "0.3.0",
    );

    await service.exportToPath(archivePath);
    await service.importFromZip(archivePath);

    expect(data.reopenCount).toBe(2);
    const imported = new Database(dbPath);
    expect(
      (
        imported.prepare("SELECT COUNT(*) AS count FROM gpa_formula").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    imported.close();
  });

  it("rejects Zip Slip and duplicate entries before staging", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const data = new FakeDataService();
    const service = new DataTransferService(
      dbPath,
      data as never,
      new FakeSettings(),
      "0.3.0",
    );

    const zipSlip = path.join(directory, "zip-slip.zip");
    await writeZip(zipSlip, [
      { name: "manifest.json", content: "{}" },
      { name: "../outside.txt", content: "x" },
    ]);
    await expect(service.importFromZip(zipSlip)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });

    const duplicate = path.join(directory, "duplicate.zip");
    await writeZip(duplicate, [
      { name: "manifest.json", content: "{}" },
      { name: "manifest.json", content: "{}" },
    ]);
    await expect(service.importFromZip(duplicate)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
  });

  it("rejects a wrong payload hash and a future manifest", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const db = fs.readFileSync(dbPath);
    const setting = Buffer.from(JSON.stringify(settings));
    const data = new FakeDataService();

    const wrongHashPath = path.join(directory, "wrong-hash.zip");
    const wrongFiles = [
      { path: "data/data.db", bytes: db.length, sha256: "0".repeat(64) },
      {
        path: "settings/portable-settings.json",
        bytes: setting.length,
        sha256: "0".repeat(64),
      },
    ];
    await writeZip(wrongHashPath, [
      {
        name: "manifest.json",
        content: manifestFor(db, setting, 2, wrongFiles),
      },
      { name: "data/data.db", content: db },
      { name: "settings/portable-settings.json", content: setting },
    ]);
    await expect(
      new DataTransferService(
        dbPath,
        data as never,
        new FakeSettings(),
        "0.3.0",
      ).importFromZip(wrongHashPath),
    ).rejects.toMatchObject({ code: "BACKUP_CORRUPT" });

    const futurePath = path.join(directory, "future.zip");
    await writeZip(futurePath, [
      { name: "manifest.json", content: manifestFor(db, setting, 3) },
    ]);
    await expect(
      new DataTransferService(
        dbPath,
        data as never,
        new FakeSettings(),
        "0.3.0",
      ).importFromZip(futurePath),
    ).rejects.toMatchObject({ code: "BACKUP_TOO_NEW" });
  });

  it("recovers the original database when reopening the incoming database fails", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const data = new FakeDataService();
    const service = new DataTransferService(
      dbPath,
      data as never,
      new FakeSettings(),
      "0.3.0",
    );

    await service.exportToPath(archivePath);
    data.failReopenCount = 1;
    await expect(service.importFromZip(archivePath)).rejects.toMatchObject({
      code: "RESTORE_FAILED_ROLLED_BACK",
    });
    expect(data.reopenCount).toBe(3);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(path.join(directory, "import-journal.json"))).toBe(
      false,
    );
  });

  it("在恢复点创建失败时重新打开原数据库，而不是保持服务断开", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const data = new FakeDataService();
    const settingsAccess = new FakeSettings();
    const service = new DataTransferService(
      dbPath,
      data as never,
      settingsAccess,
      "0.3.0",
    );

    await service.exportToPath(archivePath);
    const settingsPath = path.join(directory, "portable-settings.json");
    fs.rmSync(settingsPath, { force: true });
    fs.mkdirSync(settingsPath);

    await expect(service.importFromZip(archivePath)).rejects.toMatchObject({
      code: "RESTORE_FAILED_ROLLED_BACK",
    });
    expect(data.reopenCount).toBe(2);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("拒绝未知恢复日志状态，并保留人工恢复入口", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    fs.writeFileSync(
      path.join(directory, "import-journal.json"),
      JSON.stringify({ status: "unknown" }),
    );
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );

    await expect(service.recoverOnStartup()).rejects.toMatchObject({
      code: "RESTORE_FAILED_RECOVERY_REQUIRED",
    });
    expect(fs.existsSync(path.join(directory, "import-journal.json"))).toBe(
      true,
    );
  });

  it("keeps native dialogs cancellable and supports the scoped E2E path seam", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );

    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true });
    expect(await service.exportBackup()).toEqual({ ok: true });
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    });
    expect(await service.prepareImport(1)).toEqual({ ok: true });

    process.env.COLLEGE_TOOLKIT_E2E_BACKUP_PATH = archivePath;
    expect(await service.exportBackup()).toMatchObject({
      ok: true,
      data: { backupFormatVersion: 2 },
    });
    process.env.COLLEGE_TOOLKIT_E2E_IMPORT_PATH = archivePath;
    const prepared = await service.prepareImport(1);
    expect(prepared).toMatchObject({
      ok: true,
      data: { inspection: { backupFormatVersion: 2 } },
    });
    const token = prepared.data?.inspection.token as string;
    expect(await service.cancelImport(1, token)).toEqual({
      ok: true,
      data: true,
    });
  });

  it("uses parent-aware dialogs, structured errors and a file-backed settings path", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "broken.zip");
    makeDatabase(dbPath);
    fs.writeFileSync(archivePath, Buffer.from("not-a-zip"));
    const parent = {} as never;
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FileBackedSettings(path.join(directory, "settings", "portable.json")),
      "0.3.0",
    );

    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true });
    expect(await service.exportBackup(parent)).toEqual({ ok: true });
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [archivePath],
    });
    expect(await service.prepareImport(1, parent)).toMatchObject({
      ok: false,
      errorCode: "BACKUP_CORRUPT",
    });
    expect(
      fs.existsSync(path.join(directory, "settings", "portable.json")),
    ).toBe(false);

    const errorResult = (
      service as unknown as { errorResult: (value: unknown) => unknown }
    ).errorResult("plain error");
    expect(errorResult).toMatchObject({
      ok: false,
      errorCode: "BACKUP_INVALID",
    });
  });

  it("covers dialog edge paths, busy assertions, missing databases and pending cleanup", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );

    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false });
    expect(await service.exportBackup()).toEqual({ ok: true });

    const missingDatabase = new DataTransferService(
      path.join(directory, "missing", "data.db"),
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );
    await expect(
      missingDatabase.exportToPath(path.join(directory, "missing.zip")),
    ).rejects.toThrow("数据库文件不存在");

    const internal = service as unknown as { busy: boolean };
    internal.busy = true;
    await expect(service.exportToPath(archivePath)).rejects.toMatchObject({
      code: "BACKUP_BUSY",
    });
    internal.busy = false;

    const broken = path.join(directory, "broken.zip");
    fs.writeFileSync(broken, Buffer.from("not-a-zip"));
    process.env.COLLEGE_TOOLKIT_E2E_IMPORT_PATH = broken;
    expect(await service.prepareImport(1)).toMatchObject({
      ok: false,
      errorCode: "BACKUP_CORRUPT",
    });
    delete process.env.COLLEGE_TOOLKIT_E2E_IMPORT_PATH;

    await service.exportToPath(archivePath);
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [archivePath],
    });
    expect(await service.prepareImport(1)).toMatchObject({
      ok: true,
      data: { inspection: { backupFormatVersion: 2 } },
    });
    service.dispose();
  });

  it("previews and commits a legacy v1 archive while preserving current settings", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const legacyDbPath = path.join(directory, "legacy.db");
    const archivePath = path.join(directory, "legacy.zip");
    makeDatabase(dbPath);
    makeDatabase(legacyDbPath);
    await writeZip(archivePath, [
      { name: "data.db", content: fs.readFileSync(legacyDbPath) },
      { name: "config.json", content: "{}" },
      {
        name: "timetable.json",
        content: JSON.stringify({ semesterStart: null }),
      },
    ]);
    const data = new FakeDataService();
    const sourceSettings = new FakeSettings();
    const service = new DataTransferService(
      dbPath,
      data as never,
      sourceSettings,
      "0.3.0",
    );
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [archivePath],
    });

    const prepared = await service.prepareImport(42);
    expect(prepared).toMatchObject({
      ok: true,
      data: {
        inspection: {
          backupFormatVersion: 1,
          includesSettings: false,
          includesBackground: false,
        },
      },
    });
    expect(prepared.data?.inspection.warnings[0]).toContain("legacy v1");
    const token = prepared.data?.inspection.token as string;
    expect(await service.commitImport(99, token)).toMatchObject({
      ok: false,
      errorCode: "BACKUP_INVALID",
    });
    expect(await service.commitImport(42, token)).toMatchObject({
      ok: true,
      data: { backupFormatVersion: 1 },
    });
    expect(sourceSettings.get()).toEqual(settings);
  });

  it("rejects busy, invalid and expired import tokens and allows cancellation after expiry", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );
    await service.exportToPath(archivePath);
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [archivePath],
    });

    const prepared = await service.prepareImport(7);
    expect(await service.prepareImport(7)).toMatchObject({
      ok: false,
      errorCode: "BACKUP_BUSY",
    });
    const token = prepared.data?.inspection.token as string;
    const pending = service as unknown as {
      pending: { inspection: { expiresAt: string } };
    };
    pending.pending.inspection.expiresAt = new Date(0).toISOString();
    expect(await service.commitImport(7, token)).toMatchObject({
      ok: false,
      errorCode: "BACKUP_EXPIRED",
    });
    expect(await service.cancelImport(7, token)).toEqual({
      ok: true,
      data: true,
    });
    expect(await service.cancelImport(7, token)).toMatchObject({
      ok: false,
      errorCode: "BACKUP_INVALID",
    });
  });

  it("rejects malformed manifests, invalid settings, unknown formats and extra entries", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const db = fs.readFileSync(dbPath);
    const setting = Buffer.from(JSON.stringify(settings));
    const importArchive = async (archivePath: string) =>
      new DataTransferService(
        dbPath,
        new FakeDataService() as never,
        new FakeSettings(),
        "0.3.0",
      ).importFromZip(archivePath);

    const malformed = path.join(directory, "malformed.zip");
    await writeZip(malformed, [{ name: "manifest.json", content: "not-json" }]);
    await expect(importArchive(malformed)).rejects.toThrow();

    const invalidSettings = path.join(directory, "invalid-settings.zip");
    const invalidSetting = Buffer.from("{}");
    await writeZip(invalidSettings, [
      {
        name: "manifest.json",
        content: manifestFor(db, invalidSetting),
      },
      { name: "data/data.db", content: db },
      { name: "settings/portable-settings.json", content: invalidSetting },
    ]);
    await expect(importArchive(invalidSettings)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });

    const duplicateManifest = path.join(directory, "duplicate-manifest.zip");
    const baseFiles = [
      {
        path: "data/data.db",
        bytes: db.length,
        sha256: createHash("sha256").update(db).digest("hex"),
      },
      {
        path: "settings/portable-settings.json",
        bytes: setting.length,
        sha256: createHash("sha256").update(setting).digest("hex"),
      },
    ];
    await writeZip(duplicateManifest, [
      {
        name: "manifest.json",
        content: manifestFor(db, setting, 2, [...baseFiles, baseFiles[0]]),
      },
      { name: "data/data.db", content: db },
      { name: "settings/portable-settings.json", content: setting },
    ]);
    await expect(importArchive(duplicateManifest)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });

    const extraEntry = path.join(directory, "extra-entry.zip");
    await writeZip(extraEntry, [
      { name: "manifest.json", content: manifestFor(db, setting) },
      { name: "data/data.db", content: db },
      { name: "settings/portable-settings.json", content: setting },
      { name: "extra.txt", content: "unexpected" },
    ]);
    await expect(importArchive(extraEntry)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });

    const unsupported = path.join(directory, "unsupported.zip");
    await writeZip(unsupported, [{ name: "notes.txt", content: "x" }]);
    await expect(importArchive(unsupported)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
  });

  it("rejects corrupted ZIP data and archives with too many entries", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const serviceFor = () =>
      new DataTransferService(
        dbPath,
        new FakeDataService() as never,
        new FakeSettings(),
        "0.3.0",
      );
    const corrupted = path.join(directory, "corrupted.zip");
    fs.writeFileSync(corrupted, Buffer.from("not-a-zip"));
    await expect(serviceFor().importFromZip(corrupted)).rejects.toMatchObject({
      code: "BACKUP_CORRUPT",
    });

    const tooMany = path.join(directory, "too-many.zip");
    await writeZip(tooMany, [
      { name: "manifest.json", content: "{}" },
      ...Array.from({ length: 16 }, (_, index) => ({
        name: `entry-${index}.txt`,
        content: "x",
      })),
    ]);
    await expect(serviceFor().importFromZip(tooMany)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
  });

  it("exports and restores a background asset atomically", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "background.zip");
    makeDatabase(dbPath);
    const backgrounds = path.join(directory, "backgrounds");
    fs.mkdirSync(backgrounds, { recursive: true });
    fs.writeFileSync(path.join(backgrounds, "scene.png"), validPng);
    const sourceSettings = new FakeSettings();
    sourceSettings.value.appearance.backgroundImage = "scene.png";
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      sourceSettings,
      "0.3.0",
    );

    const exported = await service.exportToPath(archivePath);
    expect(exported.includesBackground).toBe(true);
    await service.importFromZip(archivePath);

    expect(sourceSettings.get().appearance.backgroundImage).toBe(
      "restored-background.png",
    );
    expect(
      fs.existsSync(path.join(backgrounds, "restored-background.png")),
    ).toBe(true);
  });

  it("rejects inconsistent background declarations before applying the archive", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const db = fs.readFileSync(dbPath);
    const setting = Buffer.from(JSON.stringify(settings));
    const base = JSON.parse(manifestFor(db, setting)) as Record<
      string,
      unknown
    >;
    const background = validPng;
    const makeArchive = async (
      name: string,
      manifestPatch: Record<string, unknown>,
      entries: Array<{ name: string; content: Buffer | string }> = [],
    ): Promise<string> => {
      const archive = path.join(directory, name);
      await writeZip(archive, [
        {
          name: "manifest.json",
          content: JSON.stringify({ ...base, ...manifestPatch }),
        },
        { name: "data/data.db", content: db },
        { name: "settings/portable-settings.json", content: setting },
        ...entries,
      ]);
      return archive;
    };
    const serviceFor = () =>
      new DataTransferService(
        dbPath,
        new FakeDataService() as never,
        new FakeSettings(),
        "0.3.0",
      );

    const declaredButMissing = await makeArchive("missing-background.zip", {
      includesBackground: true,
    });
    await expect(
      serviceFor().importFromZip(declaredButMissing),
    ).rejects.toMatchObject({
      code: "BACKUP_CORRUPT",
    });

    const undeclaredAsset = await makeArchive(
      "undeclared-background.zip",
      { includesBackground: false },
      [{ name: "assets/background.png", content: background }],
    );
    await expect(
      serviceFor().importFromZip(undeclaredAsset),
    ).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });

    const missingManifestEntry = await makeArchive(
      "missing-manifest-entry.zip",
      { includesBackground: true },
      [{ name: "assets/background.png", content: background }],
    );
    await expect(
      serviceFor().importFromZip(missingManifestEntry),
    ).rejects.toMatchObject({
      code: "BACKUP_CORRUPT",
    });

    const extraManifestFile = await makeArchive("extra-manifest-file.zip", {
      includesBackground: false,
      files: [
        ...(base.files as unknown[]),
        {
          path: "assets/extra.bin",
          bytes: 1,
          sha256: "0".repeat(64),
        },
      ],
    });
    await expect(
      serviceFor().importFromZip(extraManifestFile),
    ).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
  });

  it("rejects non-image background payloads even when the manifest hash matches", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "invalid-background.zip");
    makeDatabase(dbPath);
    const db = fs.readFileSync(dbPath);
    const setting = Buffer.from(JSON.stringify(settings));
    const invalidBackground = Buffer.from("<script>not an image</script>");
    const files = [
      {
        path: "data/data.db",
        bytes: db.length,
        sha256: createHash("sha256").update(db).digest("hex"),
      },
      {
        path: "settings/portable-settings.json",
        bytes: setting.length,
        sha256: createHash("sha256").update(setting).digest("hex"),
      },
      {
        path: "assets/background.png",
        bytes: invalidBackground.length,
        sha256: createHash("sha256").update(invalidBackground).digest("hex"),
      },
    ];
    await writeZip(archivePath, [
      {
        name: "manifest.json",
        content: manifestFor(db, setting, 2, files).replace(
          '"includesBackground":false',
          '"includesBackground":true',
        ),
      },
      { name: "data/data.db", content: db },
      { name: "settings/portable-settings.json", content: setting },
      { name: "assets/background.png", content: invalidBackground },
    ]);

    await expect(
      new DataTransferService(
        dbPath,
        new FakeDataService() as never,
        new FakeSettings(),
        "0.3.0",
      ).importFromZip(archivePath),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
  });

  it("serializes prepare and consumes an import token before applying", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );
    await service.exportToPath(archivePath);
    process.env.COLLEGE_TOOLKIT_E2E_IMPORT_PATH = archivePath;

    const firstPrepare = service.prepareImport(1);
    const secondPrepare = service.prepareImport(2);
    const prepared = await Promise.all([firstPrepare, secondPrepare]);
    expect(prepared.filter((item) => item.ok)).toHaveLength(1);
    expect(
      prepared.filter((item) => item.errorCode === "BACKUP_BUSY"),
    ).toHaveLength(1);
    const token = prepared.find((item) => item.ok)?.data?.inspection.token;
    expect(token).toEqual(expect.any(String));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const internal = service as unknown as {
      applyPending: (pending: { inspection: unknown }) => Promise<unknown>;
      busy: boolean;
    };
    internal.applyPending = async (pending) => {
      await gate;
      internal.busy = false;
      return pending.inspection;
    };
    const firstCommit = service.commitImport(1, token as string);
    await expect(
      service.commitImport(1, token as string),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "BACKUP_INVALID",
    });
    await expect(
      service.cancelImport(1, token as string),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "BACKUP_INVALID",
    });
    release();
    await expect(firstCommit).resolves.toMatchObject({ ok: true });
  });

  it("reserves the import lifecycle while the native file picker is open", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );
    let releasePicker!: (value: {
      canceled: boolean;
      filePaths: string[];
    }) => void;
    dialogMock.showOpenDialog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePicker = resolve;
        }),
    );

    const first = service.prepareImport(1);
    await vi.waitFor(() =>
      expect(dialogMock.showOpenDialog).toHaveBeenCalledTimes(1),
    );
    await expect(service.prepareImport(2)).resolves.toMatchObject({
      ok: false,
      errorCode: "BACKUP_BUSY",
    });
    releasePicker({ canceled: true, filePaths: [] });
    await expect(first).resolves.toEqual({ ok: true });
  });

  it("keeps a failed cancellation retryable and blocks a later commit", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );
    await service.exportToPath(archivePath);
    process.env.COLLEGE_TOOLKIT_E2E_IMPORT_PATH = archivePath;
    const prepared = await service.prepareImport(1);
    const token = prepared.data?.inspection.token;
    expect(token).toEqual(expect.any(String));

    const internal = service as unknown as {
      removeStaging: (stagingDir: string) => void;
    };
    const originalRemoveStaging = internal.removeStaging.bind(internal);
    let shouldFail = true;
    internal.removeStaging = (stagingDir) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("staging is locked");
      }
      originalRemoveStaging(stagingDir);
    };

    await expect(
      service.cancelImport(1, token as string),
    ).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      service.commitImport(1, token as string),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "BACKUP_BUSY",
    });
    await expect(service.cancelImport(1, token as string)).resolves.toEqual({
      ok: true,
      data: true,
    });
  });

  it("keeps the staging path in every recovery-journal state", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );
    await service.exportToPath(archivePath);
    const journalWrites: Array<Record<string, unknown>> = [];
    const internal = service as unknown as {
      writeJournal: (filePath: string, value: Record<string, unknown>) => void;
    };
    const originalWriteJournal = internal.writeJournal.bind(internal);
    internal.writeJournal = (filePath, value) => {
      journalWrites.push(value);
      originalWriteJournal(filePath, value);
    };

    await service.importFromZip(archivePath);
    const recoveryWrites = journalWrites.filter(
      (value) => value.status === "applying" || value.status === "committed",
    );
    expect(recoveryWrites).toHaveLength(2);
    expect(recoveryWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "applying",
          stagingDir: expect.any(String),
        }),
        expect.objectContaining({
          status: "committed",
          stagingDir: expect.any(String),
        }),
      ]),
    );
  });

  it("keeps recovery helpers safe when settings or background assets are absent", () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const backgrounds = path.join(directory, "backgrounds");
    fs.mkdirSync(backgrounds, { recursive: true });
    fs.writeFileSync(path.join(backgrounds, "scene.png"), validPng);
    const settingsPath = path.join(directory, "settings", "portable.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const sourceSettings = new FileBackedSettings(settingsPath);
    sourceSettings.value.appearance.backgroundImage = "scene.png";
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      sourceSettings,
      "0.3.0",
    );
    const internal = service as unknown as {
      createRecoveryPoint: () => void;
      tryRollback: () => boolean;
      restoreRecoveryPoint: () => void;
      recoveryRoot: string;
      getBackgroundPath: (name: string | null) => string | null;
      restoreRecoveryBackground: () => void;
    };

    internal.createRecoveryPoint();
    expect(fs.existsSync(path.join(internal.recoveryRoot, "data.db"))).toBe(
      true,
    );
    expect(internal.tryRollback()).toBe(true);
    expect(
      fs.existsSync(path.join(directory, "backgrounds", "scene.png")),
    ).toBe(true);
    expect(internal.getBackgroundPath("../outside.png")).toBeNull();
    expect(internal.getBackgroundPath("missing.png")).toBeNull();

    fs.rmSync(path.join(internal.recoveryRoot, "data.db"), { force: true });
    expect(internal.tryRollback()).toBe(false);
    expect(() => internal.restoreRecoveryPoint()).toThrow("恢复点数据库不存在");

    sourceSettings.value.appearance.backgroundImage = null;
    internal.restoreRecoveryBackground();
    sourceSettings.value.appearance.backgroundImage = "missing.png";
    internal.restoreRecoveryBackground();
  });

  it("recovers prepared, applying and committed journals safely", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    makeDatabase(dbPath);
    const service = new DataTransferService(
      dbPath,
      new FakeDataService() as never,
      new FakeSettings(),
      "0.3.0",
    );
    const staging = path.join(directory, "backup-staging", "prepared");
    fs.mkdirSync(staging, { recursive: true });
    const marker = path.join(staging, "marker");
    fs.writeFileSync(marker, "x");
    fs.writeFileSync(
      path.join(directory, "import-journal.json"),
      JSON.stringify({ status: "prepared", stagingDir: staging }),
    );
    await service.recoverOnStartup();
    expect(fs.existsSync(marker)).toBe(false);

    fs.mkdirSync(path.join(directory, "recovery", "last-known-good"), {
      recursive: true,
    });
    fs.copyFileSync(
      dbPath,
      path.join(directory, "recovery", "last-known-good", "data.db"),
    );
    const outside = path.join(directory, "outside-staging");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "marker"), "keep");
    fs.writeFileSync(
      path.join(directory, "import-journal.json"),
      JSON.stringify({ status: "applying", stagingDir: outside }),
    );
    await service.recoverOnStartup();
    expect(fs.existsSync(path.join(outside, "marker"))).toBe(true);

    const applying = path.join(directory, "backup-staging", "applying");
    fs.mkdirSync(applying, { recursive: true });
    fs.writeFileSync(path.join(applying, "marker"), "x");
    fs.writeFileSync(
      path.join(directory, "import-journal.json"),
      JSON.stringify({ status: "applying", stagingDir: applying }),
    );
    await service.recoverOnStartup();
    expect(fs.existsSync(applying)).toBe(false);

    const committed = path.join(directory, "backup-staging", "committed");
    fs.mkdirSync(committed, { recursive: true });
    fs.writeFileSync(path.join(committed, "marker"), "x");
    fs.writeFileSync(
      path.join(directory, "import-journal.json"),
      JSON.stringify({ status: "committed", stagingDir: committed }),
    );
    await service.recoverOnStartup();
    expect(fs.existsSync(committed)).toBe(false);
    expect(fs.existsSync(path.join(directory, "import-journal.json"))).toBe(
      false,
    );
  });

  it("keeps a recovery-required state when rollback or reopen also fails", async () => {
    const directory = createDirectory();
    const dbPath = path.join(directory, "data.db");
    const archivePath = path.join(directory, "backup.zip");
    makeDatabase(dbPath);
    const data = new FakeDataService();
    const service = new DataTransferService(
      dbPath,
      data as never,
      new FakeSettings(),
      "0.3.0",
    );
    await service.exportToPath(archivePath);
    data.failReopenCount = 2;

    await expect(service.importFromZip(archivePath)).rejects.toMatchObject({
      code: "RESTORE_FAILED_RECOVERY_REQUIRED",
    });
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
