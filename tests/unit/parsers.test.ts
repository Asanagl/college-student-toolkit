import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDomWithAllParsers } from "../../src/main/services/parsers";
import { parseDomForExams } from "../../src/main/services/parsers/exam";
import { parseDomForLabs } from "../../src/main/services/parsers/lab";
import { GenericExamParser } from "../../src/main/services/parsers/exam/GenericExamParser";
import { ZhengfangExamParser } from "../../src/main/services/parsers/exam/ZhengfangExamParser";
import { GenericLabParser } from "../../src/main/services/parsers/lab/GenericLabParser";
import { ZhengfangLabParser } from "../../src/main/services/parsers/lab/ZhengfangLabParser";
import { QingguoParser } from "../../src/main/services/parsers/QingguoParser";
import { UrpParser } from "../../src/main/services/parsers/UrpParser";
import { ZhengfangParser } from "../../src/main/services/parsers/ZhengfangParser";

function fixture(name: string): string {
  return readFileSync(
    path.join(process.cwd(), "tests", "fixtures", name),
    "utf8",
  );
}

describe("教务课程 DOM 解析", () => {
  it("解析正方课表中的节次、周次和地点", () => {
    const courses = parseDomWithAllParsers(fixture("zhengfang-course.html"));

    expect(courses).toHaveLength(2);
    expect(courses[0]).toMatchObject({
      name: "高等数学",
      teacher: "张老师",
      location: "教学楼A101",
      startWeek: 1,
      endWeek: 16,
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
    });
    expect(courses[1]).toMatchObject({
      name: "线性代数",
      startWeek: 1,
      endWeek: 5,
      weekday: 1,
      startPeriod: 3,
    });
  });

  it.each([
    ["urp-course.html", "大学英语", "外语楼201"],
    ["qingguo-course.html", "程序设计", "实验楼301"],
    ["generic-course.html", "数据结构", "教学楼C303"],
  ])("支持 %s 或通用表格回退", (file, name, location) => {
    const courses = parseDomWithAllParsers(fixture(file));

    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({ name, location, weekday: 1 });
  });

  it("空白、无表格和 malformed HTML 安全返回空列表", () => {
    expect(parseDomWithAllParsers("")).toEqual([]);
    expect(
      parseDomWithAllParsers("<html><body>没有课表</body></html>"),
    ).toEqual([]);
    expect(parseDomWithAllParsers("<table><tr><td>未闭合")).toEqual([]);
  });

  it("解析考试和实验专用表格，并回退到通用表格", () => {
    const exam = parseDomForExams(fixture("exam.html"));
    expect(exam).toHaveLength(1);
    expect(exam[0]).toMatchObject({
      courseName: "高等数学",
      date: "2026-01-05",
      startTime: "09:00",
      endTime: "11:00",
      location: "教学楼A101",
      seat: "A12",
    });

    const lab = parseDomForLabs(fixture("lab.html"));
    expect(lab).toHaveLength(1);
    expect(lab[0]).toMatchObject({
      name: "电路实验",
      date: "2026-01-06",
      startTime: "14:00",
      endTime: "16:00",
      location: "实验楼B201",
      instructor: "李老师",
    });

    const genericExam = parseDomForExams(
      `<html><title>安排</title><table><tr><th>考试科目</th><th>考试时间</th><th>考场</th></tr><tr><td>英语</td><td>2026/01/07 09:00-10:00</td><td>教学楼C303</td></tr></table></html>`,
    );
    expect(genericExam[0]).toMatchObject({
      courseName: "英语",
      date: "2026-01-07",
      startTime: "09:00",
      endTime: "10:00",
    });

    const genericLab = parseDomForLabs(
      `<html><title>安排</title><table><tr><th>实验名称</th><th>实验时间</th><th>地点</th></tr><tr><td>物理实验</td><td>2026.01.08 13:00~14:00</td><td>实验室301</td></tr></table></html>`,
    );
    expect(genericLab[0]).toMatchObject({
      name: "物理实验",
      date: "2026-01-08",
      startTime: "13:00",
      endTime: "14:00",
    });
  });

  it("处理解析器的空表、专用特征和无匹配输入", () => {
    const zhengfangExam = new ZhengfangExamParser();
    expect(
      zhengfangExam.detect(
        `<body><table id="Table1"><tr><th>考试</th><th>课程</th><th>地点</th></tr></table></body>`,
      ),
    ).toBe(true);
    expect(zhengfangExam.parse("<html><body>没有考试表</body></html>")).toEqual(
      [],
    );
    expect(
      zhengfangExam.detect("<html><title>考试</title><p>没有表格</p></html>"),
    ).toBe(false);

    const genericExam = new GenericExamParser();
    expect(genericExam.detect("<html><body>没有表格</body></html>")).toBe(
      false,
    );
    expect(genericExam.parse("<html><body>没有考试表</body></html>")).toEqual(
      [],
    );

    const zhengfangLab = new ZhengfangLabParser();
    expect(
      zhengfangLab.detect(
        `<body><table id="Table1"><tr><th>实验</th><th>地点</th><th>日期</th></tr></table></body>`,
      ),
    ).toBe(true);
    expect(zhengfangLab.parse("<html><body>没有实验表</body></html>")).toEqual(
      [],
    );
    expect(
      zhengfangLab.detect("<html><title>实验</title><p>没有表格</p></html>"),
    ).toBe(false);

    const genericLab = new GenericLabParser();
    expect(genericLab.detect("<html><body>没有表格</body></html>")).toBe(false);
    expect(genericLab.parse("<html><body>没有实验表</body></html>")).toEqual(
      [],
    );
  });

  it("覆盖考试和实验解析器的表头字段与启发式回退", () => {
    const genericExam = new GenericExamParser();
    const examHtml = `<table>
      <tr><th>考试科目</th><th>日期</th><th>时间</th><th>地点</th><th>座位号</th><th>备注</th></tr>
      <tr><td>高等数学</td><td>2026-01-05</td><td>09:00-11:00</td><td>教学楼A101</td><td>座位号:A12</td><td>闭卷</td></tr>
    </table>`;
    expect(genericExam.detect(examHtml)).toBe(true);
    expect(genericExam.parse(examHtml)[0]).toMatchObject({
      courseName: "高等数学",
      date: "2026-01-05",
      startTime: "09:00",
      endTime: "11:00",
      location: "教学楼A101",
      seat: "A12",
      notes: "闭卷",
    });

    const heuristicExam = genericExam.parse(`<table>
      <tr><th>考试</th><th>未知字段</th><th>更多</th></tr>
      <tr><td>教学楼B202#</td><td>线性代数</td><td>2026年2月6日 14:00~16:00</td><td>座位:Z9</td></tr>
    </table>`);
    expect(heuristicExam[0]).toMatchObject({
      courseName: "线性代数",
      date: "2026-02-06",
      startTime: "14:00",
      endTime: "16:00",
      location: "教学楼B202#",
    });

    const genericLab = new GenericLabParser();
    const labHtml = `<table>
      <tr><th>实验名称</th><th>日期</th><th>时间</th><th>地点</th><th>指导教师</th><th>备注</th></tr>
      <tr><td>电路实验</td><td>2026.01.08</td><td>13:00—14:00</td><td>实验室301</td><td>李老师</td><td>带万用表</td></tr>
    </table>`;
    expect(genericLab.detect(labHtml)).toBe(true);
    expect(genericLab.parse(labHtml)[0]).toMatchObject({
      name: "电路实验",
      date: "2026-01-08",
      startTime: "13:00",
      endTime: "14:00",
      location: "实验室301",
      instructor: "李老师",
      notes: "带万用表",
    });

    const heuristicLab = genericLab.parse(`<table>
      <tr><th>实验安排</th><th>未知</th><th>其他</th></tr>
      <tr><td>实验室D201#</td><td>物理实验</td><td>2026年3月2日 13:00-15:00 指导教师:赵老师</td></tr>
    </table>`);
    expect(heuristicLab[0]).toMatchObject({
      name: "物理实验",
      date: "2026-03-02",
      startTime: "13:00",
      endTime: "15:00",
      location: "实验室D201#",
    });
  });

  it("覆盖正方考试和实验的专用表头、标题回退和空行", () => {
    const examHtml = `<html><body><table id="Table1">
      <tr><th>课程名</th><th>考试日期</th><th>考试时间</th><th>考试地点</th><th>座位号</th><th>备注</th></tr>
      <tr><td>高等数学</td><td>2026-01-05</td><td>09:00-11:00</td><td>教学楼A101</td><td>座位:A12</td><td>闭卷</td></tr>
      <tr><td></td><td></td><td></td></tr>
    </table></body></html>`;
    const zhengfangExam = new ZhengfangExamParser();
    expect(zhengfangExam.detect(examHtml)).toBe(true);
    expect(zhengfangExam.parse(examHtml)).toEqual([
      expect.objectContaining({
        courseName: "高等数学",
        date: "2026-01-05",
        startTime: "09:00",
        endTime: "11:00",
        location: "教学楼A101",
        seat: "A12",
        notes: "闭卷",
      }),
    ]);
    expect(
      zhengfangExam.parse(
        `<title>考试安排</title><table><tr><th>考试科目</th><th>日期</th><th>考场</th></tr><tr><td>英语</td><td>2026/01/07 09:00-10:00</td><td>教学楼B202</td></tr></table>`,
      ),
    ).toHaveLength(1);

    const labHtml = `<html><body><table id="Table1">
      <tr><th>实验名称</th><th>实验日期</th><th>实验时间</th><th>实验地点</th><th>指导教师</th><th>备注</th></tr>
      <tr><td>电路实验</td><td>2026-01-06</td><td>14:00-16:00</td><td>实验楼B201</td><td>李老师</td><td>带万用表</td></tr>
      <tr><td></td><td></td><td></td></tr>
    </table></body></html>`;
    const zhengfangLab = new ZhengfangLabParser();
    expect(zhengfangLab.detect(labHtml)).toBe(true);
    expect(zhengfangLab.parse(labHtml)).toEqual([
      expect.objectContaining({
        name: "电路实验",
        date: "2026-01-06",
        startTime: "14:00",
        endTime: "16:00",
        location: "实验楼B201",
        instructor: "李老师",
        notes: "带万用表",
      }),
    ]);
    expect(
      zhengfangLab.parse(
        `<title>实验安排</title><table><tr><th>实验名称</th><th>日期</th><th>地点</th></tr><tr><td>物理实验</td><td>2026/01/08</td><td>实验室C301</td></tr></table>`,
      ),
    ).toHaveLength(1);
  });

  it("覆盖课程解析器的标题检测回退和无匹配表格边界", () => {
    const qingguo = new QingguoParser();
    expect(
      qingguo.detect(
        `<title>青果课表</title><table><tr><td>一</td><td>二</td><td>三</td></tr></table>`,
      ),
    ).toBe(true);
    expect(
      qingguo.parse("<table><tr><td>不是青果课表</td></tr></table>"),
    ).toEqual([]);

    const urp = new UrpParser();
    expect(
      urp.detect(
        `<title>URP 综合教务</title><table><tr><td>一</td><td>二</td><td>三</td></tr></table>`,
      ),
    ).toBe(true);
    expect(urp.parse("<table><tr><td>不是 URP 课表</td></tr></table>")).toEqual(
      [],
    );

    const zhengfang = new ZhengfangParser();
    expect(
      zhengfang.detect(
        `<title>正方教务课表</title><table bordercolor="blue"></table>`,
      ),
    ).toBe(true);
    expect(
      zhengfang.parse("<table><tr><td>不是正方课表</td></tr></table>"),
    ).toEqual([]);
  });

  it("覆盖通用考试解析的空列、启发式时间和字段回退", () => {
    const parser = new GenericExamParser();
    expect(parser.detect("<table></table>")).toBe(false);
    const heuristic = parser.parse(`
      <table><tr></tr></table>
      <table>
        <tr><th>考试</th><th>未知</th><th>更多</th></tr>
        <tr><td></td><td>线性代数</td><td>2026-01-09</td><td>09:00~10:00</td><td>无固定座位</td><td>教学楼A101</td></tr>
        <tr><th>跳过</th><td>ignored</td></tr>
        <tr><td>!</td></tr>
      </table>`);
    expect(heuristic[0]).toMatchObject({
      courseName: "线性代数",
      date: "2026-01-09",
      startTime: "09:00",
      endTime: "10:00",
      location: "教学楼A101",
    });

    const mapped = parser.parse(`
      <table>
        <tr><th>课程名</th><th>日期</th><th>时间</th><th>座位</th></tr>
        <tr><td>物理</td><td></td><td>2026-01-10 09:00-10:00</td><td>无固定座位</td></tr>
      </table>`);
    expect(mapped[0]).toMatchObject({
      courseName: "物理",
      date: "2026-01-10",
      startTime: "09:00",
      endTime: "10:00",
      seat: "无固定座位",
    });
  });

  it("覆盖正方考试解析的检测、筛选和字段边界", () => {
    const parser = new ZhengfangExamParser();
    expect(parser.detect(`<table id="Table1"></table>`)).toBe(false);
    expect(
      parser.detect(
        `<title>考试</title><table><tr><td>普通表格</td></tr></table>`,
      ),
    ).toBe(false);
    expect(parser.parse(`<table><tr><td>其他安排</td></tr></table>`)).toEqual(
      [],
    );

    const mapped = parser.parse(`
      <table id="Table1">
        <tr><th>课程名</th><th>日期</th><th>时间</th><th>座位</th><th>未知</th></tr>
        <tr><th>跳过</th><td>ignored</td></tr>
        <tr><td>物理</td><td>2026-01-10</td><td>2026-01-10 09:00-10:00</td><td>无固定座位</td><td>ignored</td></tr>
      </table>`);
    expect(mapped[0]).toMatchObject({
      courseName: "物理",
      date: "2026-01-10",
      startTime: "09:00",
      endTime: "10:00",
      seat: "无固定座位",
    });
    expect(parseDomForExams("")).toEqual([]);
  });

  it("覆盖通用实验解析的空列、启发式字段和时间回退", () => {
    const parser = new GenericLabParser();
    expect(parser.detect("<table></table>")).toBe(false);
    const heuristic = parser.parse(`
      <table><tr></tr></table>
      <table>
        <tr><th>实验安排</th><th>未知</th><th>更多</th></tr>
        <tr><td></td><td>物理实验</td><td>2026-01-09</td><td>13:00~15:00</td><td>李老师</td><td>实验室D201</td></tr>
        <tr><th>跳过</th><td>ignored</td></tr>
        <tr><td>!</td></tr>
      </table>`);
    expect(heuristic[0]).toMatchObject({
      name: "物理实验",
      date: "2026-01-09",
      startTime: "13:00",
      endTime: "15:00",
      instructor: "李老师",
      location: "实验室D201",
    });

    const mapped = parser.parse(`
      <table>
        <tr><th>实验名称</th><th>日期</th><th>时间</th><th>指导教师</th></tr>
        <tr><td>电路</td><td></td><td>2026-01-10 13:00-15:00</td><td>张老师</td></tr>
      </table>`);
    expect(mapped[0]).toMatchObject({
      name: "电路",
      date: "2026-01-10",
      startTime: "13:00",
      endTime: "15:00",
      instructor: "张老师",
    });
  });

  it("覆盖正方实验解析的检测、筛选和字段边界", () => {
    const parser = new ZhengfangLabParser();
    expect(parser.detect(`<table id="Table1"></table>`)).toBe(false);
    expect(
      parser.detect(
        `<title>实验</title><table><tr><td>普通表格</td></tr></table>`,
      ),
    ).toBe(false);
    expect(parser.parse(`<table><tr><td>其他安排</td></tr></table>`)).toEqual(
      [],
    );

    const mapped = parser.parse(`
      <table id="Table1">
        <tr><th>实验名称</th><th>日期</th><th>时间</th><th>指导教师</th><th>未知</th></tr>
        <tr><th>跳过</th><td>ignored</td></tr>
        <tr><td>电路</td><td>2026-01-10</td><td>2026-01-10 13:00-15:00</td><td>暂无</td><td>ignored</td></tr>
      </table>`);
    expect(mapped[0]).toMatchObject({
      name: "电路",
      date: "2026-01-10",
      startTime: "13:00",
      endTime: "15:00",
      instructor: "暂无",
    });
    expect(parseDomForLabs("")).toEqual([]);
  });

  it("处理文本单元格的节次回退和稀疏专用表格", () => {
    const courseHeaders = "<tr><th>节次</th><th>占位</th><th>周一</th></tr>";
    const qingguo = new QingguoParser().parse(
      `<table class="kbtable">${courseHeaders}<tr><td>第4节</td><td></td><td>离散数学</td></tr></table>`,
    );
    const urp = new UrpParser().parse(
      `<table class="rowClasses">${courseHeaders}<tr><td>第5节</td><td></td><td>操作系统</td></tr></table>`,
    );
    const zhengfang = new ZhengfangParser().parse(
      `<table id="Table1">${courseHeaders}<tr><td>第6节</td><td></td><td>计算机网络</td></tr></table>`,
    );

    expect(qingguo[0]).toMatchObject({
      name: "离散数学",
      weekday: 1,
      startPeriod: 4,
      endPeriod: 4,
    });
    expect(urp[0]).toMatchObject({
      name: "操作系统",
      weekday: 1,
      startPeriod: 5,
      endPeriod: 5,
    });
    expect(zhengfang[0]).toMatchObject({
      name: "计算机网络",
      weekday: 1,
      startPeriod: 6,
      endPeriod: 6,
    });
    expect(new QingguoParser().detect("<title>青果课表</title>")).toBe(false);
    expect(new UrpParser().detect("<title>URP</title>")).toBe(false);
    expect(
      new ZhengfangParser().detect("<title>正方教务</title><table></table>"),
    ).toBe(false);

    const exam = new ZhengfangExamParser().parse(`
      <table id="Table1">
        <tr><th>未知 A</th><th>未知 B</th><th>未知 C</th><th>未知 D</th></tr>
        <tr><td></td><td>教学楼A101#</td><td>2026-01-11 09:00-10:00</td><td>离散数学</td></tr>
      </table>`);
    expect(exam[0]).toMatchObject({
      courseName: "离散数学",
      date: "2026-01-11",
      startTime: "09:00",
      endTime: "10:00",
      location: "教学楼A101#",
    });

    const lab = new ZhengfangLabParser().parse(`
      <table id="Table1">
        <tr><th>未知 A</th><th>未知 B</th><th>未知 C</th><th>未知 D</th></tr>
        <tr><td></td><td>实验室B201#</td><td>2026-01-12 13:00-15:00</td><td>系统实验</td></tr>
      </table>`);
    expect(lab[0]).toMatchObject({
      name: "系统实验",
      date: "2026-01-12",
      startTime: "13:00",
      endTime: "15:00",
      location: "实验室B201#",
    });
  });
});
