// shared/conflicts.ts 单元测试：撞课三元判定、周一对齐换算、跨板块重叠与降级。
import { describe, expect, it } from "vitest";
import {
  coursePairConflict,
  courseRangeAtWeek,
  findConflictingCourses,
  findCourseCourseConflicts,
  findCrossBoardConflicts,
  semesterMonday,
} from "../../src/shared/conflicts";
import type {
  Course,
  Exam,
  Lab,
  PeriodConfig,
  Schedule,
} from "../../src/shared/types";

const PERIODS: PeriodConfig[] = [
  {
    index: 1,
    startTime: "08:00",
    endTime: "08:45",
    breakAfter: 10,
    isLab: false,
    reminderOffset: 15,
  },
  {
    index: 2,
    startTime: "08:55",
    endTime: "09:40",
    breakAfter: 20,
    isLab: false,
    reminderOffset: 15,
  },
  {
    index: 3,
    startTime: "10:00",
    endTime: "10:45",
    breakAfter: 10,
    isLab: false,
    reminderOffset: 15,
  },
  {
    index: 4,
    startTime: "10:55",
    endTime: "11:40",
    breakAfter: 0,
    isLab: false,
    reminderOffset: 15,
  },
];

// 2026-09-02 是周三，其所在周周一为 2026-08-31
const SEMESTER_START = "2026-09-02";

let seq = 0;
function course(partial: Partial<Course> = {}): Course {
  seq += 1;
  return {
    id: `c${seq}`,
    name: `课程${seq}`,
    startWeek: 1,
    endWeek: 16,
    weekday: 1,
    startPeriod: 1,
    endPeriod: 2,
    color: "#4285F4",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function exam(partial: Partial<Exam> = {}): Exam {
  seq += 1;
  return {
    id: `e${seq}`,
    courseName: `考试${seq}`,
    date: "2026-09-07",
    startTime: "08:30",
    endTime: "10:00",
    reminderOffsets: [30],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function lab(partial: Partial<Lab> = {}): Lab {
  seq += 1;
  return {
    id: `l${seq}`,
    name: `实验${seq}`,
    date: "2026-09-07",
    startTime: "08:30",
    endTime: "10:00",
    reminderOffsets: [30],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function schedule(partial: Partial<Schedule> = {}): Schedule {
  seq += 1;
  return {
    id: `s${seq}`,
    title: `日程${seq}`,
    startTime: "2026-09-07T08:00:00",
    endTime: "2026-09-07T09:00:00",
    reminderOffset: 15,
    repeatRule: "none",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("semesterMonday", () => {
  it("周三起始对齐到本周周一", () => {
    const monday = semesterMonday("2026-09-02");
    expect(monday?.getFullYear()).toBe(2026);
    expect(monday?.getMonth()).toBe(7); // 8 月
    expect(monday?.getDate()).toBe(31);
  });

  it("周一起始保持不变，周日起始回退到上周一", () => {
    expect(semesterMonday("2026-09-07")?.getDate()).toBe(7);
    expect(semesterMonday("2026-09-06")?.getDate()).toBe(31);
  });

  it("未设置或非法日期返回 null", () => {
    expect(semesterMonday(null)).toBeNull();
    expect(semesterMonday("not-a-date")).toBeNull();
  });
});

describe("coursePairConflict", () => {
  const base = {
    weekday: 1,
    startWeek: 1,
    endWeek: 16,
    startPeriod: 1,
    endPeriod: 2,
  };

  it("节次相邻不算撞课，节次相交才算", () => {
    expect(
      coursePairConflict(base, { ...base, startPeriod: 3, endPeriod: 4 }),
    ).toBe(false);
    expect(
      coursePairConflict(base, { ...base, startPeriod: 2, endPeriod: 4 }),
    ).toBe(true);
  });

  it("周次不相交不算撞课", () => {
    expect(
      coursePairConflict(base, { ...base, startWeek: 9, endWeek: 16 }),
    ).toBe(true);
    expect(
      coursePairConflict(base, { ...base, startWeek: 17, endWeek: 20 }),
    ).toBe(false);
  });

  it("不同星期不算撞课", () => {
    expect(coursePairConflict(base, { ...base, weekday: 2 })).toBe(false);
  });
});

describe("findConflictingCourses", () => {
  it("只返回与候选课程撞课的已有课程", () => {
    const hit = course({ name: "撞上的课" });
    const miss = course({ weekday: 2 });
    const result = findConflictingCourses(
      { weekday: 1, startWeek: 1, endWeek: 16, startPeriod: 1, endPeriod: 2 },
      [hit, miss],
    );
    expect(result.map((c) => c.name)).toEqual(["撞上的课"]);
  });
});

describe("findCourseCourseConflicts", () => {
  it("当前周生效且撞课时双方都有记录，detail 为周次交集", () => {
    const a = course({ name: "A" });
    const b = course({ name: "B", startPeriod: 2, endPeriod: 3, endWeek: 8 });
    const map = findCourseCourseConflicts([a, b], 3);
    expect(map.get(a.id)?.[0]).toMatchObject({
      label: "B",
      detail: "第 1–8 周",
    });
    expect(map.get(b.id)?.[0]).toMatchObject({
      label: "A",
      detail: "第 1–8 周",
    });
  });

  it("单周交集时 detail 为单周形式", () => {
    const a = course({ name: "A", startWeek: 5, endWeek: 5 });
    const b = course({ name: "B", startPeriod: 2, endPeriod: 3 });
    const map = findCourseCourseConflicts([a, b], 5);
    expect(map.get(a.id)?.[0].detail).toBe("第 5 周");
  });

  it("切换到一方不生效的周则无记录", () => {
    const a = course();
    const b = course({ startPeriod: 2, endPeriod: 3, endWeek: 8 });
    expect(findCourseCourseConflicts([a, b], 10).size).toBe(0);
  });

  it("周次不相交时无记录", () => {
    const a = course({ startWeek: 5, endWeek: 8 });
    const b = course({
      startWeek: 1,
      endWeek: 3,
      startPeriod: 2,
      endPeriod: 3,
    });
    expect(findCourseCourseConflicts([a, b], 3).size).toBe(0);
  });
});

describe("courseRangeAtWeek", () => {
  const monday = semesterMonday(SEMESTER_START);

  it("换算为周一对齐后的具体时间范围", () => {
    const c = course({ weekday: 3, startPeriod: 1, endPeriod: 2 });
    const range = courseRangeAtWeek(c, 1, monday!, PERIODS);
    expect(range?.start.getFullYear()).toBe(2026);
    expect(range?.start.getMonth()).toBe(8); // 9 月
    expect(range?.start.getDate()).toBe(2);
    expect(range?.start.getHours()).toBe(8);
    expect(range?.end.getHours()).toBe(9);
    expect(range?.end.getMinutes()).toBe(40);
  });

  it("该周不生效或节次缺失返回 null", () => {
    const c = course({ startWeek: 1, endWeek: 16 });
    expect(courseRangeAtWeek(c, 20, monday!, PERIODS)).toBeNull();
    expect(
      courseRangeAtWeek({ ...c, startPeriod: 99 }, 1, monday!, PERIODS),
    ).toBeNull();
  });
});

describe("findCrossBoardConflicts", () => {
  const mondayCourse = () =>
    course({
      name: "早课",
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
      startWeek: 1,
      endWeek: 16,
    });

  it("semesterStart 未设置时全部为空（降级）", () => {
    const result = findCrossBoardConflicts({
      courses: [mondayCourse()],
      semesterStart: null,
      periods: PERIODS,
      exams: [exam()],
      labs: [lab()],
      schedules: [schedule()],
    });
    expect(result.courses.size).toBe(0);
    expect(result.exams.size).toBe(0);
    expect(result.labs.size).toBe(0);
    expect(result.schedules.size).toBe(0);
  });

  it("考试与课程时间重叠时双侧都有记录", () => {
    const c = mondayCourse();
    const e = exam({ courseName: "高数期末" }); // 2026-09-07 周一 08:30-10:00，第 2 周
    const result = findCrossBoardConflicts({
      courses: [c],
      semesterStart: SEMESTER_START,
      periods: PERIODS,
      exams: [e],
      labs: [],
      schedules: [],
    });
    expect(result.courses.get(c.id)?.[0]).toMatchObject({
      kind: "exam",
      label: "高数期末",
      detail: "2026-09-07 08:30–10:00",
    });
    expect(result.exams.get(e.id)?.[0]).toMatchObject({
      kind: "course",
      label: "早课",
      detail: "第 2 周",
    });
  });

  it("时间不重叠或非同学星期无记录", () => {
    const c = mondayCourse();
    const noon = exam({ startTime: "12:00", endTime: "13:00" });
    const sunday = exam({
      date: "2026-09-06",
      startTime: "08:30",
      endTime: "10:00",
    });
    const result = findCrossBoardConflicts({
      courses: [c],
      semesterStart: SEMESTER_START,
      periods: PERIODS,
      exams: [noon, sunday],
      labs: [],
      schedules: [],
    });
    expect(result.courses.size).toBe(0);
    expect(result.exams.size).toBe(0);
  });

  it("非法考试日期被跳过且不抛异常", () => {
    expect(() =>
      findCrossBoardConflicts({
        courses: [mondayCourse()],
        semesterStart: SEMESTER_START,
        periods: PERIODS,
        exams: [exam({ date: "2026-13-40" })],
        labs: [],
        schedules: [],
      }),
    ).not.toThrow();
  });

  it("实验与课程重叠时双侧有记录", () => {
    const c = mondayCourse();
    const l = lab({ name: "物理实验" });
    const result = findCrossBoardConflicts({
      courses: [c],
      semesterStart: SEMESTER_START,
      periods: PERIODS,
      exams: [],
      labs: [l],
      schedules: [],
    });
    expect(result.courses.get(c.id)?.[0].label).toBe("物理实验");
    expect(result.labs.get(l.id)?.[0].label).toBe("早课");
  });

  it("none 日程只撞一次，daily 日程每周都撞", () => {
    const c = mondayCourse();
    const once = schedule({ title: "一次会" });
    const daily = schedule({ title: "每天晨读", repeatRule: "daily" });
    const result = findCrossBoardConflicts({
      courses: [c],
      semesterStart: SEMESTER_START,
      periods: PERIODS,
      exams: [],
      labs: [],
      schedules: [once, daily],
    });
    expect(result.schedules.get(once.id)).toHaveLength(1);
    expect(result.schedules.get(daily.id)).toHaveLength(15); // 第 2–16 周，第 1 周早于首次发生
  });

  it("monthly 日程只在与课程同日的月份撞", () => {
    const c = mondayCourse();
    const monthly = schedule({
      title: "月末例会",
      startTime: "2026-08-31T08:00:00",
      endTime: "2026-08-31T09:00:00",
      repeatRule: "monthly",
    });
    const result = findCrossBoardConflicts({
      courses: [c],
      semesterStart: SEMESTER_START,
      periods: PERIODS,
      exams: [],
      labs: [],
      schedules: [monthly],
    });
    // 之后月份 31 日均非周一，只有第 1 周撞一次
    expect(result.schedules.get(monthly.id)).toHaveLength(1);
    expect(result.schedules.get(monthly.id)?.[0].detail).toBe("第 1 周");
  });

  it("week 过滤只收窄课程侧结果，事项侧不受影响", () => {
    const c = mondayCourse();
    const e = exam(); // 第 2 周冲突
    const result = findCrossBoardConflicts({
      courses: [c],
      semesterStart: SEMESTER_START,
      periods: PERIODS,
      exams: [e],
      labs: [],
      schedules: [],
      week: 1,
    });
    expect(result.courses.size).toBe(0);
    expect(result.exams.get(e.id)).toHaveLength(1);
  });

  it("空课程列表不抛异常", () => {
    expect(() =>
      findCrossBoardConflicts({
        courses: [],
        semesterStart: SEMESTER_START,
        periods: PERIODS,
        exams: [exam()],
        labs: [lab()],
        schedules: [schedule()],
      }),
    ).not.toThrow();
  });

  it("200 课程 × 1000 条 daily 日程规模下可完成", () => {
    const courses = Array.from({ length: 200 }, (_, i) =>
      course({
        weekday: ((i % 7) + 1) as Course["weekday"],
        startPeriod: (i % 4) + 1,
        endPeriod: (i % 4) + 1,
        startWeek: 1,
        endWeek: 16,
      }),
    );
    const schedules = Array.from({ length: 1000 }, (_, i) =>
      schedule({
        startTime: `2026-08-31T${String(6 + (i % 12)).padStart(2, "0")}:00:00`,
        endTime: `2026-08-31T${String(7 + (i % 12)).padStart(2, "0")}:00:00`,
        repeatRule: "daily",
      }),
    );
    const start = Date.now();
    const result = findCrossBoardConflicts({
      courses,
      semesterStart: SEMESTER_START,
      periods: PERIODS,
      exams: [],
      labs: [],
      schedules,
    });
    expect(Date.now() - start).toBeLessThan(15000);
    expect(result.schedules.size).toBeGreaterThan(0);
  });
});
