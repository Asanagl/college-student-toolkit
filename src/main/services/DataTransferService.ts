// 数据导入导出服务：将 data.db 与 config.json 打包为 ZIP，或从 ZIP 恢复。
// 导出/导入前后需要先关闭/重开 SQLite 连接，以释放文件锁。
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import archiver from 'archiver';
import { Extract as UnzipExtract } from 'unzip-stream';
import type { DataService } from './DataService';

/** 备份文件的配置信息，与 data.db 一同打包 */
interface BackupConfig {
  appVersion: string;
  exportedAt: string;
  /** 数据库 schema 版本，用于导入时兼容性校验 */
  schemaVersion: number;
}

const CURRENT_SCHEMA_VERSION = 1;

export class DataTransferService {
  constructor(
    private readonly dbPath: string,
    private readonly dataService: DataService
  ) {}

  /** 导出：关闭连接 → 打包 data.db + config.json → 重开连接 */
  async exportToZip(filePath: string): Promise<void> {
    this.dataService.closeDatabase();
    try {
      await this.packZip(filePath);
    } finally {
      // 无论打包成功与否都要重开连接，否则后续数据库操作全部失效
      this.dataService.openDatabase();
    }
  }

  /** 导入：关闭连接 → 解压校验 → 备份并替换 → 重开连接 */
  async importFromZip(filePath: string): Promise<void> {
    this.dataService.closeDatabase();
    try {
      await this.restoreFromZip(filePath);
    } finally {
      this.dataService.openDatabase();
    }
  }

  /** 将 data.db 与 config.json 打包为 ZIP */
  private packZip(targetPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(targetPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve());
      output.on('error', (err) => reject(err));
      archive.on('error', (err) => reject(err));

      archive.pipe(output);

      // 加入数据库文件；若不存在（首次空库）则跳过，仅导出配置
      if (fs.existsSync(this.dbPath)) {
        archive.file(this.dbPath, { name: 'data.db' });
      }

      const config: BackupConfig = {
        appVersion: app.getVersion(),
        exportedAt: new Date().toISOString(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
      archive.append(JSON.stringify(config, null, 2), { name: 'config.json' });

      archive.finalize();
    });
  }

  /** 解压 ZIP 到临时目录，校验后替换当前 data.db */
  private restoreFromZip(srcPath: string): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-import-'));
    return new Promise<void>((resolve, reject) => {
      const stream = fs
        .createReadStream(srcPath)
        .pipe(UnzipExtract({ path: tmpDir }));
      stream.on('close', () => {
        try {
          this.applyRestoredData(tmpDir);
          // 清理临时目录，忽略清理失败
          fs.rmSync(tmpDir, { recursive: true, force: true });
          resolve();
        } catch (err) {
          // 还原过程中出错也要清理临时目录
          fs.rmSync(tmpDir, { recursive: true, force: true });
          reject(err);
        }
      });
      stream.on('error', (err) => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(err);
      });
    });
  }

  /** 校验解压内容并替换 data.db，替换前先备份为 data.db.bak */
  private applyRestoredData(tmpDir: string): void {
    const configPath = path.join(tmpDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error('备份文件缺少 config.json，无法校验版本');
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as BackupConfig;
    if (config.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      // 版本不匹配时拒绝导入，避免 schema 不兼容导致后续崩溃
      throw new Error(
        `备份文件版本不兼容（当前 v${CURRENT_SCHEMA_VERSION}，文件 v${config.schemaVersion}）`
      );
    }

    const extractedDb = path.join(tmpDir, 'data.db');
    if (!fs.existsSync(extractedDb)) {
      throw new Error('备份文件缺少 data.db');
    }

    // 备份当前数据库；若备份已存在则覆盖，保留最近一次的回滚能力
    const bakPath = `${this.dbPath}.bak`;
    if (fs.existsSync(this.dbPath)) {
      fs.copyFileSync(this.dbPath, bakPath);
    }

    // 替换数据库文件（含 WAL/SHM 临时文件清理，避免旧 WAL 干扰）
    this.cleanupWalFiles();
    fs.copyFileSync(extractedDb, this.dbPath);
  }

  /** 删除 data.db-wal / data.db-shm，避免导入后残留旧 WAL 导致数据不一致 */
  private cleanupWalFiles(): void {
    for (const suffix of ['-wal', '-shm']) {
      const p = `${this.dbPath}${suffix}`;
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
      }
    }
  }
}
