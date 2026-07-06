// 数据服务：负责 SQLite 数据库初始化、表结构创建、默认数据播种，
// 并持有各表的 Repository 实例供主进程调用。
// 实现阶段：Phase 1
import { app } from 'electron';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { PeriodConfig } from '../../shared/types';
import {
  CourseRepository,
  ExamRepository,
  GpaFormulaRepository,
  GradeRepository,
  LabRepository,
  PeriodConfigRepository,
  ScheduleRepository,
} from './repositories';
import { DataTransferService } from './DataTransferService';

/**
 * 默认 12 节课时间配置，参考中国大学常规作息：
 * 上午 4 节（第3-4节间大课间 20 分钟），下午 4 节，晚上 4 节，末节 break_after=0。
 * reminder_offset 统一默认 10 分钟，is_lab 默认 false。
 */
const DEFAULT_PERIODS: PeriodConfig[] = [
  { index: 1, startTime: '08:00', endTime: '08:45', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 2, startTime: '08:55', endTime: '09:40', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 3, startTime: '09:50', endTime: '10:35', breakAfter: 20, isLab: false, reminderOffset: 10 },
  { index: 4, startTime: '10:55', endTime: '11:40', breakAfter: 110, isLab: false, reminderOffset: 10 },
  { index: 5, startTime: '13:30', endTime: '14:15', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 6, startTime: '14:25', endTime: '15:10', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 7, startTime: '15:20', endTime: '16:05', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 8, startTime: '16:15', endTime: '17:00', breakAfter: 90, isLab: false, reminderOffset: 10 },
  { index: 9, startTime: '18:30', endTime: '19:15', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 10, startTime: '19:25', endTime: '20:10', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 11, startTime: '20:20', endTime: '21:05', breakAfter: 10, isLab: false, reminderOffset: 10 },
  { index: 12, startTime: '21:15', endTime: '22:00', breakAfter: 0, isLab: false, reminderOffset: 10 },
];

export class DataService {
  private static instance: DataService | null = null;
  private initialized = false;
  private db: Database.Database | null = null;
  private transfer: DataTransferService | null = null;

  // 各表仓库实例，init 后才可用
  public schedules!: ScheduleRepository;
  public courses!: CourseRepository;
  public periodConfig!: PeriodConfigRepository;
  public exams!: ExamRepository;
  public labs!: LabRepository;
  public grades!: GradeRepository;
  public formulas!: GpaFormulaRepository;

  private constructor() {
    // 私有构造，强制走 getInstance
  }

  static getInstance(): DataService {
    if (!DataService.instance) {
      DataService.instance = new DataService();
    }
    return DataService.instance;
  }

  /** 数据库文件路径：userData 目录下的 data.db */
  getDbPath(): string {
    return path.join(app.getPath('userData'), 'data.db');
  }

  /** 初始化数据库连接、表结构、默认数据与仓库实例 */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.openDatabase();
    this.seedDefaults();
    this.transfer = new DataTransferService(this.getDbPath(), this);
    this.initialized = true;
  }

  /** 打开数据库连接并创建表与仓库实例（可在导入数据后重新调用） */
  openDatabase(): void {
    if (this.db) {
      return;
    }
    this.db = new Database(this.getDbPath());
    // WAL 模式提升并发读写性能，且在崩溃时更不易损坏
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createTables();
    this.initRepositories();
  }

  /** 关闭数据库连接（导入导出时需要先释放文件锁） */
  closeDatabase(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** 创建 7 张表，使用 IF NOT EXISTS 保证幂等 */
  private createTables(): void {
    if (!this.db) {
      throw new Error('数据库未初始化，无法创建表');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        reminder_offset INTEGER NOT NULL,
        repeat_rule TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        teacher TEXT,
        location TEXT,
        start_week INTEGER NOT NULL,
        end_week INTEGER NOT NULL,
        weekday INTEGER NOT NULL,
        start_period INTEGER NOT NULL,
        end_period INTEGER NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS period_config (
        period_index INTEGER PRIMARY KEY,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        break_after INTEGER NOT NULL,
        is_lab INTEGER NOT NULL,
        reminder_offset INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY,
        course_name TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        location TEXT,
        seat TEXT,
        notes TEXT,
        reminder_offsets TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS labs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        location TEXT,
        instructor TEXT,
        notes TEXT,
        reminder_offsets TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS grades (
        id TEXT PRIMARY KEY,
        course_name TEXT NOT NULL,
        semester TEXT NOT NULL,
        credit REAL NOT NULL,
        grade_point REAL NOT NULL,
        score REAL,
        is_degree_course INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gpa_formula (
        id TEXT PRIMARY KEY,
        formula TEXT NOT NULL,
        is_default INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_courses_weekday_week ON courses(weekday, start_week);
      CREATE INDEX IF NOT EXISTS idx_exams_date ON exams(date);
      CREATE INDEX IF NOT EXISTS idx_labs_date ON labs(date);
      CREATE INDEX IF NOT EXISTS idx_grades_semester ON grades(semester);
    `);
  }

  /** 实例化各表仓库 */
  private initRepositories(): void {
    if (!this.db) {
      throw new Error('数据库未初始化，无法创建仓库');
    }
    this.schedules = new ScheduleRepository(this.db);
    this.courses = new CourseRepository(this.db);
    this.periodConfig = new PeriodConfigRepository(this.db);
    this.exams = new ExamRepository(this.db);
    this.labs = new LabRepository(this.db);
    this.grades = new GradeRepository(this.db);
    this.formulas = new GpaFormulaRepository(this.db);
  }

  /** 首次启动时插入默认 GPA 公式与节次配置；已有数据则跳过 */
  private seedDefaults(): void {
    if (!this.db) {
      throw new Error('数据库未初始化，无法播种默认数据');
    }
    // 默认 GPA 公式：仅当不存在 id='default' 时插入
    const formulaCount = this.db
      .prepare('SELECT COUNT(*) AS c FROM gpa_formula WHERE id = ?')
      .get('default') as { c: number };
    if (formulaCount.c === 0) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO gpa_formula (id, formula, is_default, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('default', 'SUM(credit * grade_point) / SUM(credit)', 1, '默认公式', now, now);
    }

    // 默认 12 节课：仅当表为空时插入
    const periodCount = this.db.prepare('SELECT COUNT(*) AS c FROM period_config').get() as {
      c: number;
    };
    if (periodCount.c === 0) {
      for (const p of DEFAULT_PERIODS) {
        this.periodConfig.insert(p);
      }
    }
  }

  /** 导出数据到 ZIP 文件（委托给 DataTransferService） */
  async exportToZip(filePath: string): Promise<void> {
    if (!this.transfer) {
      throw new Error('DataService 未初始化，无法导出');
    }
    return this.transfer.exportToZip(filePath);
  }

  /** 从 ZIP 文件导入数据（委托给 DataTransferService） */
  async importFromZip(filePath: string): Promise<void> {
    if (!this.transfer) {
      throw new Error('DataService 未初始化，无法导入');
    }
    return this.transfer.importFromZip(filePath);
  }

  /** 关闭数据库连接，供 app 退出时调用 */
  async dispose(): Promise<void> {
    this.closeDatabase();
    this.transfer = null;
    this.initialized = false;
  }
}

export const dataService = DataService.getInstance();
