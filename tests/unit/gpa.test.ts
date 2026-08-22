import { describe, expect, it } from "vitest";
import { evaluateGpaFormula, validateGpaFormula } from "../../src/shared/gpa";

const grades = [
  { credit: 4, gradePoint: 4, score: 90 },
  { credit: 3, gradePoint: 3, score: 80 },
];

describe("受限 GPA 公式解析器", () => {
  it("supports arithmetic precedence, unary operators and aggregation", () => {
    expect(
      evaluateGpaFormula("SUM(credit * gradePoint) / SUM(credit)", grades),
    ).toBe(3.57);
    expect(
      evaluateGpaFormula("SUM(-gradePoint + 5) / SUM(credit)", grades),
    ).toBe(0.43);
    expect(evaluateGpaFormula("SUM(credit % 3) + 2^3", grades)).toBe(9);
    expect(evaluateGpaFormula("(SUM(credit) + 1) / 2", grades)).toBe(4);
  });

  it("treats missing score as zero and returns zero for no records", () => {
    expect(
      evaluateGpaFormula("SUM(score)", [{ credit: 2, gradePoint: 4 }]),
    ).toBe(0);
    expect(evaluateGpaFormula("1 / 0", [])).toBe(0);
  });

  it("rejects malformed, unsupported and unsafe formulas", () => {
    const invalid = [
      "",
      "SUM(credit",
      "SUM(credit))",
      "SUM(SUM(credit))",
      "SUM(__proto__)",
      "SUM(credit) / 0",
      "SUM(credit) + @",
      "credit",
      "1e9999",
    ];
    for (const formula of invalid) {
      expect(validateGpaFormula(formula).ok, formula).toBe(false);
    }
  });

  it("rejects non-finite operations and over-complex input", () => {
    expect(() => evaluateGpaFormula("10^10000", grades)).toThrow(
      "公式结果不是有限数字",
    );
    expect(() => evaluateGpaFormula("1+".repeat(130), grades)).toThrow(
      "公式过于复杂",
    );
    expect(() => evaluateGpaFormula("1 / 0", grades)).toThrow("公式不能除以零");
  });
});
