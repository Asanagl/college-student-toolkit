import { describe, expect, it } from "vitest";
import { ExamParserBase } from "../../src/main/services/parsers/exam/ExamParserBase";
import { LabParserBase } from "../../src/main/services/parsers/lab/LabParserBase";

class ExposedExamParser extends ExamParserBase {
  get name(): string {
    return "test-exam";
  }

  detect(): boolean {
    return false;
  }

  parse(): never[] {
    return [];
  }

  date(value: string): string | null {
    return this.parseDate(value);
  }

  time(value: string): [string, string] | null {
    return this.parseTimeRange(value);
  }

  normalize(value: string): string {
    return this.normalizeHHmm(value);
  }

  seat(value: string): string | null {
    return this.parseSeat(value);
  }

  clean(value: string): string {
    return this.cleanText(value);
  }
}

class ExposedLabParser extends LabParserBase {
  get name(): string {
    return "test-lab";
  }

  detect(): boolean {
    return false;
  }

  parse(): never[] {
    return [];
  }

  date(value: string): string | null {
    return this.parseDate(value);
  }

  time(value: string): [string, string] | null {
    return this.parseTimeRange(value);
  }

  normalize(value: string): string {
    return this.normalizeHHmm(value);
  }

  clean(value: string): string {
    return this.cleanText(value);
  }
}

describe("考试和实验解析器公共字段工具", () => {
  it("覆盖考试日期、时间、座位和清理边界", () => {
    const parser = new ExposedExamParser();
    expect(parser.date("")).toBeNull();
    expect(parser.date("2026年1月5日")).toBe("2026-01-05");
    expect(parser.date("2026.1.5")).toBe("2026-01-05");
    expect(parser.date("not-a-date")).toBeNull();
    expect(parser.time("")).toBeNull();
    expect(parser.time("9:00—11:00")).toEqual(["09:00", "11:00"]);
    expect(parser.time("not-a-time")).toBeNull();
    expect(parser.normalize("09")).toBe("09");
    expect(parser.seat("")).toBeNull();
    expect(parser.seat("座位：A-12")).toBe("A-12");
    expect(parser.seat("没有座位")).toBeNull();
    expect(parser.clean("  考试\u00a0安排\n")).toBe("考试 安排");
  });

  it("覆盖实验日期、时间和异常文本分支", () => {
    const parser = new ExposedLabParser();
    expect(parser.date("")).toBeNull();
    expect(parser.date("2026/01/08")).toBe("2026-01-08");
    expect(parser.date("2026年13月40日")).toBe("2026-13-40");
    expect(parser.date("unknown")).toBeNull();
    expect(parser.time("13:00~14:00")).toEqual(["13:00", "14:00"]);
    expect(parser.time("")).toBeNull();
    expect(parser.time("broken")).toBeNull();
    expect(parser.normalize("8:00")).toBe("08:00");
    expect(parser.normalize("09")).toBe("09");
    expect(parser.clean("实验\u00a0安排")).toBe("实验 安排");
  });
});
