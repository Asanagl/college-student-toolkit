import { describe, expect, it } from "vitest";
import {
  IpcValidationError,
  courseAddSchema,
  coursePatchSchema,
  examAddSchema,
  examPatchSchema,
  formulaSchema,
  gradeAddSchema,
  gradePageQuerySchema,
  gradePatchSchema,
  htmlSchema,
  imageBase64Schema,
  labAddSchema,
  labPatchSchema,
  notificationPayloadSchema,
  acmCompilerSelectionSchema,
  acmDocumentScopeSchema,
  acmDocumentSaveSchema,
  acmDiffStartSchema,
  acmRunnerStartSchema,
  acmTemplateSchema,
  parseIpc,
  periodConfigSchema,
  scheduleAddSchema,
  schedulePatchSchema,
  semesterStartSchema,
} from "../../src/main/validation";
import { canUseAcmDocumentScope } from "../../src/main/services/AcmDocumentPolicy";

describe("IPC runtime validation", () => {
  it("keeps the unbounded document scope on the dedicated diff route", () => {
    expect(
      canUseAcmDocumentScope(
        "diff-candidate",
        "file:///app/index.html#/acm-diff",
      ),
    ).toBe(true);
    expect(
      canUseAcmDocumentScope(
        "diff-reference",
        "http://localhost:5173/#/acm-diff?tab=candidate",
      ),
    ).toBe(true);
    expect(
      canUseAcmDocumentScope("diff-candidate", "file:///app/index.html#/acm"),
    ).toBe(false);
    expect(
      canUseAcmDocumentScope(
        "diff-candidate",
        "file:///app/index.html#/acm-diff-extra",
      ),
    ).toBe(false);
    expect(canUseAcmDocumentScope("workbench", "not a url")).toBe(true);
  });

  it("rejects an impossible calendar date instead of allowing Date to normalize it", () => {
    expect(() => parseIpc(semesterStartSchema, "2025-02-30")).toThrow(
      IpcValidationError,
    );
  });

  it("rejects reversed schedule times and reversed partial ranges", () => {
    expect(() =>
      parseIpc(scheduleAddSchema, {
        title: "复习",
        startTime: "2026-08-21T10:00:00+08:00",
        endTime: "2026-08-21T09:00:00+08:00",
        reminderOffset: 10,
        repeatRule: "none",
      }),
    ).toThrow("结束时间必须晚于开始时间");
    expect(() =>
      parseIpc(schedulePatchSchema, {
        startTime: "2026-08-21T10:00:00+08:00",
        endTime: "2026-08-21T09:00:00+08:00",
      }),
    ).toThrow("结束时间必须晚于开始时间");
    expect(() =>
      parseIpc(coursePatchSchema, { startWeek: 10, endWeek: 2 }),
    ).toThrow("结束周不能早于开始周");
  });

  it("rejects control characters and overlong user text", () => {
    expect(() =>
      parseIpc(scheduleAddSchema, {
        title: `正常\u0000标题`,
        startTime: "2026-08-21T10:00:00+08:00",
        endTime: "2026-08-21T11:00:00+08:00",
        reminderOffset: 10,
        repeatRule: "none",
      }),
    ).toThrow("控制字符");
    expect(() =>
      parseIpc(scheduleAddSchema, {
        title: "x".repeat(201),
        startTime: "2026-08-21T10:00:00+08:00",
        endTime: "2026-08-21T11:00:00+08:00",
        reminderOffset: 10,
        repeatRule: "none",
      }),
    ).toThrow();
    expect(() => parseIpc(htmlSchema, "<html>\u0000</html>")).toThrow(
      "控制字符",
    );
  });

  it("accepts padded base64 and rejects malformed image data", () => {
    const valid = Buffer.alloc(12, 7).toString("base64");
    expect(parseIpc(imageBase64Schema, valid)).toBe(valid);
    expect(() =>
      parseIpc(imageBase64Schema, "not-base64-data!".repeat(2)),
    ).toThrow("图片数据格式无效");
  });

  it("accepts valid CRUD payloads and exercises the optional cross-field checks", () => {
    expect(parseIpc(schedulePatchSchema, { title: "只改标题" })).toMatchObject({
      title: "只改标题",
    });
    expect(
      parseIpc(courseAddSchema, {
        name: "课程",
        startWeek: 1,
        endWeek: 16,
        weekday: 1,
        startPeriod: 1,
        endPeriod: 2,
        color: "#4285F4",
      }),
    ).toMatchObject({ name: "课程" });
    expect(() =>
      parseIpc(courseAddSchema, {
        name: "课程",
        startWeek: 1,
        endWeek: 16,
        weekday: 1,
        startPeriod: 3,
        endPeriod: 2,
        color: "#4285F4",
      }),
    ).toThrow("结束节不能早于开始节");
    expect(() =>
      parseIpc(coursePatchSchema, { startPeriod: 3, endPeriod: 2 }),
    ).toThrow("结束节不能早于开始节");

    const exam = {
      courseName: "考试",
      date: "2026-08-21",
      startTime: "09:00",
      endTime: "11:00",
      reminderOffsets: [60],
    };
    expect(parseIpc(examAddSchema, exam)).toMatchObject(exam);
    expect(parseIpc(examPatchSchema, { courseName: "改名" })).toEqual({
      courseName: "改名",
    });
    expect(() =>
      parseIpc(examAddSchema, {
        ...exam,
        startTime: "11:00",
        endTime: "09:00",
      }),
    ).toThrow("结束时间必须晚于开始时间");

    const lab = {
      name: "实验",
      date: "2026-08-21",
      startTime: "13:00",
      endTime: "15:00",
      reminderOffsets: [],
    };
    expect(parseIpc(labAddSchema, lab)).toMatchObject(lab);
    expect(parseIpc(labPatchSchema, { name: "改名" })).toEqual({
      name: "改名",
    });
    expect(() =>
      parseIpc(labAddSchema, { ...lab, startTime: "15:00", endTime: "13:00" }),
    ).toThrow("结束时间必须晚于开始时间");

    expect(
      parseIpc(gradeAddSchema, {
        courseName: "成绩",
        semester: "2026-2027-1",
        credit: 3,
        gradePoint: 4,
        score: 95,
        isDegreeCourse: true,
      }),
    ).toMatchObject({ credit: 3 });
    expect(parseIpc(gradePatchSchema, { score: 88 })).toEqual({ score: 88 });
    expect(
      parseIpc(gradePageQuerySchema, {
        semester: "2026-2027-1",
        page: 1,
        pageSize: 20,
      }),
    ).toMatchObject({ degreeOnly: false, pageSize: 20 });
    expect(() =>
      parseIpc(gradePageQuerySchema, { page: 1, pageSize: 25 }),
    ).toThrow();
    expect(
      parseIpc(formulaSchema, {
        name: "默认",
        formula: "SUM(credit * gradePoint) / SUM(credit)",
        isDefault: true,
      }),
    ).toMatchObject({ isDefault: true });
    expect(
      parseIpc(periodConfigSchema, [
        {
          index: 1,
          startTime: "08:00",
          endTime: "08:45",
          breakAfter: 10,
          isLab: false,
          reminderOffset: 10,
        },
      ]),
    ).toHaveLength(1);
    expect(() =>
      parseIpc(periodConfigSchema, [
        {
          index: 1,
          startTime: "08:00",
          endTime: "08:45",
          breakAfter: 10,
          isLab: false,
          reminderOffset: 10,
        },
        {
          index: 1,
          startTime: "09:00",
          endTime: "08:45",
          breakAfter: 10,
          isLab: false,
          reminderOffset: 10,
        },
      ]),
    ).toThrow();
    expect(
      parseIpc(notificationPayloadSchema, {
        title: "系统",
        body: "内容",
        source: "system",
        refId: "default",
      }),
    ).toMatchObject({ source: "system" });
  });

  it("validates ACM document, compiler, and runner boundaries", () => {
    expect(parseIpc(acmTemplateSchema, "basic-io")).toBe("basic-io");
    expect(parseIpc(acmDocumentScopeSchema, undefined)).toBe("workbench");
    expect(parseIpc(acmDocumentScopeSchema, "diff-candidate")).toBe(
      "diff-candidate",
    );
    const documentId = "11111111-1111-4111-8111-111111111111";
    const document = {
      documentId,
      filePath: null,
      content: "int main() {}",
      lineEnding: "lf",
      expectedFingerprint: null,
      force: false,
    } as const;
    expect(parseIpc(acmDocumentSaveSchema, document)).toMatchObject({
      documentId,
      lineEnding: "lf",
    });
    expect(
      parseIpc(acmCompilerSelectionSchema, { mode: "auto", path: null }),
    ).toEqual({ mode: "auto", path: null });
    expect(
      parseIpc(acmRunnerStartSchema, {
        documentId,
        source: "int main() {}",
        stdin: "",
        mode: "run",
      }),
    ).toMatchObject({ mode: "run" });
    expect(
      parseIpc(acmDiffStartSchema, {
        reference: "int main() {}",
        candidate: "int main() {}",
        stdin: "",
      }),
    ).toEqual({
      reference: "int main() {}",
      candidate: "int main() {}",
      stdin: "",
    });
    expect(() => parseIpc(acmTemplateSchema, "shell")).toThrow();
    expect(() =>
      parseIpc(acmCompilerSelectionSchema, {
        mode: "user",
        path: "C:\\toolchain\\g++.exe",
      }),
    ).not.toThrow();
    expect(() =>
      parseIpc(acmRunnerStartSchema, {
        documentId,
        source: "x".repeat(2 * 1024 * 1024 + 1),
        stdin: "",
        mode: "compile",
      }),
    ).toThrow();
    const oversizedCandidate = "x".repeat(2 * 1024 * 1024 + 1);
    expect(
      parseIpc(acmDocumentSaveSchema, {
        ...document,
        content: oversizedCandidate,
        expectedFingerprint: {
          bytes: Buffer.byteLength(oversizedCandidate, "utf8"),
          mtimeMs: 0,
          sha256: "0".repeat(64),
        },
      }),
    ).toMatchObject({ content: oversizedCandidate });
    expect(
      parseIpc(acmDiffStartSchema, {
        reference: "",
        candidate: oversizedCandidate,
        stdin: "",
      }),
    ).toMatchObject({ candidate: oversizedCandidate });
    expect(() =>
      parseIpc(acmDiffStartSchema, {
        reference: oversizedCandidate,
        candidate: "",
        stdin: "",
      }),
    ).toThrow();
  });
});
