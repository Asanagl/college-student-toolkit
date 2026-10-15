// 数据库版本控制与完整性检查。
// 迁移逻辑独立于 Electron，便于使用临时 SQLite 数据库做回归测试。
import type Database from 'better-sqlite3';

export const LEGACY_DATABASE_SCHEMA_VERSION = 1;
export const CURRENT_DATABASE_SCHEMA_VERSION = 2;
export const LEGACY_DEFAULT_GPA_FORMULA = 'SUM(credit * grade_point) / SUM(credit)';
export const CURRENT_DEFAULT_GPA_FORMULA = 'SUM(credit * gradePoint) / SUM(credit)';

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schedule_items: [
    'id', 'title', 'start_time', 'end_time', 'reminder_offset', 'repeat_rule',
    'created_at', 'updated_at',
  ],
  courses: [
    'id', 'name', 'teacher', 'location', 'start_week', 'end_week', 'weekday',
    'start_period', 'end_period', 'color', 'created_at', 'updated_at',
  ],
  period_config: [
    'period_index', 'start_time', 'end_time', 'break_after', 'is_lab',
    'reminder_offset',
  ],
  exams: [
    'id', 'course_name', 'date', 'start_time', 'end_time', 'location', 'seat',
    'notes', 'reminder_offsets', 'created_at', 'updated_at',
  ],
  labs: [
    'id', 'name', 'date', 'start_time', 'end_time', 'location', 'instructor',
    'notes', 'reminder_offsets', 'created_at', 'updated_at',
  ],
  grades: [
    'id', 'course_name', 'semester', 'credit', 'grade_point', 'score',
    'is_degree_course', 'created_at', 'updated_at',
  ],
  gpa_formula: ['id', 'formula', 'is_default', 'name', 'created_at', 'updated_at'],
};

const EXPECTED_TABLES = new Set(Object.keys(REQUIRED_COLUMNS));

export class DatabaseMigrationError extends Error {
  readonly code = 'DATABASE_MIGRATION_FAILED';
  readonly causeValue?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.causeValue = options?.cause;
    this.name = 'DatabaseMigrationError';
  }
}

export class DatabaseInitializationError extends Error {
  readonly code = 'DATABASE_INITIALIZATION_FAILED';
  readonly causeValue?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.causeValue = options?.cause;
    this.name = 'DatabaseInitializationError';
  }
}

interface SqliteObject {
  type: string;
  name: string;
  sql: string | null;
}

/** 将旧版数据库升级到当前版本；新库由 createSchema 回调创建。 */
export class DatabaseMigrator {
  static ensureCurrent(
    db: Database.Database,
    createSchema: () => void,
  ): void {
    const version = this.readVersion(db);
    const objects = this.listObjects(db);
    const tables = objects.filter((item) => item.type === 'table');

    if (tables.length === 0) {
      this.createFreshDatabase(db, version, createSchema);
      return;
    }
    this.assertSupportedObjects(objects);
    this.assertKnownTables(tables);
    this.assertIntegrity(db);
    this.assertSupportedVersion(version);
    this.assertSchemaColumns(db);

    if (version < CURRENT_DATABASE_SCHEMA_VERSION) {
      this.migrateLegacySchema(db, version);
    }
  }

  /** 读取 PRAGMA user_version，并把异常转换为可识别的迁移错误。 */
  private static readVersion(db: Database.Database): number {
    try {
      const value = db.pragma('user_version', { simple: true });
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('PRAGMA user_version 不是非负整数');
      }
      return value;
    } catch (error) {
      throw new DatabaseMigrationError('无法读取数据库版本', { cause: error });
    }
  }

  private static listObjects(db: Database.Database): SqliteObject[] {
    const rows = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master " +
          "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as SqliteObject[];
    return rows;
  }

  /** 只允许业务表和普通索引，拒绝视图、触发器与虚拟表。 */
  private static assertSupportedObjects(objects: SqliteObject[]): void {
    for (const item of objects) {
      if (item.type === 'index') continue;
      if (item.type !== 'table' || !EXPECTED_TABLES.has(item.name)) {
        throw new DatabaseMigrationError(`数据库包含不支持的 SQLite 对象: ${item.name}`);
      }
      if (item.sql?.toUpperCase().includes('CREATE VIRTUAL TABLE')) {
        throw new DatabaseMigrationError(`数据库包含虚拟表: ${item.name}`);
      }
    }
  }

  private static assertKnownTables(tables: SqliteObject[]): void {
    const actual = new Set(tables.map((item) => item.name));
    if (actual.size !== EXPECTED_TABLES.size) {
      throw new DatabaseMigrationError('数据库业务表不完整，已拒绝继续启动');
    }
    for (const table of EXPECTED_TABLES) {
      if (!actual.has(table)) {
        throw new DatabaseMigrationError(`数据库缺少业务表: ${table}`);
      }
    }
  }

  /** 校验 SQLite 页与外键；损坏时不允许通过创建空库掩盖问题。 */
  private static assertIntegrity(db: Database.Database): void {
    const rows = db.pragma('integrity_check') as Array<{ integrity_check?: string }>;
    const result = rows[0]?.integrity_check;
    if (result !== 'ok') {
      throw new DatabaseMigrationError(`SQLite integrity_check 失败: ${result ?? '未知错误'}`);
    }
    const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyErrors.length > 0) {
      throw new DatabaseMigrationError('SQLite foreign_key_check 失败');
    }
  }

  private static assertSupportedVersion(version: number): void {
    if (version > CURRENT_DATABASE_SCHEMA_VERSION) {
      throw new DatabaseMigrationError(
        `数据库版本 ${version} 高于当前支持的版本 ${CURRENT_DATABASE_SCHEMA_VERSION}`,
      );
    }
  }

  private static assertSchemaColumns(db: Database.Database): void {
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const rows = db.pragma(`table_info("${table}")`) as Array<{ name?: string }>;
      const actual = new Set(rows.map((row) => row.name));
      for (const column of required) {
        if (!actual.has(column)) {
          throw new DatabaseMigrationError(`表 ${table} 缺少字段: ${column}`);
        }
      }
    }
  }

  private static createFreshDatabase(
    db: Database.Database,
    version: number,
    createSchema: () => void,
  ): void {
    if (version !== 0) {
      throw new DatabaseMigrationError(`空数据库的版本必须为 0，实际为 ${version}`);
    }
    createSchema();
    this.assertSupportedObjects(this.listObjects(db));
    this.assertKnownTables(this.listObjects(db).filter((item) => item.type === 'table'));
    this.assertSchemaColumns(db);
    db.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION}`);
  }

  /** 在事务内修复精确的旧默认公式，并最后写入新版本号。 */
  private static migrateLegacySchema(db: Database.Database, version: number): void {
    if (version !== 0 && version !== LEGACY_DATABASE_SCHEMA_VERSION) {
      throw new DatabaseMigrationError(`不支持从数据库版本 ${version} 迁移`);
    }
    const migrate = db.transaction(() => {
      db.prepare(
        `UPDATE gpa_formula SET formula = ?
         WHERE id = 'default' AND formula = ?`,
      ).run(CURRENT_DEFAULT_GPA_FORMULA, LEGACY_DEFAULT_GPA_FORMULA);
      db.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION}`);
    });
    try {
      migrate();
    } catch (error) {
      throw new DatabaseMigrationError('数据库迁移事务失败，原数据已回滚', { cause: error });
    }
    if (this.readVersion(db) !== CURRENT_DATABASE_SCHEMA_VERSION) {
      throw new DatabaseMigrationError('数据库迁移完成但版本号未写入');
    }
  }
}
