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
  errorCode?: IpcErrorCode;
}

/** 由主进程返回的稳定错误码；具体文案可随语言包变化。 */
export type IpcErrorCode =
  | "VALIDATION_FAILED"
  | "BACKUP_BUSY"
  | "BACKUP_INVALID"
  | "BACKUP_CORRUPT"
  | "BACKUP_TOO_NEW"
  | "BACKUP_EXPIRED"
  | "RESTORE_FAILED_ROLLED_BACK"
  | "RESTORE_FAILED_RECOVERY_REQUIRED"
  | "OCR_COMPONENT_MISSING"
  | "OCR_COMPONENT_INVALID"
  | "OCR_DOWNLOAD_FAILED"
  | "CRITICAL_SERVICE_UNAVAILABLE"
  | "DATABASE_MIGRATION_FAILED"
  | "DATABASE_INITIALIZATION_FAILED"
  | "UPDATE_MANAGED_BY_STORE"
  | "ACM_UNSUPPORTED"
  | "ACM_DISABLED"
  | "ACM_PLUGIN_INVALID"
  | "ACM_COMPILER_MISSING"
  | "ACM_COMPILER_INVALID"
  | "ACM_RUNNER_BUSY"
  | "ACM_RUNNER_FAILED"
  | "ACM_RUNNER_TIMEOUT"
  | "ACM_RUNNER_OUTPUT_LIMIT"
  | "ACM_RUNNER_CANCELLED"
  | "ACM_FILE_INVALID"
  | "ACM_FILE_BUSY"
  | "ACM_FILE_TOO_LARGE"
  | "ACM_FILE_READONLY"
  | "ACM_FILE_CHANGED"
  | "ACM_FILE_RECOVERY_REQUIRED";

// ==================== 日程 Schedule ====================

/**
 * 重复规则：对应 schedule_items.repeat_rule 列
 * 存储值采用英文枚举，语义对应：none=无 / daily=每日 / weekly=每周 / monthly=每月
 */
export type RepeatRule = "none" | "daily" | "weekly" | "monthly";

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

/** 成绩页的服务端分页查询参数；大数据量下避免把完整成绩表跨 IPC 传输。 */
export interface GradePageQuery {
  semester?: string;
  degreeOnly?: boolean;
  page: number;
  pageSize: number;
}

/** 成绩页单次分页结果。 */
export interface GradePageResult {
  items: Grade[];
  page: number;
  pageSize: number;
  total: number;
}

/** 成绩页首屏所需的聚合结果；统计在主进程计算，渲染层只接收小对象。 */
export interface GradeDashboard {
  formula: GpaFormula;
  semesters: Array<{ semester: string; count: number }>;
  totalCount: number;
  degreeCount: number;
  latestSemester: string | null;
  semesterGpa: number;
  overallGpa: number;
  degreeGpa: number;
  totalCredit: number;
}

// ==================== 绩点公式 GpaFormula ====================

/**
 * GPA 计算公式记录，对应 gpa_formula 表
 * formula 字段为表达式字符串，可用变量：score、credit、gradePoint
 */
export interface GpaFormula extends BaseEntity {
  name: string;
  /** 表达式，如 "SUM(credit * gradePoint) / SUM(credit)" */
  formula: string;
  isDefault: boolean;
}

// ==================== 通知 ====================

/** 通知来源类型，对应 NotificationPayload.source */
export type NotificationSource =
  | "schedule"
  | "timetable"
  | "exam"
  | "lab"
  | "system";

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
  /** DnD 结束后是否已计入汇总通知。 */
  summarized?: boolean;
}

// ==================== 主题 ====================

/**
 * 主题模式：
 * - system: 跟随系统暗黑/亮色
 * - light: 强制亮色
 * - dark: 强制暗色
 */
export type ThemeMode = "system" | "light" | "dark";

/** 实际生效的主题（解析 system 后的结果） */
export type ResolvedTheme = "light" | "dark";

// ==================== 外观 ====================

/** 材质模式：none=标准 / acrylic=亚克力（Win11 原生，其他系统 CSS 降级） */
export type MaterialMode = "none" | "acrylic";

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

/** 可跨设备恢复的课程学期偏好；null 表示用户尚未配置学期。 */
export interface TimetablePreferences {
  semesterStart: string | null;
}

/** 备份中携带的外观字段，不包含运行时能力判断。 */
export interface PortableAppearanceSettings {
  material: MaterialMode;
  backgroundImage: string | null;
  blurRadius: number;
  clarity: number;
}

/** Backup v2 中允许迁移的设置集合。 */
export interface PortableSettings {
  portableSettingsVersion: 2;
  themeMode: ThemeMode;
  timetable: TimetablePreferences;
  dnd: DndConfig;
  notificationHistory: NotificationRecord[];
  appearance: PortableAppearanceSettings;
  acm: {
    enabled: boolean;
    /** 关闭提示时记录的产品版本；版本升级后自动重新显示。 */
    noticeDismissedVersion?: string | null;
  };
}

/** v0.3 备份/设置的输入形状，读取后会正向迁移为 PortableSettings v2。 */
export interface LegacyPortableSettings {
  portableSettingsVersion: 1;
  themeMode: ThemeMode;
  timetable: TimetablePreferences;
  dnd: DndConfig;
  notificationHistory: NotificationRecord[];
  appearance: PortableAppearanceSettings;
}

export type BackupErrorCode = Extract<
  IpcErrorCode,
  | "BACKUP_BUSY"
  | "BACKUP_INVALID"
  | "BACKUP_CORRUPT"
  | "BACKUP_TOO_NEW"
  | "BACKUP_EXPIRED"
  | "RESTORE_FAILED_ROLLED_BACK"
  | "RESTORE_FAILED_RECOVERY_REQUIRED"
>;

export interface BackupRecordCounts {
  schedules: number;
  courses: number;
  exams: number;
  labs: number;
  grades: number;
  formulas: number;
  periods: number;
}

export interface BackupInspection {
  token: string;
  backupFormatVersion: 1 | 2 | 3;
  databaseSchemaVersion: number;
  portableSettingsVersion: 0 | 1 | 2;
  recordCounts: BackupRecordCounts;
  includesSettings: boolean;
  includesBackground: boolean;
  warnings: string[];
  expiresAt: string;
}

export interface BackupExportResult {
  filePath: string;
  backupFormatVersion: 2 | 3;
  databaseSchemaVersion: number;
  includesBackground: boolean;
  bytes: number;
}

export interface BackupImportResult {
  inspection: BackupInspection;
}

// ==================== 更新 ====================

export type UpdateChannel = "development" | "github" | "microsoft-store";

/**
 * 主进程 UpdateService 经 update:status 通道推送的载荷。
 * 与 main/services/UpdateService.ts 的同名接口保持一致——该模块依赖 electron-updater，
 * 渲染进程无法直接导入，故在共享层重复声明一份作为两端契约。
 */
export interface UpdateStatusPayload {
  status:
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  data?: {
    version?: string;
    percent?: number;
    transferred?: number;
    total?: number;
    error?: string;
  };
}

// ==================== OCR 可选组件 ====================

export type OcrComponentState =
  | "not-installed"
  | "downloading"
  | "ready"
  | "invalid"
  | "error";

export interface OcrComponentManifest {
  id: string;
  version: string;
  engine: string;
  assetUrl: string;
  compressedBytes: number;
  extractedBytes: number;
  compressedSha256: string;
  extractedSha256: string;
  license: string;
}

export interface OcrComponentStatus {
  id: string;
  version: string;
  state: OcrComponentState;
  currentBytes: number;
  totalBytes: number;
  progress: number;
  error?: string;
}

// ==================== ACM 临时 IDE ====================

export type TrustedPluginCapability =
  | "acm.documents"
  | "acm.compiler"
  | "acm.runner";

export interface TrustedPluginManifest {
  id: "acm-code-workbench";
  name: "ACM 临时 IDE";
  pluginApiVersion: 1;
  capabilities: TrustedPluginCapability[];
}

export type AcmPluginState =
  | "unsupported"
  | "disabled"
  | "initializing"
  | "ready"
  | "degraded"
  | "error";

export interface AcmPluginStatus {
  manifest: TrustedPluginManifest;
  enabled: boolean;
  state: AcmPluginState;
  platform: NodeJS.Platform;
  errorCode?: IpcErrorCode;
  error?: string;
}

export type AcmLineEnding = "crlf" | "lf" | "cr";

export interface AcmDocument {
  id: string;
  name: string;
  filePath: string | null;
  content: string;
  lineEnding: AcmLineEnding;
  readOnly: boolean;
  dirty: boolean;
  savedFingerprint: DocumentFingerprint | null;
}

export type AcmTemplateId = "blank" | "basic-io" | "stl";

/** 文档用途决定文件大小策略；待测对拍源码不设产品输入上限。 */
export type AcmDocumentScope =
  | "workbench"
  | "diff-reference"
  | "diff-candidate";

export interface AcmDocumentSaveRequest {
  documentId: string;
  filePath: string | null;
  content: string;
  lineEnding: AcmLineEnding;
  expectedFingerprint: DocumentFingerprint | null;
  force: boolean;
}

export interface AcmDocumentExternalState {
  changed: boolean;
  fingerprint: DocumentFingerprint | null;
}

export interface AcmDocumentExternalRequest {
  documentId: string;
  filePath: string | null;
  savedFingerprint: DocumentFingerprint | null;
}

export interface DocumentFingerprint {
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

export type CompilerSelectionMode = "auto" | "user" | "builtin";

export interface CompilerSelection {
  mode: CompilerSelectionMode;
  path: string | null;
}

export interface CompilerProbeResult {
  available: boolean;
  path: string | null;
  version: string | null;
  target: string | null;
  reason?: string;
}

export interface RunnerLimits {
  compileTimeoutMs: number;
  runTimeoutMs: number;
  stdinBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  tempBytes: number;
}

export interface RunnerStartRequest {
  documentId: string;
  source: string;
  stdin: string;
  mode: "compile" | "run";
}

export type RunnerStage =
  | "compile-started"
  | "compile-finished"
  | "run-started"
  | "run-finished";

export interface RunnerEvent {
  taskId: string;
  documentId: string;
  stage?: RunnerStage;
  stream?: "stdout" | "stderr";
  text?: string;
  status:
    | "started"
    | "data"
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout"
    | "output-limit";
  exitCode?: number | null;
  errorCode?: IpcErrorCode;
  durationMs?: number;
}

/** ACM 对拍请求；源码和标准输入只在当前页面会话内保存。 */
export interface AcmDiffStartRequest {
  reference: string;
  candidate: string;
  stdin: string;
}

export type AcmDiffResultStatus =
  | "reference-failed"
  | "candidate-compile-failed"
  | "candidate-runtime-failed"
  | "candidate-timeout"
  | "candidate-output-limit"
  | "match"
  | "mismatch"
  | "cancelled"
  | "unsupported";

/** 对拍首个 token 差异的受限上下文。 */
export interface AcmDiffDifference {
  referenceTokens: string[];
  candidateTokens: string[];
  referenceStart: number;
  candidateStart: number;
  /** 标准程序在差异点缺失的 token 数；正常差异时不设置。 */
  referenceMissing?: number;
  /** 待测程序在差异点缺失的 token 数；正常差异时不设置。 */
  candidateMissing?: number;
}

/** 两侧运行阶段捕获的受限输出；stdout 用于 token 比较。 */
export interface AcmDiffProgramOutput {
  stdout: string;
  stderr: string;
}

export interface AcmDiffResult {
  status: AcmDiffResultStatus;
  difference?: AcmDiffDifference;
  referenceOutput?: AcmDiffProgramOutput;
  candidateOutput?: AcmDiffProgramOutput;
  /** 临时可执行文件或目录清理失败的非阻断警告。 */
  cleanupWarnings?: string[];
  errorCode?: IpcErrorCode;
}

export type AcmDiffSide = "reference" | "candidate" | "comparison";
export type AcmDiffStage =
  | "reference-compile"
  | "reference-run"
  | "candidate-compile"
  | "candidate-run"
  | "compare";

/** 对拍阶段事件；终结事件携带受限制的两侧运行输出和差异结果。 */
export interface AcmDiffEvent {
  taskId: string;
  side: AcmDiffSide;
  stage: AcmDiffStage;
  status:
    | "started"
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout"
    | "output-limit";
  result?: AcmDiffResult;
  cleanupWarning?: string;
  errorCode?: IpcErrorCode;
}

export interface AcmNoticeState {
  visible: boolean;
  currentVersion: string;
  dismissedVersion: string | null;
}

// ==================== IPC 通道常量 ====================
// 命名规范：<域>:<资源>:<动作>
// 注意：timetable 通道对应 courses 表，period 通道对应 period_config 表

export const IPC_CHANNELS = {
  // 日程
  SCHEDULE_LIST: "db:schedule:list",
  SCHEDULE_ADD: "db:schedule:add",
  SCHEDULE_UPDATE: "db:schedule:update",
  SCHEDULE_REMOVE: "db:schedule:remove",
  // 课程表（对应 courses 表）
  TIMETABLE_LIST: "db:timetable:list",
  TIMETABLE_ADD: "db:timetable:add",
  TIMETABLE_UPDATE: "db:timetable:update",
  TIMETABLE_REMOVE: "db:timetable:remove",
  // 考试
  EXAM_LIST: "db:exam:list",
  EXAM_ADD: "db:exam:add",
  EXAM_UPDATE: "db:exam:update",
  EXAM_REMOVE: "db:exam:remove",
  // 实验
  LAB_LIST: "db:lab:list",
  LAB_ADD: "db:lab:add",
  LAB_UPDATE: "db:lab:update",
  LAB_REMOVE: "db:lab:remove",
  // 成绩
  GRADE_LIST: "db:grade:list",
  GRADE_PAGE: "db:grade:page",
  GRADE_DASHBOARD: "db:grade:dashboard",
  GRADE_ADD: "db:grade:add",
  GRADE_UPDATE: "db:grade:update",
  GRADE_REMOVE: "db:grade:remove",
  // 公式
  FORMULA_GET: "db:formula:get",
  FORMULA_SAVE: "db:formula:save",
  FORMULA_LIST: "db:formula:list",
  // 节次配置（对应 period_config 表）
  PERIOD_CONFIG_GET: "db:period:get",
  PERIOD_CONFIG_SAVE: "db:period:save",
  // 课程表导入（嵌入式浏览器 + DOM/OCR 解析）
  TIMETABLE_OPEN_BROWSER: "timetable:import:openBrowser",
  TIMETABLE_CLOSE_BROWSER: "timetable:import:closeBrowser",
  TIMETABLE_EXTRACT_DOM: "timetable:import:extractDom",
  TIMETABLE_CAPTURE_PAGE: "timetable:import:capturePage",
  TIMETABLE_PARSE_DOM: "timetable:import:parseDom",
  TIMETABLE_RUN_OCR: "timetable:import:runOcr",
  TIMETABLE_GET_PREFERENCES: "timetable:preferences:get",
  TIMETABLE_SET_SEMESTER_START: "timetable:preferences:setSemesterStart",
  // 考试导入（复用嵌入式浏览器，独立 DOM/OCR 解析通道）
  EXAM_PARSE_DOM: "exam:import:parseDom",
  EXAM_RUN_OCR: "exam:import:runOcr",
  // 实验导入（复用嵌入式浏览器，独立 DOM/OCR 解析通道）
  LAB_PARSE_DOM: "lab:import:parseDom",
  LAB_RUN_OCR: "lab:import:runOcr",
  // 通知
  NOTIFY_SEND: "notify:send",
  NOTIFY_SET_DND: "notify:setDnd",
  NOTIFY_GET_DND: "notify:getDnd",
  NOTIFY_GET_HISTORY: "notify:getHistory",
  NOTIFY_CLEAR_HISTORY: "notify:clearHistory",
  // 数据导入导出
  DATA_EXPORT_BACKUP: "data:exportBackup",
  DATA_PREPARE_IMPORT: "data:prepareImport",
  DATA_COMMIT_IMPORT: "data:commitImport",
  DATA_CANCEL_IMPORT: "data:cancelImport",
  DATA_RESTORE_COMPLETED: "data:restoreCompleted",
  // 旧通道仅保留给主进程升级检测，不通过 preload 暴露。
  DATA_EXPORT: "data:export",
  DATA_IMPORT: "data:import",
  // 更新
  UPDATE_CHECK: "update:check",
  UPDATE_INSTALL: "update:install",
  UPDATE_STATUS: "update:status",
  UPDATE_GET_CHANNEL: "update:getChannel",
  // 窗口控制（自定义标题栏按钮 + 最小化到托盘）
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",
  WINDOW_IS_MAXIMIZED: "window:isMaximized",
  WINDOW_ON_MAXIMIZE_CHANGE: "window:onMaximizeChange",
  // 主题（跟随系统 + 手动切换）
  THEME_GET: "theme:get",
  THEME_SET: "theme:set",
  THEME_GET_RESOLVED: "theme:getResolved",
  THEME_ON_CHANGE: "theme:onChange",
  // 外观（材质模式 + 背景图 + 模糊度 + 清晰度）
  APPEARANCE_GET: "appearance:get",
  APPEARANCE_CHOOSE_BG: "appearance:chooseBackground",
  APPEARANCE_SET_MATERIAL: "appearance:setMaterial",
  APPEARANCE_CLEAR_BG: "appearance:clearBackground",
  APPEARANCE_SET_BLUR: "appearance:setBlur",
  APPEARANCE_SET_CLARITY: "appearance:setClarity",
  APPEARANCE_ON_CHANGE: "appearance:onChange",
  OCR_COMPONENT_GET_STATUS: "ocr-component:getStatus",
  OCR_COMPONENT_INSTALL: "ocr-component:install",
  OCR_COMPONENT_CANCEL_INSTALL: "ocr-component:cancelInstall",
  OCR_COMPONENT_REMOVE: "ocr-component:remove",
  OCR_COMPONENT_ON_STATUS_CHANGE: "ocr-component:onStatusChange",
  UPDATE_GET_CURRENT_VERSION: "update:getCurrentVersion",
  // ACM 受信插件
  ACM_GET_STATUS: "acm:plugin:getStatus",
  ACM_SET_ENABLED: "acm:plugin:setEnabled",
  ACM_RETRY: "acm:plugin:retry",
  ACM_DOCUMENT_CREATE: "acm:document:create",
  ACM_DOCUMENT_OPEN: "acm:document:open",
  ACM_DOCUMENT_SAVE: "acm:document:save",
  ACM_DOCUMENT_SAVE_AS: "acm:document:saveAs",
  ACM_DOCUMENT_RELEASE: "acm:document:release",
  ACM_DOCUMENT_CHECK_EXTERNAL: "acm:document:checkExternal",
  ACM_COMPILER_GET_SELECTION: "acm:compiler:getSelection",
  ACM_COMPILER_SET_SELECTION: "acm:compiler:setSelection",
  ACM_COMPILER_SELECT_PATH: "acm:compiler:selectPath",
  ACM_COMPILER_PROBE: "acm:compiler:probe",
  ACM_RUNNER_START: "acm:runner:start",
  ACM_RUNNER_STOP: "acm:runner:stop",
  ACM_RUNNER_EVENT: "acm:runner:event",
  ACM_DIFF_START: "acm:diff:start",
  ACM_DIFF_STOP: "acm:diff:stop",
  ACM_DIFF_EVENT: "acm:diff:event",
  ACM_NOTICE_GET_STATE: "acm:notice:getState",
  ACM_NOTICE_DISMISS: "acm:notice:dismiss",
  ACM_NOTICE_CLEAR: "acm:notice:clear",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ==================== 渲染进程 API 形状 ====================
// preload 通过 contextBridge 暴露的 window.api 类型契约

export interface RendererApi {
  schedule: {
    list: () => Promise<IpcResult<Schedule[]>>;
    add: (
      item: Omit<Schedule, keyof BaseEntity>,
    ) => Promise<IpcResult<Schedule>>;
    update: (
      id: string,
      patch: Partial<Schedule>,
    ) => Promise<IpcResult<Schedule>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
  };
  timetable: {
    list: () => Promise<IpcResult<Course[]>>;
    add: (item: Omit<Course, keyof BaseEntity>) => Promise<IpcResult<Course>>;
    update: (id: string, patch: Partial<Course>) => Promise<IpcResult<Course>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
    getPreferences: () => Promise<IpcResult<TimetablePreferences>>;
    setSemesterStart: (
      value: string | null,
    ) => Promise<IpcResult<TimetablePreferences>>;
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
    listPage: (query: GradePageQuery) => Promise<IpcResult<GradePageResult>>;
    getDashboard: () => Promise<IpcResult<GradeDashboard>>;
    add: (item: Omit<Grade, keyof BaseEntity>) => Promise<IpcResult<Grade>>;
    update: (id: string, patch: Partial<Grade>) => Promise<IpcResult<Grade>>;
    remove: (id: string) => Promise<IpcResult<boolean>>;
  };
  formula: {
    get: (id: string) => Promise<IpcResult<GpaFormula | null>>;
    save: (
      formula: Omit<GpaFormula, keyof BaseEntity>,
    ) => Promise<IpcResult<GpaFormula>>;
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
    exportBackup: () => Promise<IpcResult<BackupExportResult>>;
    prepareImport: () => Promise<IpcResult<BackupImportResult>>;
    commitImport: (token: string) => Promise<IpcResult<BackupInspection>>;
    cancelImport: (token: string) => Promise<IpcResult<boolean>>;
    onRestoreCompleted: (callback: () => void) => () => void;
  };
  update: {
    checkManual: () => Promise<IpcResult<boolean>>;
    installUpdate: () => Promise<IpcResult<boolean>>;
    getCurrentVersion: () => Promise<IpcResult<string>>;
    getChannel: () => Promise<IpcResult<UpdateChannel>>;
    /** 订阅更新状态推送；返回取消订阅函数，调用方卸载时必须调用以避免 listener 叠加 */
    onUpdateStatus: (
      callback: (payload: UpdateStatusPayload) => void,
    ) => () => void;
  };
  window: {
    minimize: () => Promise<IpcResult<boolean>>;
    maximize: () => Promise<IpcResult<boolean>>;
    close: () => Promise<IpcResult<boolean>>;
    isMaximized: () => Promise<IpcResult<boolean>>;
    /** 订阅窗口最大化状态变更；返回取消订阅函数 */
    onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
  };
  theme: {
    get: () => Promise<IpcResult<ThemeMode>>;
    set: (mode: ThemeMode) => Promise<IpcResult<boolean>>;
    getResolved: () => Promise<IpcResult<ResolvedTheme>>;
    /** 订阅主题变更广播；返回取消订阅函数 */
    onChange: (callback: (resolved: ResolvedTheme) => void) => () => void;
  };
  appearance: {
    get: () => Promise<IpcResult<AppearanceConfig>>;
    chooseBackground: () => Promise<IpcResult<string>>;
    setMaterial: (mode: MaterialMode) => Promise<IpcResult<boolean>>;
    clearBackground: () => Promise<IpcResult<boolean>>;
    setBlur: (value: number) => Promise<IpcResult<boolean>>;
    setClarity: (value: number) => Promise<IpcResult<boolean>>;
    /** 订阅外观配置变更广播；返回取消订阅函数 */
    onChange: (callback: (config: AppearanceConfig) => void) => () => void;
  };
  ocrComponent: {
    getStatus: () => Promise<IpcResult<OcrComponentStatus>>;
    install: () => Promise<IpcResult<OcrComponentStatus>>;
    cancelInstall: () => Promise<IpcResult<boolean>>;
    remove: () => Promise<IpcResult<boolean>>;
    onStatusChange: (
      callback: (status: OcrComponentStatus) => void,
    ) => () => void;
  };
  acm: {
    getStatus: () => Promise<IpcResult<AcmPluginStatus>>;
    setEnabled: (enabled: boolean) => Promise<IpcResult<AcmPluginStatus>>;
    retry: () => Promise<IpcResult<AcmPluginStatus>>;
    createDocument: (
      template: AcmTemplateId,
      scope?: AcmDocumentScope,
    ) => Promise<IpcResult<AcmDocument>>;
    openDocument: (
      scope?: AcmDocumentScope,
    ) => Promise<IpcResult<AcmDocument | null>>;
    saveDocument: (
      request: AcmDocumentSaveRequest,
    ) => Promise<IpcResult<AcmDocument>>;
    saveDocumentAs: (
      request: AcmDocumentSaveRequest,
    ) => Promise<IpcResult<AcmDocument | null>>;
    releaseDocument: (documentId: string) => Promise<IpcResult<boolean>>;
    checkDocumentExternal: (
      document: AcmDocumentExternalRequest,
    ) => Promise<IpcResult<AcmDocumentExternalState>>;
    getCompilerSelection: () => Promise<IpcResult<CompilerSelection>>;
    setCompilerSelection: (
      selection: CompilerSelection,
    ) => Promise<IpcResult<CompilerSelection>>;
    selectCompilerPath: () => Promise<IpcResult<CompilerSelection | null>>;
    probeCompiler: () => Promise<IpcResult<CompilerProbeResult>>;
    startRunner: (
      request: RunnerStartRequest,
    ) => Promise<IpcResult<{ taskId: string }>>;
    stopRunner: () => Promise<IpcResult<boolean>>;
    onRunnerEvent: (callback: (event: RunnerEvent) => void) => () => void;
    startDiff: (
      request: AcmDiffStartRequest,
    ) => Promise<IpcResult<{ taskId: string }>>;
    stopDiff: () => Promise<IpcResult<boolean>>;
    onDiffEvent: (callback: (event: AcmDiffEvent) => void) => () => void;
    getNoticeState: () => Promise<IpcResult<AcmNoticeState>>;
    dismissNotice: () => Promise<IpcResult<AcmNoticeState>>;
    clearNotice: () => Promise<IpcResult<AcmNoticeState>>;
  };
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
