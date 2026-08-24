import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CourseRepository,
  ExamRepository,
  GpaFormulaRepository,
  GradeRepository,
  LabRepository,
  PeriodConfigRepository,
  ScheduleRepository,
} from "../../src/main/services/repositories";

const databases: Database.Database[] = [];

function openDatabase(): Database.Database {
  const db = new Database(":memory:");
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
    PRAGMA user_version = 2;
  `);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("SQLite repositories", () => {
  it("provides complete schedule CRUD and safe empty updates", () => {
    const repository = new ScheduleRepository(openDatabase());
    const created = repository.add({
      title: "日程",
      startTime: "2026-08-21T09:00:00.000Z",
      endTime: "2026-08-21T10:00:00.000Z",
      reminderOffset: 10,
      repeatRule: "weekly",
    });
    expect(repository.list()).toHaveLength(1);
    expect(repository.getById(created.id)).toMatchObject({ title: "日程" });
    expect(repository.update(created.id, {})).toMatchObject({ id: created.id });
    expect(
      repository.update(created.id, {
        title: "更新日程",
        startTime: "2026-08-21T11:00:00.000Z",
        endTime: "2026-08-21T12:00:00.000Z",
        reminderOffset: 30,
        repeatRule: "monthly",
      }),
    ).toMatchObject({
      title: "更新日程",
      reminderOffset: 30,
      repeatRule: "monthly",
    });
    expect(repository.remove(created.id)).toBe(true);
    expect(repository.remove(created.id)).toBe(false);
    expect(repository.getById(created.id)).toBeNull();
  });

  it("provides complete course CRUD including optional fields", () => {
    const repository = new CourseRepository(openDatabase());
    const created = repository.add({
      name: "课程",
      teacher: "教师",
      location: "A101",
      startWeek: 1,
      endWeek: 16,
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
      color: "#4285F4",
    });
    expect(repository.update(created.id, {})).toMatchObject({ name: "课程" });
    const updated = repository.update(created.id, {
      name: "更新课程",
      teacher: "新教师",
      location: "B202",
      startWeek: 2,
      endWeek: 15,
      weekday: 5,
      startPeriod: 3,
      endPeriod: 4,
      color: "#34A853",
    });
    expect(updated).toMatchObject({
      name: "更新课程",
      teacher: "新教师",
      location: "B202",
      startWeek: 2,
      endWeek: 15,
      weekday: 5,
      startPeriod: 3,
      endPeriod: 4,
      color: "#34A853",
    });
    expect(repository.list()).toHaveLength(1);
    expect(repository.remove(created.id)).toBe(true);

    const withoutOptionalFields = repository.add({
      name: "无教师课程",
      startWeek: 1,
      endWeek: 1,
      weekday: 7,
      startPeriod: 1,
      endPeriod: 1,
      color: "#000000",
    });
    expect(repository.getById(withoutOptionalFields.id)).toMatchObject({
      teacher: undefined,
      location: undefined,
    });
  });

  it("round-trips period configuration and replaces the full set atomically", () => {
    const repository = new PeriodConfigRepository(openDatabase());
    expect(repository.getByIndex(1)).toBeNull();
    repository.saveAll([
      {
        index: 1,
        startTime: "08:00",
        endTime: "08:45",
        breakAfter: 10,
        isLab: false,
        reminderOffset: 10,
      },
      {
        index: 2,
        startTime: "08:55",
        endTime: "09:40",
        breakAfter: 20,
        isLab: true,
        reminderOffset: 20,
      },
    ]);
    expect(repository.getAll()).toEqual([
      {
        index: 1,
        startTime: "08:00",
        endTime: "08:45",
        breakAfter: 10,
        isLab: false,
        reminderOffset: 10,
      },
      {
        index: 2,
        startTime: "08:55",
        endTime: "09:40",
        breakAfter: 20,
        isLab: true,
        reminderOffset: 20,
      },
    ]);
    expect(repository.getByIndex(2)?.isLab).toBe(true);
    repository.saveAll([
      {
        index: 3,
        startTime: "10:00",
        endTime: "10:45",
        breakAfter: 0,
        isLab: false,
        reminderOffset: 0,
      },
    ]);
    expect(repository.getAll().map((item) => item.index)).toEqual([3]);
  });

  it("serializes exam reminders and tolerates a malformed stored reminder list", () => {
    const db = openDatabase();
    const repository = new ExamRepository(db);
    const created = repository.add({
      courseName: "考试",
      date: "2026-08-24",
      startTime: "09:00",
      endTime: "11:00",
      location: "B201",
      seat: "12",
      notes: "带证件",
      reminderOffsets: [1440, 60],
    });
    expect(repository.update(created.id, {})).toMatchObject({
      courseName: "考试",
    });
    expect(
      repository.update(created.id, {
        courseName: "更新考试",
        date: "2026-08-25",
        startTime: "10:00",
        endTime: "12:00",
        location: "B202",
        seat: "13",
        notes: "更新备注",
        reminderOffsets: [30],
      }),
    ).toMatchObject({ courseName: "更新考试", reminderOffsets: [30] });
    db.prepare("UPDATE exams SET reminder_offsets = ? WHERE id = ?").run(
      "not-json",
      created.id,
    );
    expect(repository.getById(created.id)?.reminderOffsets).toEqual([]);
    expect(repository.remove(created.id)).toBe(true);

    const withoutOptionalFields = repository.add({
      courseName: "无地点考试",
      date: "2026-08-26",
      startTime: "09:00",
      endTime: "10:00",
      reminderOffsets: [],
    });
    expect(repository.getById(withoutOptionalFields.id)).toMatchObject({
      location: undefined,
      seat: undefined,
      notes: undefined,
    });
  });

  it("serializes lab reminders and maps nullable fields", () => {
    const db = openDatabase();
    const repository = new LabRepository(db);
    const created = repository.add({
      name: "实验",
      date: "2026-08-25",
      startTime: "14:00",
      endTime: "16:00",
      location: "C301",
      instructor: "老师",
      notes: "注意安全",
      reminderOffsets: [60],
    });
    expect(repository.update(created.id, {})).toMatchObject({ name: "实验" });
    expect(
      repository.update(created.id, {
        name: "更新实验",
        date: "2026-08-26",
        startTime: "15:00",
        endTime: "17:00",
        location: "C302",
        instructor: "新老师",
        notes: "新备注",
        reminderOffsets: [30, 10],
      }),
    ).toMatchObject({
      name: "更新实验",
      location: "C302",
      reminderOffsets: [30, 10],
    });
    db.prepare(
      "UPDATE labs SET location = NULL, instructor = NULL, notes = NULL, reminder_offsets = ? WHERE id = ?",
    ).run("bad", created.id);
    expect(repository.getById(created.id)).toMatchObject({
      location: undefined,
      instructor: undefined,
      notes: undefined,
      reminderOffsets: [],
    });
    expect(repository.remove(created.id)).toBe(true);

    const withoutOptionalFields = repository.add({
      name: "无地点实验",
      date: "2026-08-27",
      startTime: "09:00",
      endTime: "10:00",
      reminderOffsets: [],
    });
    expect(repository.getById(withoutOptionalFields.id)).toMatchObject({
      location: undefined,
      instructor: undefined,
      notes: undefined,
    });
  });

  it("maps grade booleans and supports every editable field", () => {
    const repository = new GradeRepository(openDatabase());
    const created = repository.add({
      courseName: "成绩课程",
      semester: "2026-2027-1",
      credit: 3,
      gradePoint: 4,
      score: 95,
      isDegreeCourse: true,
    });
    expect(repository.update(created.id, {})).toMatchObject({
      isDegreeCourse: true,
    });
    const updated = repository.update(created.id, {
      courseName: "更新成绩课程",
      semester: "2026-2027-2",
      credit: 4,
      gradePoint: 3.5,
      score: 88,
      isDegreeCourse: false,
    });
    expect(updated).toMatchObject({
      courseName: "更新成绩课程",
      semester: "2026-2027-2",
      credit: 4,
      gradePoint: 3.5,
      score: 88,
      isDegreeCourse: false,
    });
    expect(
      repository.update(created.id, { isDegreeCourse: true }),
    ).toMatchObject({
      isDegreeCourse: true,
    });
    expect(repository.remove(created.id)).toBe(true);

    const withoutScore = repository.add({
      courseName: "等级制成绩",
      semester: "2026-2027-1",
      credit: 1,
      gradePoint: 3,
      isDegreeCourse: false,
    });
    expect(repository.getById(withoutScore.id)?.score).toBeUndefined();
  });

  it("pages grades and computes a compact dashboard", () => {
    const db = openDatabase();
    const repository = new GradeRepository(db);
    const formula = new GpaFormulaRepository(db).save({
      id: "default",
      name: "默认公式",
      formula: "SUM(credit * gradePoint) / SUM(credit)",
      isDefault: true,
    });
    for (let index = 0; index < 5; index += 1) {
      repository.add({
        courseName: `课程${index}`,
        semester: index < 3 ? "2026-2027-1" : "2025-2026-2",
        credit: 2,
        gradePoint: index + 1,
        score: 70 + index,
        isDegreeCourse: index % 2 === 0,
      });
    }

    const firstPage = repository.listPage({
      semester: "2026-2027-1",
      page: 1,
      pageSize: 2,
    });
    expect(firstPage).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(firstPage.items).toHaveLength(2);
    expect(
      repository.listPage({ degreeOnly: true, page: 1, pageSize: 100 }).total,
    ).toBe(3);

    const dashboard = repository.getDashboard(formula);
    expect(dashboard).toMatchObject({
      totalCount: 5,
      degreeCount: 3,
      latestSemester: "2026-2027-1",
      semesterGpa: 2,
      overallGpa: 3,
      degreeGpa: 3,
      totalCredit: 10,
    });
    expect(dashboard.semesters).toEqual([
      { semester: "2026-2027-1", count: 3 },
      { semester: "2025-2026-2", count: 2 },
    ]);
  });

  it("covers empty, custom-formula and unfiltered dashboard paths", () => {
    const db = openDatabase();
    const repository = new GradeRepository(db);
    const defaultFormula = {
      id: "default",
      name: "默认公式",
      formula: "SUM(credit * gradePoint) / SUM(credit)",
      isDefault: true,
      createdAt: "",
      updatedAt: "",
    };
    const customFormula = {
      id: "custom",
      name: "百分制公式",
      formula: "SUM(score * credit) / SUM(credit)",
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    };

    expect(repository.getDashboard(defaultFormula)).toMatchObject({
      totalCount: 0,
      latestSemester: null,
      semesterGpa: 0,
      overallGpa: 0,
      degreeGpa: 0,
      totalCredit: 0,
    });
    expect(repository.getDashboard(customFormula)).toMatchObject({
      totalCount: 0,
      latestSemester: null,
      semesterGpa: 0,
      overallGpa: 0,
      degreeGpa: 0,
    });
    expect(repository.listPage({ page: 1, pageSize: 20 })).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 0,
    });

    for (const [index, semester] of [
      "invalid-semester",
      "2026-2027-1",
      "2026-2027-2",
      "2026-2028-1",
    ].entries()) {
      repository.add({
        courseName: `自定义公式课程${index}`,
        semester,
        credit: 2,
        gradePoint: 3,
        score: 80 + index,
        isDegreeCourse: index === 0,
      });
    }

    const dashboard = repository.getDashboard(customFormula);
    expect(dashboard).toMatchObject({
      totalCount: 4,
      degreeCount: 1,
      latestSemester: "2026-2028-1",
      semesterGpa: 83,
      overallGpa: 81.5,
      degreeGpa: 80,
      totalCredit: 8,
    });
    expect(dashboard.semesters.map((item) => item.semester)).toEqual([
      "2026-2028-1",
      "2026-2027-2",
      "2026-2027-1",
      "invalid-semester",
    ]);
  });

  it("keeps one default formula and creates formulas without an id", () => {
    const repository = new GpaFormulaRepository(openDatabase());
    const defaultFormula = repository.save({
      id: "default",
      name: "默认公式",
      formula: "SUM(credit * gradePoint) / SUM(credit)",
      isDefault: true,
    });
    expect(defaultFormula).toMatchObject({ id: "default", isDefault: true });
    const customFormula = repository.save({
      name: "百分制公式",
      formula: "SUM(score * credit) / SUM(credit)",
      isDefault: false,
    });
    expect(customFormula).toMatchObject({
      name: "百分制公式",
      isDefault: false,
    });
    expect(
      repository.save({
        id: customFormula.id,
        name: "百分制公式（修订）",
        formula: "SUM(score * credit) / SUM(credit)",
        isDefault: false,
      }),
    ).toMatchObject({ id: customFormula.id, isDefault: false });
    const explicitNewFormula = repository.save({
      id: "explicit-new",
      name: "显式新公式",
      formula: "SUM(score) / SUM(credit)",
      isDefault: false,
    });
    expect(explicitNewFormula).toMatchObject({
      id: "explicit-new",
      name: "显式新公式",
    });
    const replacement = repository.save({
      id: "default",
      name: "新版默认公式",
      formula: "SUM(credit * gradePoint) / SUM(credit)",
      isDefault: true,
    });
    expect(replacement).toMatchObject({ id: "default", name: "新版默认公式" });
    expect(repository.list().filter((item) => item.isDefault)).toHaveLength(1);
  });

  it("falls back to the latest formula only after a transient post-save lookup miss", () => {
    const repository = new GpaFormulaRepository(openDatabase());
    const lookup = vi.spyOn(repository, "getById");
    lookup.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);

    expect(
      repository.save({
        id: "resilient-formula",
        name: "回退公式",
        formula: "SUM(score) / SUM(credit)",
        isDefault: false,
      }),
    ).toMatchObject({ id: "resilient-formula", name: "回退公式" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
