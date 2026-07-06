// 共享类型定义：主进程与渲染进程共用
// 这里集中定义数据模型、IPC 通道常量与 API 契约，避免两端类型不一致
// 数据库列名采用 snake_case，TypeScript 接口字段采用 camelCase，由 Repository 负责转换

// ==================== 通用 ====================

/** 数据库实体的公共字段 */
export interface BaseEntity {
  id: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** 统一 IPC 调用结果，便于渲染进程判错 */
export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ==================== 日程 Schedule ====================

/**
 * 重复规则：对应 schedule_items.repeat_rule 列
 * 存储值采用英文枚举，语义对应：none=无 / daily=每日 / weekly=每周 / monthly=每月
 */
export type RepeatRule = 'none' | 'daily' | 'weekly' | 'monthly';

export interface Schedule extends BaseEntity {
  title: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  /** 提前提醒的分钟数 */
  reminderOffset: number;
  repeatRule: RepeatRule;
}

// ==================== 课程表 Timetable ====================

/** 节次配置：定义一天中的每一节起止时间，对应 period_config 表 */
export interface PeriodConfig {
  /** 节次序号，从 1 开始（主键） */
  index: number;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  /** 该节结束后休息分钟数 */
  breakAfter: number;
  /** 是否为实验节次 */
  isLab: boolean;
  /** 提前提醒的分钟数 */
  reminderOffset: number;
}

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // 周一到周日

export interface Course extends BaseEntity {
  name: string;
  teacher?: string;
  location?: string;
  startWeek: number;
  endWeek: number;
  weekday: Weekday;
  startPeriod: number;
  endPeriod: number;
  /** 十六进制色值，如 "#4285F4" */
  color: string;
}

/**
 * 解析后的课程：与 Course 类似但字段可选，便于 DOM 与 OCR 结果冲突合并。
 * 解析器输出与 OCR 输出均使用此类型，ConflictResolver 合并后再补齐必填字段写库。
 */
export interface ParsedCourse {
  name?: string;
  teacher?: string;
  location?: string;
  startWeek?: number;
  endWeek?: number;
  weekday?: Weekday;
  startPeriod?: number;
  endPeriod?: number;
  color?: string;
}

// ==================== 考试 Exam ====================

export interface Exam extends BaseEntity {
  courseName: string;
  /** 考试日期，YYYY-MM-DD */
  date: string;
  /** 开始时间，HH:mm */
  startTime: string;
  /** 结束时间，HH:mm */
  endTime: string;
  location?: string;
  seat?: string;
  notes?: string;
  /** 提前提醒的分钟数列表，如 [10080, 4320, 1440]（一周/三天/一天） */
  reminderOffsets: number[];
}

/**
 * 解析后的考试：字段全部可选，便于 DOM 与 OCR 结果冲突合并。
 * 解析器输出与 OCR 输出均使用此类型，ExamConflictResolver 合并后补齐必填字段写库。
 */
export interface ParsedExam {
  courseName?: string;
  /** YYYY-MM-DD */
  date?: string;
  /** HH:mm */
  startTime?: string;
  /** HH:mm */
  endTime?: string;
  location?: string;
  seat?: string;
  notes?: string;
}

// ==================== 实验 Lab ====================

/**
 * 实验提醒：表示一次实验课安排
 * 注意：与"实验作业"不同，这里聚焦实验课的时间与地点提醒
 */
export interface Lab extends BaseEntity {
  name: string;
  /** 实验日期，YYYY-MM-DD */
  date: string;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  location?: string;
  instructor?: string;
  notes?: string;
  /** 提前提醒的分钟数列表 */
  reminderOffsets: number[];
}

/**
 * 解析后的实验：字段全部可选，便于 DOM 与 OCR 结果冲突合并。
 * 解析器输出与 OCR 输出均使用此类型，LabConflictResolver 合并后补齐必填字段写库。
 */
export interface ParsedLab {
  name?: string;
  /** YYYY-MM-DD */
  date?: string;
  /** HH:mm */
  startTime?: string;
  /** HH:mm */
  endTime?: string;
  location?: string;
  instructor?: string;
  notes?: string;
}

// ==================== 成绩 Grade ====================

export interface Grade extends BaseEntity {
  courseName: string;
  /** 学期，如 "2025-2026-1" */
  semester: string;
  credit: number;
  /** 绩点 */
  gradePoint: number;
  /** 百分制分数，可能为空（等级制） */
  score?: number;
  /** 是否学位课 */
  isDegreeCourse: boolean;
}

// ==================== 绩点公式 GpaFormula ====================

/**
 * GPA 计算公式记录，对应 gpa_formula 表
 * formula 字段为表达式字符串，可用变量：score、credit、gradePoint
 */
export interface GpaFormula extends BaseEntity {
  name: string;
  /** 表达式，如 "SUM(credit * grade_point) / SUM(credit)" */
  formula: string;
  isDefault: boolean;
}

// ==================== 通知 ====================

/** 通知来源类型，对应 NotificationPayload.source */
export type NotificationSource = 'schedule' | 'timetable' | 'exam' | 'lab' | 'system';

export interface NotificationPayload {
  title: string;
  body: string;
  source: NotificationSource;
  /** 关联实体 ID，用于点击跳转（可选） */
  refId?: string;
}

/** 免打扰配置 */
export interface DndConfig {
  enabled: boolean;
  /** 开始时间，HH:mm */
  startTime: string;
  /** 结束时间，HH:mm */
  endTime: string;
}

/** 通知历史记录 */
export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  source: string;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** false 表示被 DnD 拦截未弹出 */
  delivered: boolean;
}

// ==================== 主题 ====================

/**
 * 主题模式：
 * - system: 跟随系统暗黑/亮色
 * - light: 强制亮色
 * - dark: 强制暗色
 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 实际生效的主题（解析 system 后的结果） */
export type ResolvedTheme = 'light' | 'dark';

// ==================== 外观 ====================

/** 材质模式：none=标准 / acrylic=亚克力（Win11 原生，其他系统 CSS 降级） */
export type MaterialMode = 'none' | 'acrylic';

/** 外观配置，由 AppearanceService 持久化并广播给渲染进程 */
export interface AppearanceConfig {
  material: MaterialMode;
  /** 背景图文件名（存储在 userData/backgrounds/），null 表示无背景图 */
  backgroundImage: string | null;
  /** 模糊度 0-50px */
  blurRadius: number;
  /** 清晰度 0-100（百分比，控制背景图 opacity） */
  clarity: number;
  /** 运行时检测：当前系统是否支持原生亚克力效果 */
  acrylicSupported: boolean;
}

// ==================== IPC 通道常量 ====================
// 命名规范：<域>:<资源>:<动作>
// 注意：timetable 通道对应 courses 表，period 通道对应 period_config 表

export const IPC_CHANNELS = {
  // 日程
  SCHEDULE_LIST: 'db:schedule:list',
  SCHEDULE_ADD: 'db:schedule:add',
  SCHEDULE_UPDATE: 'db:schedule:update',
  SCHEDULE_REMOVE: 'db:schedule:remove',
  // 课程表（对应 courses 表）
  TIMETABLE_LIST: 'db:timetable:list',
  TIMETABLE_ADD: 'db:timetable:add',
  TIMETABLE_UPDATE: 'db:timetable:update',
  TIMETABLE_REMOVE: 'db:timetable:remove',
  // 考试
  EXAM_LIST: 'db:exam:list',
  EXAM_ADD: 'db:exam:add',
  EXAM_UPDATE: 'db:exam:update',
  EXAM_REMOVE: 'db:exam:remove',
  // 实验
  LAB_LIST: 'db:lab:list',
  LAB_ADD: 'db:lab:add',
  LAB_UPDATE: 'db:lab:update',
  LAB_REMOVE: 'db:lab:remove',
  // 成绩
  GRADE_LIST: 'db:grade:list',
  GRADE_ADD: 'db:grade:add',
  GRADE_UPDATE: 'db:grade:update',
  GRADE_REMOVE: 'db:grade:remove',
  // 公式
  FORMULA_GET: 'db:formula:get',
  FORMULA_SAVE: 'db:formula:save',
  FORMULA_LIST: 'db:formula:list',
  // 节次配置（对应 period_config 表）
  PERIOD_CONFIG_GET: 'db:period:get',
  PERIOD_CONFIG_SAVE: 'db:period:save',
  // 课程表导入（嵌入式浏览器 + DOM/OCR 解析）
  TIMETABLE_OPEN_BROWSER: 'timetable:import:openBrowser',
  TIMETABLE_CLOSE_BROWSER: 'timetable:import:closeBrowser',
  TIMETABLE_EXTRACT_DOM: 'timetable:import:extractDom',
  TIMETABLE_CAPTURE_PAGE: 'timetable:import:capturePage',
  TIMETABLE_PARSE_DOM: 'timetable:import:parseDom',
  TIMETABLE_RUN_OCR: 'timetable:import:runOcr',
  // 考试导入（复用嵌入式浏览器，独立 DOM/OCR 解析通道）
  EXAM_PARSE_DOM: 'exam:import:parseDom',
  EXAM_RUN_OCR: 'exam:import:runOcr',
  // 实验导入（复用嵌入式浏览器，独立 DOM/OCR 解析通道）
  LAB_PARSE_DOM: 'lab:import:parseDom',
  LAB_RUN_OCR: 'lab:import:runOcr',
  // 通知
  NOTIFY_SEND: 'notify:send',
  NOTIFY_SET_DND: 'notify:setDnd',
  NOTIFY_GET_DND: 'notify:getDnd',
  NOTIFY_GET_HISTORY: 'notify:getHistory',
  NOTIFY_CLEAR_HISTORY: 'notify:clearHistory',
  // 数据导入导出
  DATA_EXPORT: 'data:export',
  DATA_IMPORT: 'data:import',
  DATA_PICK_EXPORT_PATH: 'data:pickExportPath',
  DATA_PICK_IMPORT_PATH: 'data:pickImportPath',
  // 更新
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',
  // 窗口控制（自定义标题栏按钮 + 最小化到托盘）
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  WINDOW_ON_MAXIMIZE_CHANGE: 'window:onMaximizeChange',
  // 主题（跟随系统 + 手动切换）
  THEME_GET: 'theme:get',
  THEME_SET: 'theme:set',
  THEME_GET_RESOLVED: 'theme:getResolved',
  THEME_ON_CHANGE: 'theme:onChange',
  // 外观（材质模式 + 背景图 + 模糊度 + 清晰度）
  APPEARANCE_GET: 'appearance:get',
  APPEARANCE_SET_MATERIAL: 'appearance:setMaterial',
  APPEARANCE_UPLOAD_BG: 'appearance:uploadBackground',
  APPEARANCE_CLEAR_BG: 'appearance:clearBackground',
  APPEARANCE_SET_BLUR: 'appearance:setBlur',
  APPEARANCE_SET_CLARITY: 'appearance:setClarity',
  APPEARANCE_ON_CHANGE: 'appearance:onChange',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ==================== 渲染进程 API 形状 ====================
// preload 通过 contextBridge 暴露的 window.api 类型契约

export interface RendererApi {
  schedule: {
    list: () => Promise<IpcResult<Schedule[]>>;
    add: (item: Omit<Schedule, keyof BaseEntity>) => Promise<IpcResult<Schedule>>;
    update: (id: string, patch: Partial<Schedule>) => Promise<IpcResult<Schedule>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
  };
  timetable: {
    list: () => Promise<IpcResult<Course[]>>;
    add: (item: Omit<Course, keyof BaseEntity>) => Promise<IpcResult<Course>>;
    update: (id: string, patch: Partial<Course>) => Promise<IpcResult<Course>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
  };
  exam: {
    list: () => Promise<IpcResult<Exam[]>>;
    add: (item: Omit<Exam, keyof BaseEntity>) => Promise<IpcResult<Exam>>;
    update: (id: string, patch: Partial<Exam>) => Promise<IpcResult<Exam>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
  };
  lab: {
    list: () => Promise<IpcResult<Lab[]>>;
    add: (item: Omit<Lab, keyof BaseEntity>) => Promise<IpcResult<Lab>>;
    update: (id: string, patch: Partial<Lab>) => Promise<IpcResult<Lab>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
  };
  grade: {
    list: () => Promise<IpcResult<Grade[]>>;
    add: (item: Omit<Grade, keyof BaseEntity>) => Promise<IpcResult<Grade>>;
    update: (id: string, patch: Partial<Grade>) => Promise<IpcResult<Grade>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
  };
  formula: {
    get: (id: string) => Promise<IpcResult<GpaFormula | null>>;
    save: (formula: Omit<GpaFormula, keyof BaseEntity>) => Promise<IpcResult<GpaFormula>>;
    list: () => Promise<IpcResult<GpaFormula[]>>;
  };
  periodConfig: {
    get: () => Promise<IpcResult<PeriodConfig[]>>;
    save: (config: PeriodConfig[]) => Promise<IpcResult<boolean>>;
  };
  importBrowser: {
    /** 打开嵌入式浏览器子窗口；promise 在子窗口关闭后 resolve */
    openBrowser: () => Promise<IpcResult<boolean>>;
    closeBrowser: () => Promise<IpcResult<boolean>>;
    /** 提取子窗口当前页 DOM（缓存于主进程，浏览器关闭后仍可调用） */
    extractDom: () => Promise<IpcResult<string>>;
    /** 截图子窗口当前页，返回 base64 字符串 */
    capturePage: () => Promise<IpcResult<string>>;
    /** 用 cheerio 解析 HTML 为课程列表 */
    parseDom: (html: string) => Promise<IpcResult<ParsedCourse[]>>;
    /** 对 base64 图片执行 OCR 识别并解析为课程列表 */
    runOcr: (imageBase64: string) => Promise<IpcResult<ParsedCourse[]>>;
  };
  examImport: {
    /** 用 cheerio 解析 HTML 为考试列表 */
    parseDomForExams: (html: string) => Promise<IpcResult<ParsedExam[]>>;
    /** 对 base64 图片执行 OCR 识别并解析为考试列表 */
    runOcrForExams: (imageBase64: string) => Promise<IpcResult<ParsedExam[]>>;
  };
  labImport: {
    /** 用 cheerio 解析 HTML 为实验列表 */
    parseDomForLabs: (html: string) => Promise<IpcResult<ParsedLab[]>>;
    /** 对 base64 图片执行 OCR 识别并解析为实验列表 */
    runOcrForLabs: (imageBase64: string) => Promise<IpcResult<ParsedLab[]>>;
  };
  notify: {
    send: (payload: NotificationPayload) => Promise<IpcResult<boolean>>;
    setDnd: (config: DndConfig) => Promise<IpcResult<boolean>>;
    getDnd: () => Promise<IpcResult<DndConfig>>;
    getHistory: () => Promise<IpcResult<NotificationRecord[]>>;
    clearHistory: () => Promise<IpcResult<boolean>>;
  };
  data: {
    export: (filePath: string) => Promise<IpcResult<boolean>>;
    import: (filePath: string) => Promise<IpcResult<boolean>>;
    pickExportPath: () => Promise<IpcResult<string | null>>;
    pickImportPath: () => Promise<IpcResult<string | null>>;
  };
  update: {
    checkManual: () => Promise<IpcResult<boolean>>;
    installUpdate: () => Promise<IpcResult<boolean>>;
    onUpdateStatus: (callback: (status: string) => void) => void;
  };
  window: {
    minimize: () => Promise<IpcResult<boolean>>;
    maximize: () => Promise<IpcResult<boolean>>;
    close: () => Promise<IpcResult<boolean>>;
    isMaximized: () => Promise<IpcResult<boolean>>;
    onMaximizeChange: (callback: (maximized: boolean) => void) => void;
  };
  theme: {
    get: () => Promise<IpcResult<ThemeMode>>;
    set: (mode: ThemeMode) => Promise<IpcResult<boolean>>;
    getResolved: () => Promise<IpcResult<ResolvedTheme>>;
    onChange: (callback: (resolved: ResolvedTheme) => void) => void;
  };
  appearance: {
    get: () => Promise<IpcResult<AppearanceConfig>>;
    setMaterial: (mode: MaterialMode) => Promise<IpcResult<boolean>>;
    uploadBackground: (filePath: string) => Promise<IpcResult<string>>;
    clearBackground: () => Promise<IpcResult<boolean>>;
    setBlur: (value: number) => Promise<IpcResult<boolean>>;
    setClarity: (value: number) => Promise<IpcResult<boolean>>;
    onChange: (callback: (config: AppearanceConfig) => void) => void;
  };
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
