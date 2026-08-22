import { describe, expect, it } from "vitest";
import { ParserBase } from "../../src/main/services/parsers/ParserBase";

class ExposedParser extends ParserBase {
  get name(): string {
    return "test";
  }

  detect(): boolean {
    return false;
  }

  parse(): never[] {
    return [];
  }

  weeks(value: string): [number, number] | null {
    return this.parseWeeks(value);
  }

  periods(value: string): [number, number] | null {
    return this.parsePeriods(value);
  }

  weekday(value: string): number | null {
    return this.parseWeekday(value);
  }

  clean(value: string): string {
    return this.cleanText(value);
  }
}

describe("解析器公共文本工具", () => {
  const parser = new ExposedParser();

  it("解析范围、离散周次和反向范围", () => {
    expect(parser.weeks("1-16周")).toEqual([1, 16]);
    expect(parser.weeks("16~1")).toEqual([1, 16]);
    expect(parser.weeks("1, 3、5周")).toEqual([1, 5]);
    expect(parser.weeks("全周")).toBeNull();
    expect(parser.weeks("")).toBeNull();
  });

  it("解析节次、星期别名并拒绝越界输入", () => {
    expect(parser.periods("第1-2节")).toEqual([1, 2]);
    expect(parser.periods("7节")).toEqual([7, 7]);
    expect(parser.periods("")).toBeNull();
    expect(parser.periods("没有节次")).toBeNull();
    expect(parser.weekday("星期一")).toBe(1);
    expect(parser.weekday("周末")).toBe(7);
    expect(parser.weekday("7")).toBe(7);
    expect(parser.weekday("0")).toBeNull();
    expect(parser.weekday("")).toBeNull();
    expect(parser.periods("9".repeat(400))).toBeNull();
    expect(parser.weekday("9".repeat(400))).toBeNull();
  });

  it("清理不可见空格但不把文本当作 HTML", () => {
    expect(parser.clean("  高等\u00a0数学\n\t")).toBe("高等 数学");
    expect(parser.clean("")).toBe("");
  });
});
