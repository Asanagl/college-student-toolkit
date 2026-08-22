// Backup v2 数据传输服务。
// 先检查 ZIP 中央目录，再把受控条目写入 staging；恢复失败时保留 last-known-good。
import { BrowserWindow, dialog } from "electron";
import Database from "better-sqlite3";
import archiver from "archiver";
import * as yauzl from "yauzl";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  BackupErrorCode,
  BackupExportResult,
  BackupImportResult,
  BackupInspection,
  BackupRecordCounts,
  IpcResult,
  PortableSettings,
} from "../../shared/types";
import { PRODUCT_VERSION } from "../../shared/version";
import {
  CURRENT_DATABASE_SCHEMA_VERSION,
  DatabaseMigrator,
} from "./DatabaseMigrator";
import {
  portableSettingsService,
  type PortableSettingsService,
} from "./PortableSettingsService";
import type { DataService } from "./DataService";

const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_DB_BYTES = 256 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1 * 1024 * 1024;
const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 16;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const V2_DB = "data/data.db";
const V2_SETTINGS = "settings/portable-settings.json";
const V2_MANIFEST = "manifest.json";
const LEGACY_DB = "data.db";
const LEGACY_CONFIG = "config.json";

const manifestSchema = z.object({
  backupFormatVersion: z.literal(2),
  databaseSchemaVersion: z.number().int().nonnegative(),
  portableSettingsVersion: z.literal(1),
  appVersion: z.string().max(64),
  exportedAt: z.string().datetime({ offset: true }),
  includesBackground: z.boolean(),
  recordCounts: z.object({
    schedules: z.number().int().nonnegative(),
    courses: z.number().int().nonnegative(),
    exams: z.number().int().nonnegative(),
    labs: z.number().int().nonnegative(),
    grades: z.number().int().nonnegative(),
    formulas: z.number().int().nonnegative(),
    periods: z.number().int().nonnegative(),
  }),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(128),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(2)
    .max(3),
});

const settingsSchema = z.object({
  portableSettingsVersion: z.literal(1),
  themeMode: z.enum(["system", "light", "dark"]),
  timetable: z.object({
    semesterStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const [year, month, day] = value.split("-").map(Number);
        const candidate = new Date(Date.UTC(year, month - 1, day));
        return (
          candidate.getUTCFullYear() === year &&
          candidate.getUTCMonth() === month - 1 &&
          candidate.getUTCDate() === day
        );
      }, "学期日期无效")
      .nullable(),
  }),
  dnd: z.object({
    enabled: z.boolean(),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  notificationHistory: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        title: z.string().max(200),
        body: z.string().max(2000),
        source: z.string().max(32),
        timestamp: z.string().datetime({ offset: true }),
        delivered: z.boolean(),
      }),
    )
    .max(100),
  appearance: z.object({
    material: z.enum(["none", "acrylic"]),
    backgroundImage: z.string().max(128).nullable(),
    blurRadius: z.number().int().min(0).max(50),
    clarity: z.number().int().min(0).max(100),
  }),
});

interface ZipEntryInfo {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
  externalFileAttributes: number;
}

interface PendingImport {
  ownerId: number;
  stagingDir: string;
  format: 1 | 2;
  sourcePath: string;
  inspection: BackupInspection;
  settings: PortableSettings | null;
  backgroundName: string | null;
}

interface SettingsAccess {
  get(): PortableSettings;
  replace(next: PortableSettings): PortableSettings;
}

export class BackupTransferError extends Error {
  readonly code: BackupErrorCode;
  readonly causeValue?: unknown;

  constructor(
    code: BackupErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.code = code;
    this.name = "BackupTransferError";
    this.causeValue = options?.cause;
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEntryName(name: string): boolean {
  if (
    !name ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name)
  )
    return false;
  return !name.split("/").some((part) => part === ".." || part === "");
}

function isSymlink(entry: ZipEntryInfo): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class DataTransferService {
  private readonly stagingRoot: string;
  private readonly recoveryRoot: string;
  private pending: PendingImport | null = null;
  private busy = false;

  constructor(
    private readonly dbPath: string,
    private readonly dataService: DataService,
    private readonly settings: SettingsAccess = portableSettingsService,
    private readonly appVersion = PRODUCT_VERSION,
  ) {
    const userData = path.dirname(dbPath);
    this.stagingRoot = path.join(userData, "backup-staging");
    this.recoveryRoot = path.join(userData, "recovery", "last-known-good");
  }

  /**
   * 主进程在恢复替换数据库期间必须拒绝新的写入 IPC，避免连接已关闭时发生并发写入。
   */
  isBusy(): boolean {
    return this.busy;
  }

  async exportBackup(
    parent: BrowserWindow | null = null,
  ): Promise<IpcResult<BackupExportResult>> {
    const testPath = process.env.COLLEGE_TOOLKIT_E2E_BACKUP_PATH?.trim();
    if (testPath) {
      // The packaged E2E runner cannot drive a native Windows save dialog.
      // Keep this seam process-scoped so the renderer still never supplies a path.
      try {
        return {
          ok: true,
          data: await this.exportToPath(path.resolve(testPath)),
        };
      } catch (error) {
        return this.errorResult(error);
      }
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, this.saveDialogOptions())
      : await dialog.showSaveDialog(this.saveDialogOptions());
    if (result.canceled || !result.filePath) return { ok: true };
    try {
      return { ok: true, data: await this.exportToPath(result.filePath) };
    } catch (error) {
      return this.errorResult(error);
    }
  }

  async exportToPath(filePath: string): Promise<BackupExportResult> {
    this.assertNotBusy();
    this.busy = true;
    const settings = this.settings.get();
    const counts = this.dataService.getRecordCounts();
    const backgroundPath = this.getBackgroundPath(
      settings.appearance.backgroundImage,
    );
    try {
      this.dataService.closeDatabase();
      await this.writeV2Archive(filePath, settings, counts, backgroundPath);
      const stat = fs.statSync(filePath);
      return {
        filePath,
        backupFormatVersion: 2,
        databaseSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
        includesBackground: !!backgroundPath,
        bytes: stat.size,
      };
    } finally {
      this.reopenDatabase();
      this.busy = false;
    }
  }

  async exportToZip(filePath: string): Promise<void> {
    await this.exportToPath(filePath);
  }

  async prepareImport(
    ownerId: number,
    parent: BrowserWindow | null = null,
  ): Promise<IpcResult<BackupImportResult>> {
    const testPath = process.env.COLLEGE_TOOLKIT_E2E_IMPORT_PATH?.trim();
    if (testPath) {
      try {
        return {
          ok: true,
          data: {
            inspection: await this.stageImport(path.resolve(testPath), ownerId),
          },
        };
      } catch (error) {
        return this.errorResult(error);
      }
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, this.openDialogOptions())
      : await dialog.showOpenDialog(this.openDialogOptions());
    if (result.canceled || result.filePaths.length === 0) return { ok: true };
    try {
      const inspection = await this.stageImport(result.filePaths[0], ownerId);
      return { ok: true, data: { inspection } };
    } catch (error) {
      return this.errorResult(error);
    }
  }

  async commitImport(
    ownerId: number,
    token: string,
  ): Promise<IpcResult<BackupInspection>> {
    try {
      const pending = this.takePending(ownerId, token);
      return { ok: true, data: await this.applyPending(pending) };
    } catch (error) {
      return this.errorResult(error);
    }
  }

  async cancelImport(
    ownerId: number,
    token: string,
  ): Promise<IpcResult<boolean>> {
    try {
      // 取消的首要职责是清理 staging；即使预检刚过期，也不能把临时数据留在磁盘上。
      const pending = this.takePending(ownerId, token, false);
      this.removeStaging(pending.stagingDir);
      this.removeJournal();
      this.pending = null;
      return { ok: true, data: true };
    } catch (error) {
      return this.errorResult(error);
    }
  }

  async recoverOnStartup(): Promise<void> {
    const journalPath = path.join(
      path.dirname(this.dbPath),
      "import-journal.json",
    );
    if (!fs.existsSync(journalPath)) return;
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
        status?: string;
        stagingDir?: string;
      };
      if (
        !journal.status ||
        !["prepared", "applying", "committed"].includes(journal.status)
      ) {
        throw new Error("恢复日志状态未知");
      }
      if (journal.status === "applying") this.restoreRecoveryPoint();
      if (journal.stagingDir && this.isStagingPath(journal.stagingDir))
        this.removeStaging(journal.stagingDir);
      fs.rmSync(journalPath, { force: true });
    } catch (error) {
      throw new BackupTransferError(
        "RESTORE_FAILED_RECOVERY_REQUIRED",
        "恢复日志损坏，请使用恢复点或手动备份",
        { cause: error },
      );
    }
  }

  async importFromZip(filePath: string): Promise<void> {
    const inspection = await this.stageImport(filePath, 0);
    const pending = this.pending;
    if (!pending) throw new Error("备份预检没有生成导入任务");
    await this.applyPending(pending);
    if (!inspection) throw new Error("备份恢复失败");
  }

  dispose(): void {
    if (this.pending) this.removeStaging(this.pending.stagingDir);
    this.removeJournal();
    this.pending = null;
  }

  private async stageImport(
    sourcePath: string,
    ownerId: number,
  ): Promise<BackupInspection> {
    this.assertNotBusy();
    if (this.pending)
      throw new BackupTransferError("BACKUP_BUSY", "已有备份预检正在等待确认");
    const entries = await this.readCentralDirectory(sourcePath);
    const format = this.detectFormat(entries);
    const token = randomUUID();
    const stagingDir = this.createStagingDir(token);
    try {
      await this.extractAllowedEntries(sourcePath, entries, stagingDir, format);
      const staged = await this.readStagedBackup(stagingDir, format);
      const counts = this.inspectDatabase(
        path.join(stagingDir, format === 2 ? V2_DB : LEGACY_DB),
      );
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
      const inspection: BackupInspection = {
        token,
        backupFormatVersion: format,
        databaseSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
        portableSettingsVersion: staged.settings ? 1 : 0,
        recordCounts: counts,
        includesSettings: !!staged.settings,
        includesBackground: !!staged.backgroundName,
        warnings:
          format === 1
            ? ["legacy v1 只替换业务数据库，当前机器设置保持不变"]
            : [],
        expiresAt,
      };
      this.writeJournal(
        path.join(path.dirname(this.dbPath), "import-journal.json"),
        { status: "prepared", token, stagingDir },
      );
      this.pending = {
        ownerId,
        stagingDir,
        format,
        sourcePath,
        inspection,
        settings: staged.settings,
        backgroundName: staged.backgroundName,
      };
      return inspection;
    } catch (error) {
      this.removeStaging(stagingDir);
      throw error;
    }
  }

  private async applyPending(
    pending: PendingImport,
  ): Promise<BackupInspection> {
    this.busy = true;
    const journalPath = path.join(
      path.dirname(this.dbPath),
      "import-journal.json",
    );
    let recoveryCreated = false;
    try {
      this.dataService.closeDatabase();
      this.createRecoveryPoint();
      recoveryCreated = true;
      this.writeJournal(journalPath, {
        status: "applying",
        token: pending.inspection.token,
      });
      this.replaceDatabase(pending.stagingDir, pending.format);
      if (pending.settings) this.applySettings(pending);
      this.reopenDatabase();
      this.writeJournal(journalPath, {
        status: "committed",
        token: pending.inspection.token,
      });
      this.removeStaging(pending.stagingDir);
      this.pending = null;
      fs.rmSync(journalPath, { force: true });
      return pending.inspection;
    } catch (error) {
      const recovered = recoveryCreated && this.tryRollback();
      let reopened = false;
      if (recovered || !recoveryCreated) {
        try {
          this.reopenDatabase();
          reopened = true;
        } catch {
          reopened = false;
        }
      }
      this.pending = null;
      this.removeStaging(pending.stagingDir);
      this.removeJournal();
      const originalStateStillIntact = !recoveryCreated || recovered;
      if (!originalStateStillIntact || !reopened)
        throw new BackupTransferError(
          "RESTORE_FAILED_RECOVERY_REQUIRED",
          "恢复失败且无法自动回滚，请使用 recovery/last-known-good",
          { cause: error },
        );
      throw new BackupTransferError(
        "RESTORE_FAILED_ROLLED_BACK",
        "恢复失败，已自动回滚到最近可用数据",
        { cause: error },
      );
    } finally {
      this.busy = false;
    }
  }

  private async writeV2Archive(
    filePath: string,
    settings: PortableSettings,
    counts: BackupRecordCounts,
    backgroundPath: string | null,
  ): Promise<void> {
    const target = path.resolve(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(this.dbPath))
      throw new Error("数据库文件不存在，无法导出");
    const files: Array<{ path: string; source?: string; content?: Buffer }> = [
      { path: V2_DB, source: this.dbPath },
      {
        path: V2_SETTINGS,
        content: Buffer.from(JSON.stringify(settings, null, 2)),
      },
    ];
    if (backgroundPath)
      files.push({
        path: `assets/background${path.extname(backgroundPath)}`,
        source: backgroundPath,
      });
    const manifest = {
      backupFormatVersion: 2,
      databaseSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
      portableSettingsVersion: 1,
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
      includesBackground: !!backgroundPath,
      recordCounts: counts,
      files: await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          bytes: file.source
            ? fs.statSync(file.source).size
            : (file.content?.byteLength ?? 0),
          sha256: file.source
            ? await sha256File(file.source)
            : sha256Buffer(file.content as Buffer),
        })),
      ),
    };
    await this.createArchive(target, manifest, files);
  }

  private createArchive(
    target: string,
    manifest: unknown,
    files: Array<{ path: string; source?: string; content?: Buffer }>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(target);
      const archive = archiver("zip", { zlib: { level: 9 } });
      const fail = (error: unknown) => reject(toError(error));
      output.on("close", resolve);
      output.on("error", fail);
      archive.on("error", fail);
      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: V2_MANIFEST });
      for (const file of files) {
        if (file.source) archive.file(file.source, { name: file.path });
        else if (file.content)
          archive.append(file.content, { name: file.path });
      }
      void archive.finalize().catch(fail);
    });
  }

  private async readCentralDirectory(
    filePath: string,
  ): Promise<ZipEntryInfo[]> {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ZIP_BYTES)
      throw new BackupTransferError(
        "BACKUP_INVALID",
        "备份 ZIP 超过 256 MiB 限制",
      );
    return new Promise((resolve, reject) => {
      yauzl.open(
        filePath,
        { lazyEntries: true, decodeStrings: true },
        (error, zip) => {
          if (error || !zip) {
            reject(
              new BackupTransferError(
                "BACKUP_CORRUPT",
                "无法读取 ZIP 中央目录",
                { cause: error },
              ),
            );
            return;
          }
          const entries: ZipEntryInfo[] = [];
          const names = new Set<string>();
          zip.on("entry", (entry) => {
            const info: ZipEntryInfo = {
              fileName: entry.fileName,
              compressedSize: entry.compressedSize,
              uncompressedSize: entry.uncompressedSize,
              encrypted: !!(entry.generalPurposeBitFlag & 1),
              externalFileAttributes: entry.externalFileAttributes,
            };
            try {
              this.validateEntry(info, names, entries);
              entries.push(info);
              zip.readEntry();
            } catch (entryError) {
              zip.close();
              reject(entryError);
            }
          });
          zip.once("end", () => resolve(entries));
          zip.once("error", (zipError) =>
            reject(
              new BackupTransferError("BACKUP_CORRUPT", "读取 ZIP 条目失败", {
                cause: zipError,
              }),
            ),
          );
          zip.readEntry();
        },
      );
    });
  }

  private validateEntry(
    entry: ZipEntryInfo,
    names: Set<string>,
    entries: ZipEntryInfo[],
  ): void {
    if (entries.length >= MAX_ENTRIES)
      throw new BackupTransferError(
        "BACKUP_INVALID",
        "备份 ZIP 条目数量超过限制",
      );
    if (!safeEntryName(entry.fileName) || isSymlink(entry) || entry.encrypted)
      throw new BackupTransferError(
        "BACKUP_INVALID",
        `备份包含不安全条目：${entry.fileName}`,
      );
    if (names.has(entry.fileName))
      throw new BackupTransferError(
        "BACKUP_INVALID",
        `备份包含重复条目：${entry.fileName}`,
      );
    names.add(entry.fileName);
    const total = entries.reduce(
      (sum, item) => sum + item.uncompressedSize,
      entry.uncompressedSize,
    );
    if (total > MAX_UNCOMPRESSED_BYTES)
      throw new BackupTransferError(
        "BACKUP_INVALID",
        "备份解压总量超过 512 MiB 限制",
      );
  }

  private detectFormat(entries: ZipEntryInfo[]): 1 | 2 {
    const names = new Set(entries.map((entry) => entry.fileName));
    if (names.has(V2_MANIFEST)) return 2;
    if (names.has(LEGACY_DB) && names.has(LEGACY_CONFIG)) return 1;
    throw new BackupTransferError(
      "BACKUP_INVALID",
      "不是支持的 v1/v2 备份格式",
    );
  }

  private async extractAllowedEntries(
    filePath: string,
    entries: ZipEntryInfo[],
    stagingDir: string,
    format: 1 | 2,
  ): Promise<void> {
    const allowed =
      format === 2
        ? new Set([V2_MANIFEST, V2_DB, V2_SETTINGS])
        : new Set([LEGACY_DB, LEGACY_CONFIG, "timetable.json"]);
    for (const entry of entries) {
      const isBackground =
        format === 2 && /^assets\/background\.[a-z0-9]+$/i.test(entry.fileName);
      if (!allowed.has(entry.fileName) && !isBackground)
        throw new BackupTransferError(
          "BACKUP_INVALID",
          `备份包含未知条目：${entry.fileName}`,
        );
      const limit = entry.fileName.includes("data.db")
        ? MAX_DB_BYTES
        : entry.fileName.includes("portable-settings")
          ? MAX_SETTINGS_BYTES
          : MAX_BACKGROUND_BYTES;
      if (entry.uncompressedSize > limit)
        throw new BackupTransferError(
          "BACKUP_INVALID",
          `备份条目超过大小限制：${entry.fileName}`,
        );
      const data = await this.readEntryBuffer(filePath, entry.fileName, limit);
      const target = path.join(stagingDir, entry.fileName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }

  private async readStagedBackup(
    stagingDir: string,
    format: 1 | 2,
  ): Promise<{
    settings: PortableSettings | null;
    backgroundName: string | null;
  }> {
    if (format === 1) return { settings: null, backgroundName: null };
    const manifest = this.readJson(path.join(stagingDir, V2_MANIFEST));
    const parsedManifest = manifestSchema.safeParse(manifest);
    if (
      !parsedManifest.success ||
      parsedManifest.data.databaseSchemaVersion >
        CURRENT_DATABASE_SCHEMA_VERSION
    ) {
      throw new BackupTransferError(
        parsedManifest.success ? "BACKUP_TOO_NEW" : "BACKUP_INVALID",
        "备份 manifest 无效或版本过新",
      );
    }
    const files = new Map(
      parsedManifest.data.files.map((file) => [file.path, file]),
    );
    if (
      files.size !== parsedManifest.data.files.length ||
      !files.has(V2_DB) ||
      !files.has(V2_SETTINGS)
    ) {
      throw new BackupTransferError(
        "BACKUP_INVALID",
        "manifest 未完整声明数据库和便携设置",
      );
    }
    const settings = settingsSchema.safeParse(
      this.readJson(path.join(stagingDir, V2_SETTINGS)),
    );
    if (!settings.success)
      throw new BackupTransferError("BACKUP_INVALID", "便携设置校验失败");
    const assetsDir = path.join(stagingDir, "assets");
    const backgrounds = fs.existsSync(assetsDir)
      ? fs
          .readdirSync(assetsDir, { withFileTypes: true })
          .filter(
            (item) =>
              item.isFile() && /^background\.[a-z0-9]+$/i.test(item.name),
          )
      : [];
    if (backgrounds.length > 1)
      throw new BackupTransferError("BACKUP_INVALID", "备份只能包含一个背景图");
    const background = backgrounds[0];
    if (parsedManifest.data.includesBackground && !background)
      throw new BackupTransferError(
        "BACKUP_CORRUPT",
        "manifest 声明有背景图但文件不存在",
      );
    if (!parsedManifest.data.includesBackground && background)
      throw new BackupTransferError(
        "BACKUP_INVALID",
        "manifest 未声明背景图但 ZIP 包含背景图",
      );
    if (background && !files.has(`assets/${background.name}`))
      throw new BackupTransferError(
        "BACKUP_CORRUPT",
        "背景图未在 manifest 中声明",
      );
    if (parsedManifest.data.includesBackground && files.size !== 3)
      throw new BackupTransferError(
        "BACKUP_INVALID",
        "manifest 背景图文件列表不完整",
      );
    if (!parsedManifest.data.includesBackground && files.size !== 2)
      throw new BackupTransferError(
        "BACKUP_INVALID",
        "manifest 包含未声明的额外文件",
      );
    await Promise.all(
      [...files.values()].map((file) =>
        this.verifyStagedFile(stagingDir, file.path, file.bytes, file.sha256),
      ),
    );
    return {
      settings: settings.data as PortableSettings,
      backgroundName: background?.name ?? null,
    };
  }

  private inspectDatabase(dbPath: string): BackupRecordCounts {
    const db = new Database(dbPath);
    try {
      DatabaseMigrator.ensureCurrent(db, () => {
        throw new Error("备份数据库缺少业务表");
      });
      const count = (table: string) =>
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count;
      return {
        schedules: count("schedule_items"),
        courses: count("courses"),
        exams: count("exams"),
        labs: count("labs"),
        grades: count("grades"),
        formulas: count("gpa_formula"),
        periods: count("period_config"),
      };
    } finally {
      db.close();
    }
  }

  private async verifyStagedFile(
    stagingDir: string,
    relativePath: string,
    bytes: number,
    expectedHash: string,
  ): Promise<void> {
    if (!safeEntryName(relativePath))
      throw new BackupTransferError(
        "BACKUP_INVALID",
        `manifest 路径不安全：${relativePath}`,
      );
    const filePath = path.join(stagingDir, relativePath);
    if (!fs.existsSync(filePath))
      throw new BackupTransferError(
        "BACKUP_CORRUPT",
        `manifest 文件缺失：${relativePath}`,
      );
    const stat = fs.statSync(filePath);
    if (
      !stat.isFile() ||
      stat.size !== bytes ||
      (await sha256File(filePath)) !== expectedHash
    )
      throw new BackupTransferError(
        "BACKUP_CORRUPT",
        `文件哈希或大小不匹配：${relativePath}`,
      );
  }

  private async readEntryBuffer(
    filePath: string,
    name: string,
    limit: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
        if (error || !zip)
          return reject(
            new BackupTransferError("BACKUP_CORRUPT", "无法打开备份条目", {
              cause: error,
            }),
          );
        const fail = (reason: unknown) => {
          zip.close();
          reject(
            new BackupTransferError("BACKUP_CORRUPT", `读取条目失败：${name}`, {
              cause: reason,
            }),
          );
        };
        zip.on("entry", (entry) => {
          if (entry.fileName !== name) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail(streamError);
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes <= limit) chunks.push(chunk);
              else stream.destroy(new Error("entry too large"));
            });
            stream.on("error", fail);
            stream.on("end", () => {
              zip.close();
              if (bytes > limit)
                reject(
                  new BackupTransferError(
                    "BACKUP_INVALID",
                    `条目超过限制：${name}`,
                  ),
                );
              else resolve(Buffer.concat(chunks));
            });
          });
        });
        zip.once("error", fail);
        zip.readEntry();
      });
    });
  }

  private takePending(
    ownerId: number,
    token: string,
    checkExpiry = true,
  ): PendingImport {
    const pending = this.pending;
    if (
      !pending ||
      pending.ownerId !== ownerId ||
      pending.inspection.token !== token
    )
      throw new BackupTransferError("BACKUP_INVALID", "导入预检 token 无效");
    if (checkExpiry && Date.now() > Date.parse(pending.inspection.expiresAt))
      throw new BackupTransferError(
        "BACKUP_EXPIRED",
        "导入预检已过期，请重新选择备份",
      );
    return pending;
  }

  private createStagingDir(token: string): string {
    fs.mkdirSync(this.stagingRoot, { recursive: true });
    return fs.mkdtempSync(path.join(this.stagingRoot, `${token}-`));
  }

  private createRecoveryPoint(): void {
    fs.rmSync(this.recoveryRoot, { recursive: true, force: true });
    fs.mkdirSync(this.recoveryRoot, { recursive: true });
    if (fs.existsSync(this.dbPath))
      fs.copyFileSync(this.dbPath, path.join(this.recoveryRoot, "data.db"));
    fs.copyFileSync(
      this.settingsPath(),
      path.join(this.recoveryRoot, "portable-settings.json"),
    );
    const background = this.getBackgroundPath(
      this.settings.get().appearance.backgroundImage,
    );
    if (background) {
      const targetDir = path.join(this.recoveryRoot, "backgrounds");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(
        background,
        path.join(targetDir, path.basename(background)),
      );
    }
  }

  private replaceDatabase(stagingDir: string, format: 1 | 2): void {
    const source = path.join(stagingDir, format === 2 ? V2_DB : LEGACY_DB);
    const incoming = `${this.dbPath}.incoming`;
    fs.copyFileSync(source, incoming);
    fs.rmSync(`${this.dbPath}-wal`, { force: true });
    fs.rmSync(`${this.dbPath}-shm`, { force: true });
    this.replaceFile(incoming, this.dbPath);
  }

  private applySettings(pending: PendingImport): void {
    if (!pending.settings) return;
    const next = {
      ...pending.settings,
      appearance: { ...pending.settings.appearance },
    };
    if (pending.backgroundName) {
      const extension = path.extname(pending.backgroundName).toLowerCase();
      const targetName = `restored-background${extension}`;
      const target = path.join(
        path.dirname(this.dbPath),
        "backgrounds",
        targetName,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(
        path.join(pending.stagingDir, "assets", pending.backgroundName),
        target,
      );
      next.appearance.backgroundImage = targetName;
    } else {
      next.appearance.backgroundImage = null;
    }
    this.settings.replace(next);
  }

  private tryRollback(): boolean {
    try {
      this.dataService.closeDatabase();
      const source = path.join(this.recoveryRoot, "data.db");
      if (!fs.existsSync(source)) return false;
      fs.copyFileSync(source, `${this.dbPath}.rollback`);
      this.replaceFile(`${this.dbPath}.rollback`, this.dbPath);
      const settingsPath = path.join(
        this.recoveryRoot,
        "portable-settings.json",
      );
      if (fs.existsSync(settingsPath))
        this.settings.replace(this.readJson(settingsPath) as PortableSettings);
      this.restoreRecoveryBackground();
      return true;
    } catch {
      return false;
    }
  }

  private restoreRecoveryPoint(): void {
    const source = path.join(this.recoveryRoot, "data.db");
    if (!fs.existsSync(source)) throw new Error("恢复点数据库不存在");
    fs.copyFileSync(source, `${this.dbPath}.startup-recovery`);
    this.replaceFile(`${this.dbPath}.startup-recovery`, this.dbPath);
    const settingsPath = path.join(this.recoveryRoot, "portable-settings.json");
    if (fs.existsSync(settingsPath))
      this.settings.replace(this.readJson(settingsPath) as PortableSettings);
    this.restoreRecoveryBackground();
  }

  private replaceFile(source: string, target: string): void {
    const old = `${target}.old`;
    if (fs.existsSync(target)) fs.renameSync(target, old);
    try {
      fs.renameSync(source, target);
      fs.rmSync(old, { force: true });
    } catch (error) {
      if (fs.existsSync(old)) fs.renameSync(old, target);
      throw error;
    }
  }

  private reopenDatabase(): void {
    try {
      this.dataService.reopenAfterTransfer();
    } catch (error) {
      throw new BackupTransferError(
        "RESTORE_FAILED_RECOVERY_REQUIRED",
        "数据库重新打开失败",
        { cause: error },
      );
    }
  }

  private removeStaging(stagingDir: string): void {
    if (!this.isStagingPath(stagingDir)) return;
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  private isStagingPath(candidate: string): boolean {
    const root = `${path.resolve(this.stagingRoot)}${path.sep}`;
    return path.resolve(candidate).startsWith(root);
  }

  private restoreRecoveryBackground(): void {
    const name = this.settings.get().appearance.backgroundImage;
    if (!name || path.basename(name) !== name) return;
    const source = path.join(this.recoveryRoot, "backgrounds", name);
    if (!fs.existsSync(source)) return;
    const target = path.join(path.dirname(this.dbPath), "backgrounds", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  private readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  }

  private writeJournal(filePath: string, value: Record<string, unknown>): void {
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temp, filePath);
  }

  private removeJournal(): void {
    fs.rmSync(path.join(path.dirname(this.dbPath), "import-journal.json"), {
      force: true,
    });
  }

  private getBackgroundPath(fileName: string | null): string | null {
    if (!fileName || path.basename(fileName) !== fileName) return null;
    const candidate = path.join(
      path.dirname(this.dbPath),
      "backgrounds",
      fileName,
    );
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : null;
  }

  private settingsPath(): string {
    const filePath =
      this.settings instanceof Object && "getFilePath" in this.settings
        ? (this.settings as PortableSettingsService).getFilePath()
        : path.join(path.dirname(this.dbPath), "portable-settings.json");
    if (!fs.existsSync(filePath))
      fs.writeFileSync(
        filePath,
        JSON.stringify(this.settings.get(), null, 2),
        "utf8",
      );
    return filePath;
  }

  private assertNotBusy(): void {
    if (this.busy)
      throw new BackupTransferError("BACKUP_BUSY", "备份操作正在进行");
  }

  private errorResult(error: unknown): IpcResult<never> {
    const value = toError(error);
    const code =
      error instanceof BackupTransferError ? error.code : "BACKUP_INVALID";
    return { ok: false, error: value.message, errorCode: code };
  }

  private saveDialogOptions(): Electron.SaveDialogOptions {
    return {
      title: "导出完整备份",
      defaultPath: "toolkit-backup-v2.zip",
      filters: [{ name: "大学生工具组备份", extensions: ["zip"] }],
    };
  }

  private openDialogOptions(): Electron.OpenDialogOptions {
    return {
      title: "选择大学生工具组备份",
      properties: ["openFile"],
      filters: [{ name: "大学生工具组备份", extensions: ["zip"] }],
    };
  }
}
