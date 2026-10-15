import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_DATABASE_SCHEMA_VERSION,
  CURRENT_DEFAULT_GPA_FORMULA,
  DatabaseMigrator,
  LEGACY_DEFAULT_GPA_FORMULA,
} from "../../src/main/services/DatabaseMigrator";

const databases: Database.Database[] = [];

function openDatabase(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  return db;
}

function createExpectedSchema(db: Database.Database): void {
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
  `);
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("DatabaseMigrator", () => {
  it("creates a new schema at the current version", () => {
    const db = openDatabase();
    DatabaseMigrator.ensureCurrent(db, () => createExpectedSchema(db));

    expect(db.pragma("user_version", { simple: true })).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table"),
    ).toHaveLength(7);
  });

  it("migrates the legacy default formula without touching custom formulas", () => {
    const db = openDatabase();
    createExpectedSchema(db);
    db.pragma("user_version = 1");
    db.prepare("INSERT INTO gpa_formula VALUES (?, ?, ?, ?, ?, ?)").run(
      "default",
      LEGACY_DEFAULT_GPA_FORMULA,
      1,
      "默认公式",
      "now",
      "now",
    );
    db.prepare("INSERT INTO gpa_formula VALUES (?, ?, ?, ?, ?, ?)").run(
      "custom",
      "SUM(credit * score) / SUM(credit)",
      0,
      "自定义公式",
      "now",
      "now",
    );

    DatabaseMigrator.ensureCurrent(db, () => createExpectedSchema(db));

    expect(db.pragma("user_version", { simple: true })).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    expect(
      db.prepare("SELECT formula FROM gpa_formula WHERE id = ?").get("default"),
    ).toEqual({
      formula: CURRENT_DEFAULT_GPA_FORMULA,
    });
    expect(
      db.prepare("SELECT formula FROM gpa_formula WHERE id = ?").get("custom"),
    ).toEqual({
      formula: "SUM(credit * score) / SUM(credit)",
    });
  });

  it("rejects a future schema instead of opening it as an empty database", () => {
    const db = openDatabase();
    createExpectedSchema(db);
    db.pragma("user_version = 99");

    expect(() =>
      DatabaseMigrator.ensureCurrent(db, () => createExpectedSchema(db)),
    ).toThrow(/高于当前支持的版本/);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'",
        )
        .get(),
    ).toEqual({ count: 7 });
  });

  it("handles schema zero, ordinary indexes and rejects incomplete schemas", () => {
    const db = openDatabase();
    createExpectedSchema(db);
    db.prepare("INSERT INTO gpa_formula VALUES (?, ?, ?, ?, ?, ?)").run(
      "default",
      LEGACY_DEFAULT_GPA_FORMULA,
      1,
      "默认公式",
      "now",
      "now",
    );
    db.exec("CREATE INDEX course_name_index ON courses(name)");

    DatabaseMigrator.ensureCurrent(db, () => createExpectedSchema(db));
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(
      db.prepare("SELECT formula FROM gpa_formula WHERE id = 'default'").get(),
    ).toEqual({ formula: CURRENT_DEFAULT_GPA_FORMULA });

    const missingTable = openDatabase();
    createExpectedSchema(missingTable);
    missingTable.exec("DROP TABLE labs");
    expect(() =>
      DatabaseMigrator.ensureCurrent(missingTable, () =>
        createExpectedSchema(missingTable),
      ),
    ).toThrow(/业务表不完整/);

    const incomplete = openDatabase();
    createExpectedSchema(incomplete);
    incomplete.exec("DROP TABLE schedule_items");
    incomplete.exec("CREATE TABLE schedule_items (id TEXT PRIMARY KEY)");
    expect(() =>
      DatabaseMigrator.ensureCurrent(incomplete, () =>
        createExpectedSchema(incomplete),
      ),
    ).toThrow(/缺少字段/);
  });

  it("rejects unsupported SQLite objects and invalid empty-database versions", () => {
    const withView = openDatabase();
    createExpectedSchema(withView);
    withView.exec("CREATE VIEW unsupported_view AS SELECT 1 AS value");
    expect(() =>
      DatabaseMigrator.ensureCurrent(withView, () =>
        createExpectedSchema(withView),
      ),
    ).toThrow(/不支持的 SQLite 对象/);

    const emptyFuture = openDatabase();
    emptyFuture.pragma("user_version = 3");
    expect(() =>
      DatabaseMigrator.ensureCurrent(emptyFuture, () =>
        createExpectedSchema(emptyFuture),
      ),
    ).toThrow(/空数据库的版本必须为 0/);

    const emptyInvalidSchema = openDatabase();
    expect(() =>
      DatabaseMigrator.ensureCurrent(emptyInvalidSchema, () => undefined),
    ).toThrow(/业务表不完整/);

    const withVirtualTable = openDatabase();
    createExpectedSchema(withVirtualTable);
    withVirtualTable.exec("DROP TABLE courses");
    withVirtualTable.exec(
      "CREATE VIRTUAL TABLE courses USING fts5(id, name, teacher, location)",
    );
    expect(() =>
      DatabaseMigrator.ensureCurrent(withVirtualTable, () =>
        createExpectedSchema(withVirtualTable),
      ),
    ).toThrow(/虚拟表/);

    const withForeignKeyError = openDatabase();
    createExpectedSchema(withForeignKeyError);
    withForeignKeyError.exec("DROP TABLE courses");
    withForeignKeyError.exec(`
      CREATE TABLE courses (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, teacher TEXT, location TEXT,
        start_week INTEGER NOT NULL, end_week INTEGER NOT NULL, weekday INTEGER NOT NULL,
        start_period INTEGER NOT NULL, end_period INTEGER NOT NULL, color TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        formula_id TEXT REFERENCES gpa_formula(id)
      );
    `);
    withForeignKeyError.pragma("foreign_keys = OFF");
    withForeignKeyError.exec(
      "INSERT INTO courses VALUES ('bad', '坏数据', NULL, NULL, 1, 1, 1, 1, 1, '#000000', 'now', 'now', 'missing')",
    );
    withForeignKeyError.pragma("foreign_keys = ON");
    expect(() =>
      DatabaseMigrator.ensureCurrent(withForeignKeyError, () =>
        createExpectedSchema(withForeignKeyError),
      ),
    ).toThrow(/foreign_key_check/);
  });

  it("converts failures while reading the SQLite version into a migration error", () => {
    const broken = {
      pragma: () => {
        throw new Error("sqlite unavailable");
      },
    } as unknown as Database.Database;

    expect(() =>
      DatabaseMigrator.ensureCurrent(broken, () => undefined),
    ).toThrow(/无法读取数据库版本/);

    const malformedVersion = {
      pragma: () => "not-a-version",
    } as unknown as Database.Database;
    expect(() =>
      DatabaseMigrator.ensureCurrent(malformedVersion, () => undefined),
    ).toThrow(/无法读取数据库版本/);
  });
});
