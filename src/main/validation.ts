// IPC 运行时校验集中在主进程边界，避免仅依赖 TypeScript 类型保护不可信的渲染输入。
import { z } from "zod";

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
      return true;
  }
  return false;
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !hasControlCharacters(value),
      "文本包含不允许的控制字符",
    );
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !hasControlCharacters(value), "文本包含不允许的控制字符")
    .optional();
const id = z.string().uuid();
function isCalendarDate(value: string): boolean {
  const parts = value.split("-").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part)))
    return false;
  const [year, month, day] = parts;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, "日期无效");

const date = calendarDateSchema;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const isoDateTime = z.string().datetime({ offset: true });
const finiteNumber = z.number().finite();

const scheduleFields = z.object({
  title: text(200),
  startTime: isoDateTime,
  endTime: isoDateTime,
  reminderOffset: z.number().int().min(0).max(10080),
  repeatRule: z.enum(["none", "daily", "weekly", "monthly"]),
});
export const scheduleAddSchema = scheduleFields.superRefine(
  (value, context) => {
    if (
      new Date(value.endTime).getTime() <= new Date(value.startTime).getTime()
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "结束时间必须晚于开始时间",
      });
    }
  },
);
export const schedulePatchSchema = scheduleFields
  .partial()
  .superRefine((value, context) => {
    if (
      value.startTime &&
      value.endTime &&
      new Date(value.endTime).getTime() <= new Date(value.startTime).getTime()
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "结束时间必须晚于开始时间",
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, "更新内容不能为空");

const courseFields = z.object({
  name: text(200),
  teacher: optionalText(100),
  location: optionalText(200),
  startWeek: z.number().int().min(1).max(64),
  endWeek: z.number().int().min(1).max(64),
  weekday: z.number().int().min(1).max(7),
  startPeriod: z.number().int().min(1).max(32),
  endPeriod: z.number().int().min(1).max(32),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export const courseAddSchema = courseFields.superRefine((value, context) => {
  if (value.endWeek < value.startWeek)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endWeek"],
      message: "结束周不能早于开始周",
    });
  if (value.endPeriod < value.startPeriod)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endPeriod"],
      message: "结束节不能早于开始节",
    });
});
export const coursePatchSchema = courseFields
  .partial()
  .superRefine((value, context) => {
    if (
      value.startWeek !== undefined &&
      value.endWeek !== undefined &&
      value.endWeek < value.startWeek
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endWeek"],
        message: "结束周不能早于开始周",
      });
    }
    if (
      value.startPeriod !== undefined &&
      value.endPeriod !== undefined &&
      value.endPeriod < value.startPeriod
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endPeriod"],
        message: "结束节不能早于开始节",
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, "更新内容不能为空");

const reminderOffsets = z.array(z.number().int().min(0).max(10080)).max(16);
const examFields = z.object({
  courseName: text(200),
  date,
  startTime: time,
  endTime: time,
  location: optionalText(200),
  seat: optionalText(100),
  notes: optionalText(2000),
  reminderOffsets,
});
export const examAddSchema = examFields.superRefine((value, context) => {
  if (value.endTime <= value.startTime)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endTime"],
      message: "结束时间必须晚于开始时间",
    });
});
export const examPatchSchema = examFields
  .partial()
  .superRefine((value, context) => {
    if (value.startTime && value.endTime && value.endTime <= value.startTime) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "结束时间必须晚于开始时间",
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, "更新内容不能为空");

const labFields = z.object({
  name: text(200),
  date,
  startTime: time,
  endTime: time,
  location: optionalText(200),
  instructor: optionalText(100),
  notes: optionalText(2000),
  reminderOffsets,
});
export const labAddSchema = labFields.superRefine((value, context) => {
  if (value.endTime <= value.startTime)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endTime"],
      message: "结束时间必须晚于开始时间",
    });
});
export const labPatchSchema = labFields
  .partial()
  .superRefine((value, context) => {
    if (value.startTime && value.endTime && value.endTime <= value.startTime) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "结束时间必须晚于开始时间",
      });
    }
  })
  .refine((value) => Object.keys(value).length > 0, "更新内容不能为空");

export const gradeAddSchema = z.object({
  courseName: text(200),
  semester: text(32),
  credit: finiteNumber.refine(
    (value) => value > 0 && value <= 100,
    "学分范围无效",
  ),
  gradePoint: finiteNumber.refine(
    (value) => value >= 0 && value <= 10,
    "绩点范围无效",
  ),
  score: finiteNumber.min(0).max(100).optional(),
  isDegreeCourse: z.boolean(),
});
export const gradePatchSchema = gradeAddSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "更新内容不能为空");
export const gradePageQuerySchema = z.object({
  semester: optionalText(32),
  degreeOnly: z.boolean().optional().default(false),
  page: z.number().int().min(1).max(100000),
  pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]),
});

export const formulaSchema = z.object({
  id: z.union([id, z.literal("default")]).optional(),
  name: text(100),
  formula: text(1000),
  isDefault: z.boolean(),
});

export const periodConfigSchema = z
  .array(
    z.object({
      index: z.number().int().min(1).max(32),
      startTime: time,
      endTime: time,
      breakAfter: z.number().int().min(0).max(240),
      isLab: z.boolean(),
      reminderOffset: z.number().int().min(0).max(10080),
    }),
  )
  .min(1)
  .max(32)
  .superRefine((values, context) => {
    const indexes = new Set<number>();
    values.forEach((value, index) => {
      if (indexes.has(value.index))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "index"],
          message: "节次序号重复",
        });
      indexes.add(value.index);
      if (value.endTime <= value.startTime)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "endTime"],
          message: "结束时间必须晚于开始时间",
        });
    });
  });

export const dndSchema = z.object({
  enabled: z.boolean(),
  startTime: time,
  endTime: time,
});
export const notificationPayloadSchema = z.object({
  title: text(200),
  body: text(2000),
  source: z.enum(["schedule", "timetable", "exam", "lab", "system"]),
  refId: z.union([id, z.literal("default")]).optional(),
});
export const htmlSchema = z
  .string()
  .max(8 * 1024 * 1024)
  .refine((value) => !hasControlCharacters(value), "HTML 包含不允许的控制字符");

export const imageBase64Schema = z
  .string()
  .min(16)
  .max(28 * 1024 * 1024)
  .refine((value) => {
    const normalized = value.replace(/[\r\n\t ]/g, "");
    if (
      normalized.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        normalized,
      )
    )
      return false;
    try {
      return Buffer.from(normalized, "base64").length > 0;
    } catch {
      return false;
    }
  }, "图片数据格式无效");
export const themeModeSchema = z.enum(["system", "light", "dark"]);
export const materialModeSchema = z.enum(["none", "acrylic"]);
export const semesterStartSchema = date.nullable();
export const tokenSchema = id;
export const formulaIdSchema = z.union([id, z.literal("default")]);
export const blurSchema = z.number().int().min(0).max(50);
export const claritySchema = z.number().int().min(0).max(100);

const acmDocumentIdSchema = z.string().uuid();
const acmFingerprintSchema = z.object({
  bytes: z.number().int().nonnegative().safe(),
  mtimeMs: z.number().finite().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const acmTemplateSchema = z.enum(["blank", "basic-io", "stl"]);
export const acmDocumentScopeSchema = z
  .enum(["workbench", "diff-reference", "diff-candidate"])
  .default("workbench");
export const acmDocumentSaveSchema = z.object({
  documentId: acmDocumentIdSchema,
  filePath: z.string().trim().max(1024).nullable(),
  content: z.string(),
  lineEnding: z.enum(["crlf", "lf", "cr"]),
  expectedFingerprint: acmFingerprintSchema.nullable(),
  force: z.boolean(),
});
export const acmDocumentReleaseSchema = acmDocumentIdSchema;
export const acmExternalDocumentSchema = z.object({
  documentId: acmDocumentIdSchema,
  filePath: z.string().trim().max(1024).nullable(),
  savedFingerprint: acmFingerprintSchema.nullable(),
});
export const acmCompilerSelectionSchema = z.object({
  mode: z.enum(["auto", "user", "builtin"]),
  path: z.string().trim().max(1024).nullable(),
});
export const acmRunnerStartSchema = z.object({
  documentId: acmDocumentIdSchema,
  source: z.string().max(2 * 1024 * 1024),
  stdin: z.string().max(256 * 1024),
  mode: z.enum(["compile", "run"]),
});
/** 对拍输入边界；标准程序有限长，待测程序源码不设输入上限。 */
export const acmDiffStartSchema = z.object({
  reference: z.string().max(2 * 1024 * 1024),
  // 对拍面板的待测源码按用户要求不设置输入长度上限；运行时仍受
  // 编译/运行超时、输出和临时目录限制保护。
  candidate: z.string(),
  stdin: z.string().max(256 * 1024),
});

export class IpcValidationError extends Error {
  readonly code = "VALIDATION_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "IpcValidationError";
  }
}

export function parseIpc<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new IpcValidationError(issue?.message ?? "输入数据无效");
  }
  return result.data;
}
