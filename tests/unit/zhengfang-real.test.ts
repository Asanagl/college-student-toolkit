// 正方 4.0 真实课表样本回归：rowspan 网格定位、字段分行解析、单双周合并、
// 调课标记与无时间安排课程处理。样本为脱敏真实页面（tests/fixtures/zhengfang-timetable-real.html）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDomWithMeta } from "../../src/main/services/parsers";
import { ZhengfangParser } from "../../src/main/services/parsers/ZhengfangParser";

const html = readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "zhengfang-timetable-real.html",
  ),
  "utf8",
);

const result = parseDomWithMeta(html);
const { courses } = result;

function find(name: string, weekday: number, startPeriod: number) {
  return courses.filter(
    (c) =>
      c.name === name && c.weekday === weekday && c.startPeriod === startPeriod,
  );
}

describe("正方真实课表样本", () => {
  it("解析出合并后的 22 门课程，调课标记不产生记录", () => {
    expect(courses).toHaveLength(22);
    expect(courses.some((c) => c.name?.includes("调"))).toBe(false);
    for (const c of courses) {
      expect(c.name).not.toMatch(/必修|选修|课外/);
    }
  });

  it("无时间安排课程进入跳过清单", () => {
    expect(result.skippedUnscheduled).toEqual([
      { name: "C语言实践", teacher: "肖明霞" },
      { name: "大学物理实验", teacher: "赵野" },
    ]);
  });

  it("星期与节次按网格定位，不再错列", () => {
    expect(find("线性代数", 1, 1)[0]).toMatchObject({
      endPeriod: 2,
      startWeek: 1,
      endWeek: 16,
      teacher: "罗威",
      location: "敬仲楼(原4#教学楼)101",
    });
    expect(find("网球3", 5, 3)[0]).toMatchObject({
      endPeriod: 4,
      teacher: "袁磊",
      location: "室外网球场（东）",
    });
    expect(find("工程导论", 4, 7)[0]).toMatchObject({
      endPeriod: 8,
      startWeek: 4,
      endWeek: 11,
      teacher: "成孟金",
    });
    expect(find("经济学平话", 2, 9)[0]).toMatchObject({
      endPeriod: 10,
      startWeek: 1,
      endWeek: 8,
      teacher: "陈涛",
    });
    expect(find("马克思主义基本原理", 2, 3)[0]).toMatchObject({
      endPeriod: 4,
      startWeek: 1,
      endWeek: 10,
    });
  });

  it("孤立单双周课程保留周范围并标注名称", () => {
    expect(find("算法与数据结构（双周）", 2, 1)[0]).toMatchObject({
      startWeek: 2,
      endWeek: 14,
      endPeriod: 2,
      teacher: "张雪",
    });
    expect(find("计算机科学导论（单周）", 3, 7)[0]).toMatchObject({
      startWeek: 5,
      endWeek: 13,
      endPeriod: 8,
      teacher: "刘俊",
    });
  });

  it("互补单双对合并为一条全周课，地点不同则拼接标注", () => {
    const thursday = find("大学外语III", 4, 1);
    expect(thursday).toHaveLength(1);
    expect(thursday[0]).toMatchObject({
      startWeek: 1,
      endWeek: 16,
      endPeriod: 2,
      teacher: "胡晓玥",
      location: "碧帆楼107（单周）/景唐楼(原1#教学楼)603（双周）",
    });
    const monday = find("大学外语III", 1, 3);
    expect(monday).toHaveLength(1);
    expect(monday[0].location).toBe("景唐楼(原1#教学楼)603");
  });

  it("真实撞课数据保留：周五 1-2 节有两门课", () => {
    expect(find("C语言程序设计", 5, 1)[0]).toMatchObject({
      startWeek: 4,
      endWeek: 15,
    });
    expect(find("线性代数", 5, 1)[0]).toMatchObject({
      startWeek: 1,
      endWeek: 16,
    });
  });

  it("每门课都有名称、星期和起止节次（满足导入完整性校验）", () => {
    for (const c of courses) {
      expect(c.name?.trim()).toBeTruthy();
      expect(c.weekday).toBeGreaterThanOrEqual(1);
      expect(c.weekday).toBeLessThanOrEqual(7);
      expect(Number.isInteger(c.startWeek)).toBe(true);
      expect(Number.isInteger(c.endWeek)).toBe(true);
      expect(Number.isInteger(c.startPeriod)).toBe(true);
      expect(Number.isInteger(c.endPeriod)).toBe(true);
      expect(c.startWeek!).toBeLessThanOrEqual(c.endWeek!);
      expect(c.startPeriod!).toBeLessThanOrEqual(c.endPeriod!);
    }
  });

  it("无星期表头且仅一个标签列时按课程区首列回退星期", () => {
    // 正方变体：表头只有"节次"，课程从第 2 列（col 1）开始
    const html = `<table id="Table1">
      <tr><th>节次</th><th>周一</th></tr>
      <tr><td>第1节</td><td><div class="TDContent">高等数学,张老师,1-16周,第1-2节,教学楼A101</div></td></tr>
    </table>`;
    const courses = new ZhengfangParser().parse(html);
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({
      name: "高等数学",
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
    });
  });

  it("稀疏纯文本单元格回退为名单课程", () => {
    const html = `<table id="Table1">
      <tr><th>节次</th><th>占位</th><th>周一</th></tr>
      <tr><td>第6节</td><td></td><td>计算机网络</td></tr>
    </table>`;
    const courses = new ZhengfangParser().parse(html);
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({
      name: "计算机网络",
      weekday: 1,
      startPeriod: 6,
      endPeriod: 6,
    });
  });
});
