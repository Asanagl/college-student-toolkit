import { describe, expect, it } from "vitest";
import { parseOcrToExams } from "../../src/main/services/ExamOcrParser";
import { parseOcrToLabs } from "../../src/main/services/LabOcrParser";

describe("OCR 考试文本解析", () => {
  it("合并多行信息并规范化日期、时间、座位和地点", () => {
    const exams = parseOcrToExams(
      "高等数学 2026年1月5日 9:00-11:00 教学楼A101 座位:A12\n" +
        "线性代数 2026/02/06 14:00~16:00 教学楼B202 座位号 08",
    );

    expect(exams).toEqual([
      expect.objectContaining({
        courseName: "高等数学",
        date: "2026-01-05",
        startTime: "09:00",
        endTime: "11:00",
        location: "教学楼A101",
        seat: "A12",
      }),
      expect.objectContaining({
        courseName: "线性代数",
        date: "2026-02-06",
        startTime: "14:00",
        endTime: "16:00",
        location: "教学楼B202",
        seat: "08",
      }),
    ]);
  });

  it("空输入和只有噪声时不伪造考试", () => {
    expect(parseOcrToExams("")).toEqual([]);
    expect(parseOcrToExams("a\n2026-01-05\n09:00-11:00\n---")).toEqual([]);
  });

  it("把课程名行与后续日期、时间、地点和座位行合并", () => {
    expect(
      parseOcrToExams("高等数学\n2026-03-01 08:00-10:00 教学楼C303 座位:Z9"),
    ).toEqual([
      expect.objectContaining({
        courseName: "高等数学",
        date: "2026-03-01",
        startTime: "08:00",
        endTime: "10:00",
        location: "教学楼C303",
        seat: "Z9",
      }),
    ]);
  });
});

describe("OCR 实验文本解析", () => {
  it("提取单行和多行实验信息", () => {
    const labs = parseOcrToLabs(
      "电路实验 2026.1.6 14:00—16:00 实验楼B201 指导教师:李老师\n" +
        "物理实验 2026-02-07 9:30-10:30 实验室C301 指导教师:王老师",
    );

    expect(labs).toEqual([
      expect.objectContaining({
        name: "电路实验",
        date: "2026-01-06",
        startTime: "14:00",
        endTime: "16:00",
        location: "实验楼B201",
        instructor: "李老师",
      }),
      expect.objectContaining({
        name: "物理实验",
        date: "2026-02-07",
        startTime: "09:30",
        endTime: "10:30",
        location: "实验室C301",
        instructor: "王老师",
      }),
    ]);
  });

  it("忽略无法识别的文本而保持空结果安全", () => {
    expect(parseOcrToLabs("")).toEqual([]);
    expect(parseOcrToLabs("a")).toEqual([]);
    expect(parseOcrToLabs("2026-01-01\n09:00-10:00\n")).toEqual([]);
  });

  it("把实验名行与后续安排信息合并", () => {
    expect(
      parseOcrToLabs(
        "电路实验\n2026年3月2日 13:00-15:00 实验室D201 指导教师:赵老师",
      ),
    ).toEqual([
      expect.objectContaining({
        name: "电路实验",
        date: "2026-03-02",
        startTime: "13:00",
        endTime: "15:00",
        location: "实验室D201",
        instructor: "赵老师",
      }),
    ]);
  });
});
