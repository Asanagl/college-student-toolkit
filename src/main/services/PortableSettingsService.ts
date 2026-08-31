// 统一管理可跨设备迁移的设置快照。
// 窗口坐标、登录会话和缓存仍由各自服务单独保存，避免把机器状态带到另一台电脑。
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type {
  LegacyPortableSettings,
  PortableSettings,
} from "../../shared/types";
import { isSafeImageFileName } from "./ImageValidation";

const DEFAULT_SETTINGS: PortableSettings = {
  portableSettingsVersion: 2,
  themeMode: "system",
  timetable: { semesterStart: null },
  dnd: { enabled: false, startTime: "22:00", endTime: "08:00" },
  notificationHistory: [],
  appearance: {
    material: "none",
    backgroundImage: null,
    blurRadius: 0,
    clarity: 100,
  },
  acm: { enabled: true, noticeDismissedVersion: null },
};

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return (
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day
    );
  }, "日期无效");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const notificationRecord = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(200),
  body: z.string().max(2000),
  source: z.string().max(32),
  timestamp: z.string().datetime({ offset: true }),
  delivered: z.boolean(),
  summarized: z.boolean().optional(),
});
const settingsFields = {
  themeMode: z.enum(["system", "light", "dark"]),
  timetable: z.object({ semesterStart: calendarDate.nullable() }),
  dnd: z.object({ enabled: z.boolean(), startTime: time, endTime: time }),
  notificationHistory: z.array(notificationRecord).max(100),
  appearance: z.object({
    material: z.enum(["none", "acrylic"]),
    backgroundImage: z
      .string()
      .max(128)
      .refine((value) => path.basename(value) === value)
      .nullable(),
    blurRadius: z.number().int().min(0).max(50),
    clarity: z.number().int().min(0).max(100),
  }),
};
const settingsV1Schema = z.object({
  portableSettingsVersion: z.literal(1),
  ...settingsFields,
});
const settingsV2Schema = z.object({
  portableSettingsVersion: z.literal(2),
  ...settingsFields,
  acm: z.object({
    enabled: z.boolean(),
    noticeDismissedVersion: z.string().trim().max(32).nullable().optional(),
  }),
});

function cloneSettings(settings: PortableSettings): PortableSettings {
  return JSON.parse(JSON.stringify(settings)) as PortableSettings;
}

function isSettings(value: unknown): value is PortableSettings {
  return settingsV2Schema.safeParse(value).success;
}

function migrateLegacySettings(value: unknown): PortableSettings | null {
  const parsed = settingsV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const legacy = parsed.data as LegacyPortableSettings;
  return {
    ...legacy,
    portableSettingsVersion: 2,
    acm: { enabled: true, noticeDismissedVersion: null },
  };
}

export class PortableSettingsService {
  private static instance: PortableSettingsService | null = null;
  private initialized = false;
  private settings: PortableSettings = cloneSettings(DEFAULT_SETTINGS);
  private filePath = "";

  private constructor() {}

  static getInstance(): PortableSettingsService {
    if (!PortableSettingsService.instance) {
      PortableSettingsService.instance = new PortableSettingsService();
    }
    return PortableSettingsService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.filePath = path.join(
      app.getPath("userData"),
      "portable-settings.json",
    );
    this.settings = this.readFromDisk();
    this.initialized = true;
  }

  get(): PortableSettings {
    return cloneSettings(this.settings);
  }

  getFilePath(): string {
    return (
      this.filePath ||
      path.join(app.getPath("userData"), "portable-settings.json")
    );
  }

  update(patch: Partial<PortableSettings>): PortableSettings {
    const current = this.settings;
    const next: PortableSettings = {
      ...current,
      ...patch,
      timetable: { ...current.timetable, ...patch.timetable },
      dnd: { ...current.dnd, ...patch.dnd },
      appearance: { ...current.appearance, ...patch.appearance },
      acm: { ...current.acm, ...patch.acm },
      notificationHistory: patch.notificationHistory
        ? patch.notificationHistory.slice(0, 100)
        : current.notificationHistory,
    };
    this.writeToDisk(next);
    // 先完成原子替换，避免磁盘写入失败时内存状态先于持久化数据漂移。
    this.settings = next;
    return this.get();
  }

  getAcmNoticeDismissedVersion(): string | null {
    return this.settings.acm.noticeDismissedVersion ?? null;
  }

  setAcmNoticeDismissedVersion(version: string | null): PortableSettings {
    return this.update({
      acm: { ...this.settings.acm, noticeDismissedVersion: version },
    });
  }

  replace(next: PortableSettings | LegacyPortableSettings): PortableSettings {
    const replacement = isSettings(next)
      ? cloneSettings(next)
      : migrateLegacySettings(next);
    if (!replacement) throw new Error("便携设置格式无效");
    this.writeToDisk(replacement);
    this.settings = replacement;
    return this.get();
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }

  private readFromDisk(): PortableSettings {
    if (!fs.existsSync(this.getFilePath())) {
      const migrated = this.readLegacySettings();
      this.writeToDisk(migrated);
      return migrated;
    }
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.getFilePath(), "utf8"),
      );
      if (isSettings(parsed)) return this.normalize(parsed);
      const migrated = migrateLegacySettings(parsed);
      if (migrated) {
        const normalized = this.normalize(migrated);
        this.writeToDisk(normalized);
        return normalized;
      }
      throw new Error("设置结构不完整");
    } catch (error) {
      if (fs.existsSync(this.getFilePath())) {
        const suffix = `.invalid.${Date.now()}`;
        fs.renameSync(this.getFilePath(), `${this.getFilePath()}${suffix}`);
      }
      console.warn(`[PortableSettingsService] 设置已隔离：${String(error)}`);
      const defaults = cloneSettings(DEFAULT_SETTINGS);
      this.writeToDisk(defaults);
      return defaults;
    }
  }

  private readLegacySettings(): PortableSettings {
    const result = cloneSettings(DEFAULT_SETTINGS);
    const read = (name: string): Record<string, unknown> => {
      try {
        return JSON.parse(
          fs.readFileSync(
            path.join(app.getPath("userData"), `${name}.json`),
            "utf8",
          ),
        ) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const theme = read("theme-preference");
    const timetable = read("timetable");
    const notification = read("notification");
    const appearance = read("appearance-preference");
    if (
      theme.mode === "light" ||
      theme.mode === "dark" ||
      theme.mode === "system"
    ) {
      result.themeMode = theme.mode;
    }
    if (
      typeof timetable.semesterStart === "string" &&
      calendarDate.safeParse(timetable.semesterStart).success
    ) {
      result.timetable.semesterStart =
        timetable.semesterStart === "2025-09-01"
          ? null
          : timetable.semesterStart;
    }
    const legacyDnd = notification.dnd;
    if (legacyDnd && typeof legacyDnd === "object") {
      const parsedDnd = settingsV2Schema.shape.dnd.safeParse({
        ...result.dnd,
        ...legacyDnd,
      });
      if (parsedDnd.success) result.dnd = parsedDnd.data;
    }
    if (Array.isArray(notification.notificationHistory)) {
      result.notificationHistory = notification.notificationHistory
        .filter((item) => notificationRecord.safeParse(item).success)
        .slice(0, 100) as PortableSettings["notificationHistory"];
    }
    if (appearance.material === "none" || appearance.material === "acrylic")
      result.appearance.material = appearance.material;
    if (
      typeof appearance.backgroundImage === "string" &&
      isSafeImageFileName(appearance.backgroundImage)
    )
      result.appearance.backgroundImage = appearance.backgroundImage;
    if (
      typeof appearance.blurRadius === "number" &&
      Number.isInteger(appearance.blurRadius)
    )
      result.appearance.blurRadius = Math.max(
        0,
        Math.min(50, appearance.blurRadius),
      );
    if (
      typeof appearance.clarity === "number" &&
      Number.isInteger(appearance.clarity)
    )
      result.appearance.clarity = Math.max(
        0,
        Math.min(100, appearance.clarity),
      );
    return result;
  }

  private normalize(value: PortableSettings): PortableSettings {
    const result = cloneSettings(DEFAULT_SETTINGS);
    result.themeMode = value.themeMode;
    result.timetable = { semesterStart: value.timetable.semesterStart ?? null };
    result.dnd = { ...result.dnd, ...value.dnd };
    result.notificationHistory = value.notificationHistory.slice(0, 100);
    result.appearance = { ...result.appearance, ...value.appearance };
    result.acm = {
      enabled: value.acm?.enabled ?? true,
      noticeDismissedVersion: value.acm?.noticeDismissedVersion ?? null,
    };
    if (
      result.appearance.backgroundImage &&
      !isSafeImageFileName(result.appearance.backgroundImage)
    ) {
      result.appearance.backgroundImage = null;
    }
    return result;
  }

  private writeToDisk(value: PortableSettings): void {
    const target = this.getFilePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temp, target);
  }
}

export const portableSettingsService = PortableSettingsService.getInstance();
