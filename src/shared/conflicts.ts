// 撞课检测：课程 vs 课程、课程 vs 考试/实验/日程 的时间重叠判定（纯函数）。
// 课程是"周次 + 星期 + 节次"模型，需经 semesterStart（周一对齐）与节次表换算成
// 具体日期时间后才能与考试/实验/日程比较；周一对齐与本地午夜解析保持和
// TimetableService.computeCurrentWeek 一致，避免 UTC 偏移导致整周错位。
import type { Course, Exam, Lab, PeriodConfig, Schedule } from "./types";

export type ConflictKind = "course" | "exam" | "lab" | "schedule";

export interface ConflictRef {
  kind: ConflictKind;
  id: string;
  /** 冲突对象名称（课程名/考试课程名/实验名/日程标题） */
  label: string;
  /** 冲突语境，如 "第 3–8 周" 或 "2026-10-20 08:00–10:00" */
  detail: string;
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface CrossBoardConflicts {
  courses: Map<string, ConflictRef[]>;
  exams: Map<string, ConflictRef[]>;
  labs: Map<string, ConflictRef[]>;
  schedules: Map<string, ConflictRef[]>;
}

export interface CrossBoardInput {
  courses: Course[];
  semesterStart: string | null;
  periods: PeriodConfig[];
  exams: Exam[];
  labs: Lab[];
  schedules: Schedule[];
  /** 仅收窄课程侧结果到该周发生的冲突；考试/实验/日程侧始终全量 */
  week?: number;
}

/** 防止异常周次数据导致展开爆炸的上限 */
const MAX_EXPAND_WEEKS = 53;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatRange(start: Date, end: Date): string {
  const day = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
  return `${day} ${pad2(start.getHours())}:${pad2(start.getMinutes())}–${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
}

function pushRef(
  map: Map<string, ConflictRef[]>,
  key: string,
  ref: ConflictRef,
): void {
  const list = map.get(key);
  if (list) list.push(ref);
  else map.set(key, [ref]);
}

function pushRefUnique(
  map: Map<string, ConflictRef[]>,
  key: string,
  ref: ConflictRef,
): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [ref]);
    return;
  }
  if (!list.some((r) => r.id === ref.id && r.detail === ref.detail)) {
    list.push(ref);
  }
}

/** 学期开始日期 → 所在周周一（本地午夜）；未设置或非法返回 null。 */
export function semesterMonday(semesterStart: string | null): Date | null {
  if (!semesterStart) return null;
  const start = new Date(`${semesterStart}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const weekday = start.getDay() === 0 ? 7 : start.getDay();
  const monday = new Date(start);
  monday.setDate(start.getDate() - (weekday - 1));
  return monday;
}

function parseDayTime(day: Date, hhmm: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const out = new Date(day);
  out.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return out;
}

/** 课程在指定周的具体时间范围；该周不生效或节次缺失返回 null。 */
export function courseRangeAtWeek(
  course: Course,
  week: number,
  monday: Date,
  periods: PeriodConfig[],
): TimeRange | null {
  if (week < course.startWeek || week > course.endWeek) return null;
  const startCfg = periods.find((p) => p.index === course.startPeriod);
  const endCfg = periods.find((p) => p.index === course.endPeriod);
  if (!startCfg || !endCfg) return null;
  const day = new Date(monday);
  day.setDate(monday.getDate() + (week - 1) * 7 + (course.weekday - 1));
  const start = parseDayTime(day, startCfg.startTime);
  const end = parseDayTime(day, endCfg.endTime);
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { start, end };
}

export interface CourseSlot {
  weekday: number;
  startWeek: number;
  endWeek: number;
  startPeriod: number;
  endPeriod: number;
}

/** 撞课三元判定：同星期 + 周次范围交集 + 节次范围交集。 */
export function coursePairConflict(a: CourseSlot, b: CourseSlot): boolean {
  return (
    a.weekday === b.weekday &&
    a.startWeek <= b.endWeek &&
    b.startWeek <= a.endWeek &&
    a.startPeriod <= b.endPeriod &&
    b.startPeriod <= a.endPeriod
  );
}

/** 手动保存/导入写入时的撞课检查：返回与候选课程冲突的已有课程（不限当前周）。 */
export function findConflictingCourses(
  candidate: CourseSlot,
  existing: Course[],
): Course[] {
  return existing.filter((c) => coursePairConflict(candidate, c));
}

/** 当前周视图下的课程互撞：仅统计在当前周生效的课程。 */
export function findCourseCourseConflicts(
  courses: Course[],
  week: number,
): Map<string, ConflictRef[]> {
  const map = new Map<string, ConflictRef[]>();
  const active = courses.filter(
    (c) => c.startWeek <= week && week <= c.endWeek,
  );
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (!coursePairConflict(a, b)) continue;
      const lo = Math.max(a.startWeek, b.startWeek);
      const hi = Math.min(a.endWeek, b.endWeek);
      const detail = lo === hi ? `第 ${lo} 周` : `第 ${lo}–${hi} 周`;
      pushRef(map, a.id, { kind: "course", id: b.id, label: b.name, detail });
      pushRef(map, b.id, { kind: "course", id: a.id, label: a.name, detail });
    }
  }
  return map;
}

function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** "YYYY-MM-DD" + "HH:mm" 起止 → 本地时间范围；非法或倒置返回 null。 */
function dateTimeRange(
  date: string,
  startTime: string,
  endTime: string,
): TimeRange | null {
  const day = new Date(`${date}T00:00:00`);
  if (Number.isNaN(day.getTime())) return null;
  const start = parseDayTime(day, startTime);
  const end = parseDayTime(day, endTime);
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { start, end };
}

interface CourseOccurrence {
  course: Course;
  week: number;
  range: TimeRange;
  /** 当天零点毫秒与起止分钟，供高频重叠检查走纯数字比较 */
  dayMs: number;
  startMin: number;
  endMin: number;
}

function startOfDayMs(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function collectCourseOccurrences(
  courses: Course[],
  monday: Date,
  periods: PeriodConfig[],
): CourseOccurrence[] {
  const out: CourseOccurrence[] = [];
  for (const course of courses) {
    const lastWeek = Math.min(
      course.endWeek,
      course.startWeek + MAX_EXPAND_WEEKS - 1,
    );
    for (let week = course.startWeek; week <= lastWeek; week++) {
      const range = courseRangeAtWeek(course, week, monday, periods);
      if (range) {
        out.push({
          course,
          week,
          range,
          dayMs: startOfDayMs(range.start),
          startMin: minutesOfDay(range.start),
          endMin: minutesOfDay(range.end),
        });
      }
    }
  }
  return out;
}

/** 预编译日程：ISO 解析只做一次，逐课程发生次的匹配退化为数字比较。 */
interface CompiledSchedule {
  schedule: Schedule;
  firstDayMs: number;
  startMin: number;
  durationMin: number;
  weekday: number;
  dayOfMonth: number;
  rule: Schedule["repeatRule"];
}

function compileSchedule(schedule: Schedule): CompiledSchedule | null {
  const first = new Date(schedule.startTime);
  const last = new Date(schedule.endTime);
  if (
    Number.isNaN(first.getTime()) ||
    Number.isNaN(last.getTime()) ||
    last.getTime() <= first.getTime()
  ) {
    return null;
  }
  return {
    schedule,
    firstDayMs: startOfDayMs(first),
    startMin: minutesOfDay(first),
    durationMin: (last.getTime() - first.getTime()) / 60000,
    weekday: first.getDay(),
    dayOfMonth: first.getDate(),
    rule: schedule.repeatRule,
  };
}

/** 日程在课程发生次当天是否发生且时间重叠；重叠时返回日程当次时间范围。 */
function scheduleOverlaps(
  compiled: CompiledSchedule,
  occ: CourseOccurrence,
): TimeRange | null {
  if (occ.dayMs < compiled.firstDayMs) return null;
  const occurs =
    compiled.rule === "none"
      ? occ.dayMs === compiled.firstDayMs
      : compiled.rule === "daily"
        ? true
        : compiled.rule === "weekly"
          ? occ.range.start.getDay() === compiled.weekday
          : compiled.rule === "monthly"
            ? occ.range.start.getDate() === compiled.dayOfMonth
            : false;
  if (!occurs) return null;
  // 已知边界：跨午夜日程（如 23:00–次日 01:00）按当天分钟区间比较，
  // 次日 00:00–01:00 段的课程发生次不会命中；场景罕见，暂不拆分次日区间
  if (
    !(
      compiled.startMin < occ.endMin &&
      occ.startMin < compiled.startMin + compiled.durationMin
    )
  ) {
    return null;
  }
  const start = new Date(occ.range.start);
  start.setHours(
    Math.floor(compiled.startMin / 60),
    compiled.startMin % 60,
    0,
    0,
  );
  return {
    start,
    end: new Date(start.getTime() + compiled.durationMin * 60000),
  };
}

function itemMap(
  result: CrossBoardConflicts,
  kind: Exclude<ConflictKind, "course">,
): Map<string, ConflictRef[]> {
  if (kind === "exam") return result.exams;
  if (kind === "lab") return result.labs;
  return result.schedules;
}

function recordMatch(
  occ: CourseOccurrence,
  range: TimeRange,
  kind: Exclude<ConflictKind, "course">,
  id: string,
  label: string,
  weekFilter: number | undefined,
  result: CrossBoardConflicts,
): void {
  if (weekFilter === undefined || occ.week === weekFilter) {
    pushRef(result.courses, occ.course.id, {
      kind,
      id,
      label,
      detail: formatRange(range.start, range.end),
    });
  }
  pushRefUnique(itemMap(result, kind), id, {
    kind: "course",
    id: occ.course.id,
    label: occ.course.name,
    detail: `第 ${occ.week} 周`,
  });
}

function matchItem(
  occurrences: CourseOccurrence[],
  range: TimeRange,
  kind: Exclude<ConflictKind, "course">,
  id: string,
  label: string,
  weekFilter: number | undefined,
  result: CrossBoardConflicts,
): void {
  for (const occ of occurrences) {
    if (rangesOverlap(occ.range, range)) {
      recordMatch(occ, range, kind, id, label, weekFilter, result);
    }
  }
}

/**
 * 跨板块撞课：课程（全部生效周展开）vs 考试/实验/日程。
 * semesterStart 未设置时返回全空映射（调用方据此降级为仅课程互撞检测）。
 */
export function findCrossBoardConflicts(
  input: CrossBoardInput,
): CrossBoardConflicts {
  const result: CrossBoardConflicts = {
    courses: new Map(),
    exams: new Map(),
    labs: new Map(),
    schedules: new Map(),
  };
  const monday = semesterMonday(input.semesterStart);
  if (!monday) return result;
  const occurrences = collectCourseOccurrences(
    input.courses,
    monday,
    input.periods,
  );
  for (const exam of input.exams) {
    const range = dateTimeRange(exam.date, exam.startTime, exam.endTime);
    if (range) {
      matchItem(occurrences, range, "exam", exam.id, exam.courseName, input.week, result);
    }
  }
  for (const lab of input.labs) {
    const range = dateTimeRange(lab.date, lab.startTime, lab.endTime);
    if (range) {
      matchItem(occurrences, range, "lab", lab.id, lab.name, input.week, result);
    }
  }
  for (const schedule of input.schedules) {
    const compiled = compileSchedule(schedule);
    if (!compiled) continue;
    for (const occ of occurrences) {
      const range = scheduleOverlaps(compiled, occ);
      if (range) {
        recordMatch(occ, range, "schedule", schedule.id, schedule.title, input.week, result);
      }
    }
  }
  return result;
}
