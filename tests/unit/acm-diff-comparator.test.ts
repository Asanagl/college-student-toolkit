import { describe, expect, it } from "vitest";
import {
  ACM_TOKEN_CONTEXT,
  compareAcmTokens,
} from "../../src/main/services/AcmTokenComparator";

describe("AcmTokenComparator", () => {
  it("ignores all whitespace and empty output", () => {
    expect(compareAcmTokens("  1\r\n\t2  ", "1 2\n")).toEqual({
      status: "match",
    });
    expect(compareAcmTokens("\r\n\t ", " ")).toEqual({ status: "match" });
  });

  it("returns the first mismatch with three-token context", () => {
    const result = compareAcmTokens(
      "a b c d expected f g h i",
      "a b c d actual f g h i",
    );
    expect(result.status).toBe("mismatch");
    if (result.status !== "mismatch") return;
    expect(result.difference).toEqual({
      referenceTokens: ["b", "c", "d", "expected", "f", "g", "h"],
      candidateTokens: ["b", "c", "d", "actual", "f", "g", "h"],
      referenceStart: 1,
      candidateStart: 1,
    });
  });

  it("clips context at the beginning and end", () => {
    const result = compareAcmTokens(
      "wrong b c d e f g h i",
      "right b c d e f g h i",
    );
    expect(result.status).toBe("mismatch");
    if (result.status !== "mismatch") return;
    expect(result.difference.referenceTokens).toEqual(["wrong", "b", "c", "d"]);
    expect(result.difference.candidateTokens).toEqual(["right", "b", "c", "d"]);
    expect(result.difference.referenceStart).toBe(0);
    expect(result.difference.candidateStart).toBe(0);
    expect(ACM_TOKEN_CONTEXT).toBe(3);
  });

  it("reports missing tokens when candidate ends first", () => {
    const result = compareAcmTokens("a b c d e f", "a b c");
    expect(result).toEqual({
      status: "mismatch",
      difference: {
        referenceTokens: ["a", "b", "c", "d", "e", "f"],
        candidateTokens: ["a", "b", "c"],
        referenceStart: 0,
        candidateStart: 0,
        candidateMissing: 3,
      },
    });
  });

  it("reports extra tokens when candidate has trailing output", () => {
    const result = compareAcmTokens("a b", "a b c d e f");
    expect(result).toEqual({
      status: "mismatch",
      difference: {
        referenceTokens: ["a", "b"],
        candidateTokens: ["a", "b", "c", "d", "e", "f"],
        referenceStart: 0,
        candidateStart: 0,
        referenceMissing: 4,
      },
    });
  });

  it("does not treat token-internal characters as whitespace variants", () => {
    expect(compareAcmTokens("answer-1", "answer_1")).toEqual({
      status: "mismatch",
      difference: {
        referenceTokens: ["answer-1"],
        candidateTokens: ["answer_1"],
        referenceStart: 0,
        candidateStart: 0,
      },
    });
  });

  it("bounds a giant token before exposing the diff context", () => {
    const result = compareAcmTokens("a".repeat(70_000), "b");
    expect(result.status).toBe("mismatch");
    if (result.status !== "mismatch") return;
    expect(
      Buffer.byteLength(result.difference.referenceTokens[0], "utf8"),
    ).toBeLessThanOrEqual(65_536);
    expect(result.difference.referenceTokens[0].endsWith("…")).toBe(true);
  });
});
