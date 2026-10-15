// 主进程入口：启动关键服务、注册经过 schema 校验的 IPC，并管理单实例与受限资源协议。
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  protocol,
  type WebContents,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  IPC_CHANNELS,
  type AcmDocument,
  type AcmDocumentExternalState,
  type AcmDocumentScope,
  type AcmPluginStatus,
  type AcmDiffEvent,
  type AcmDiffStartRequest,
  type AcmNoticeState,
  type CompilerProbeResult,
  type CompilerSelection,
  type Course,
  type Exam,
  type GpaFormula,
  type Grade,
  type IpcErrorCode,
  type IpcResult,
  type Lab,
  type MaterialMode,
  type OnboardingState,
  type PeriodConfig,
  type RunnerEvent,
  type Schedule,
} from "../shared/types";
import { resolveOnboardingState } from "../shared/onboarding";
import { PRODUCT_VERSION } from "../shared/version";
import { dataService, DEFAULT_PERIODS } from "./services/DataService";
import { CURRENT_DEFAULT_GPA_FORMULA } from "./services/DatabaseMigrator";
import { portableSettingsService } from "./services/PortableSettingsService";
import { notificationService } from "./services/NotificationService";
import { timetableService } from "./services/TimetableService";
import { reminderScheduler } from "./services/ReminderScheduler";
import { updateService } from "./services/UpdateService";
import { windowService } from "./services/WindowService";
import { themeService } from "./services/ThemeService";
import { appearanceService } from "./services/AppearanceService";
import {
  importBrowserService,
  registerImportBrowserIpcHandlers,
} from "./services/ImportBrowserService";
import { ocrComponentService } from "./services/OcrComponentService";
import { ocrService } from "./services/OcrService";
import { acmPluginService } from "./services/AcmPluginService";
import { acmCompilerService } from "./services/AcmCompilerService";
import { acmFileService } from "./services/AcmFileService";
import { canUseAcmDocumentScope } from "./services/AcmDocumentPolicy";
import { acmLifecycleQueue } from "./services/AcmLifecycleQueue";
import { acmRunnerService } from "./services/AcmRunnerService";
import { acmDifferService } from "./services/AcmDifferService";
import { writeTextFileAtomically } from "./services/AtomicFile";
import { parseDomWithMeta } from "./services/parsers";
import { parseDomForExams } from "./services/parsers/exam";
import { parseOcrToExams } from "./services/ExamOcrParser";
import { parseDomForLabs } from "./services/parsers/lab";
import { parseOcrToLabs } from "./services/LabOcrParser";
import {
  assertImageSignature,
  isSafeImageFileName,
  MAX_BACKGROUND_IMAGE_BYTES,
} from "./services/ImageValidation";
import {
  claritySchema,
  courseAddSchema,
  coursePatchSchema,
  dndSchema,
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
  materialModeSchema,
  parseIpc,
  periodConfigSchema,
  scheduleAddSchema,
  schedulePatchSchema,
  semesterStartSchema,
  themeModeSchema,
  tokenSchema,
  blurSchema,
  IpcValidationError,
  formulaIdSchema,
  notificationPayloadSchema,
  acmTemplateSchema,
  acmDocumentScopeSchema,
  acmDocumentSaveSchema,
  acmDocumentReleaseSchema,
  acmExternalDocumentSchema,
  acmCompilerSelectionSchema,
  acmRunnerStartSchema,
  acmDiffStartSchema,
} from "./validation";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app-background",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const services = [
  portableSettingsService,
  acmCompilerService,
  acmFileService,
  acmRunnerService,
  acmDifferService,
  acmPluginService,
  windowService,
  themeService,
  appearanceService,
  dataService,
  notificationService,
  timetableService,
  reminderScheduler,
  updateService,
  importBrowserService,
  ocrComponentService,
  ocrService,
];

function createMainWindow(): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  windowService.createMainWindow((win) => {
    if (devUrl) void win.loadURL(devUrl);
    else void win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }, devUrl);
  appearanceService.applyMaterial();
}

function errorCode(error: unknown): IpcErrorCode | undefined {
  if (error instanceof IpcValidationError) return error.code;
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? (code as IpcErrorCode) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrap<T>(fn: () => T): IpcResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      errorCode: errorCode(error),
    };
  }
}

function wrapIpc<T>(fn: () => IpcResult<T>): IpcResult<T> {
  try {
    return fn();
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      errorCode: errorCode(error),
    };
  }
}

async function wrapAsync<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      errorCode: errorCode(error),
    };
  }
}

async function wrapIpcAsync<T>(
  fn: () => Promise<IpcResult<T>>,
): Promise<IpcResult<T>> {
  try {
    return await fn();
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      errorCode: errorCode(error),
    };
  }
}

function backupBusyResult<T>(): IpcResult<T> {
  return {
    ok: false,
    error: "备份或恢复正在进行，请稍后重试",
    errorCode: "BACKUP_BUSY",
  };
}

function wrapWrite<T>(fn: () => T): IpcResult<T> {
  if (dataService.isTransferBusy()) return backupBusyResult<T>();
  return wrap(fn);
}

function wrapWriteIpc<T>(fn: () => IpcResult<T>): IpcResult<T> {
  if (dataService.isTransferBusy()) return backupBusyResult<T>();
  return wrapIpc(fn);
}

async function wrapWriteAsync<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  if (dataService.isTransferBusy()) return backupBusyResult<T>();
  return wrapAsync(fn);
}

async function wrapWriteIpcAsync<T>(
  fn: () => Promise<IpcResult<T>>,
): Promise<IpcResult<T>> {
  if (dataService.isTransferBusy()) return backupBusyResult<T>();
  return wrapIpcAsync(fn);
}

function unauthorizedIpcResult<T>(): IpcResult<T> {
  return {
    ok: false,
    error: "未授权的 IPC 调用",
    errorCode: "IPC_UNAUTHORIZED",
  };
}

/** 所有主应用 IPC 共用同一 sender/frame/origin 边界，避免远程页面借用 preload。 */
function registerIpcHandler<T extends unknown[]>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: T) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!windowService.isTrustedMainFrameEvent(event))
      return unauthorizedIpcResult();
    return handler(event, ...(args as T));
  });
}

function refreshReminders(): void {
  void reminderScheduler
    .recompute()
    .catch((error: unknown) =>
      console.error(`[main] 提醒重算失败: ${errorMessage(error)}`),
    );
}

function registerReminderSystemEvents(): void {
  powerMonitor.on("resume", refreshReminders);
  powerMonitor.on("on-ac", refreshReminders);
  powerMonitor.on("on-battery", refreshReminders);
}

function getDefaultGradeFormula(): GpaFormula {
  return (
    dataService.formulas.getById("default") ??
    dataService.formulas.list()[0] ?? {
      id: "default",
      name: "默认公式",
      formula: "SUM(credit * gradePoint) / SUM(credit)",
      isDefault: true,
      createdAt: "",
      updatedAt: "",
    }
  );
}

function registerCrudHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.SCHEDULE_LIST, () =>
    wrap(() => dataService.schedules.list()),
  );
  registerIpcHandler(IPC_CHANNELS.SCHEDULE_ADD, (_event, item: unknown) => {
    const result = wrapWrite(() =>
      dataService.schedules.add(
        parseIpc(scheduleAddSchema, item) as Omit<
          Schedule,
          "id" | "createdAt" | "updatedAt"
        >,
      ),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  registerIpcHandler(
    IPC_CHANNELS.SCHEDULE_UPDATE,
    (_event, id: unknown, patch: unknown) => {
      const result = wrapWrite(() =>
        dataService.schedules.update(
          parseIpc(tokenSchema, id),
          parseIpc(schedulePatchSchema, patch) as Partial<Schedule>,
        ),
      );
      if (result.ok) refreshReminders();
      return result;
    },
  );
  registerIpcHandler(IPC_CHANNELS.SCHEDULE_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.schedules.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });

  registerIpcHandler(IPC_CHANNELS.TIMETABLE_LIST, () =>
    wrap(() => dataService.courses.list()),
  );
  registerIpcHandler(IPC_CHANNELS.TIMETABLE_ADD, (_event, item: unknown) => {
    const result = wrapWrite(() =>
      dataService.courses.add(
        parseIpc(courseAddSchema, item) as Omit<
          Course,
          "id" | "createdAt" | "updatedAt"
        >,
      ),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  registerIpcHandler(
    IPC_CHANNELS.TIMETABLE_UPDATE,
    (_event, id: unknown, patch: unknown) => {
      const result = wrapWrite(() =>
        dataService.courses.update(
          parseIpc(tokenSchema, id),
          parseIpc(coursePatchSchema, patch) as Partial<Course>,
        ),
      );
      if (result.ok) refreshReminders();
      return result;
    },
  );
  registerIpcHandler(IPC_CHANNELS.TIMETABLE_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.courses.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  registerIpcHandler(IPC_CHANNELS.TIMETABLE_GET_PREFERENCES, () =>
    timetableService.getPreferences(),
  );
  registerIpcHandler(
    IPC_CHANNELS.TIMETABLE_SET_SEMESTER_START,
    (_event, value: unknown) => {
      const result = wrapWrite(() =>
        timetableService.setSemesterStart(parseIpc(semesterStartSchema, value)),
      );
      if (result.ok) refreshReminders();
      return result;
    },
  );

  registerIpcHandler(IPC_CHANNELS.PERIOD_CONFIG_GET, () =>
    wrap(() => dataService.periodConfig.getAll()),
  );
  registerIpcHandler(
    IPC_CHANNELS.PERIOD_CONFIG_SAVE,
    (_event, config: unknown) => {
      const result = wrapWrite(() => {
        dataService.periodConfig.saveAll(
          parseIpc(periodConfigSchema, config) as PeriodConfig[],
        );
        return true;
      });
      if (result.ok) refreshReminders();
      return result;
    },
  );

  registerEntityHandlers();
}

function registerEntityHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.EXAM_LIST, () =>
    wrap(() => dataService.exams.list()),
  );
  registerIpcHandler(IPC_CHANNELS.EXAM_ADD, (_event, item: unknown) => {
    const result = wrapWrite(() =>
      dataService.exams.add(
        parseIpc(examAddSchema, item) as Omit<
          Exam,
          "id" | "createdAt" | "updatedAt"
        >,
      ),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  registerIpcHandler(
    IPC_CHANNELS.EXAM_UPDATE,
    (_event, id: unknown, patch: unknown) => {
      const result = wrapWrite(() =>
        dataService.exams.update(
          parseIpc(tokenSchema, id),
          parseIpc(examPatchSchema, patch) as Partial<Exam>,
        ),
      );
      if (result.ok) refreshReminders();
      return result;
    },
  );
  registerIpcHandler(IPC_CHANNELS.EXAM_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.exams.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  registerIpcHandler(IPC_CHANNELS.LAB_LIST, () =>
    wrap(() => dataService.labs.list()),
  );
  registerIpcHandler(IPC_CHANNELS.LAB_ADD, (_event, item: unknown) => {
    const result = wrapWrite(() =>
      dataService.labs.add(
        parseIpc(labAddSchema, item) as Omit<
          Lab,
          "id" | "createdAt" | "updatedAt"
        >,
      ),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  registerIpcHandler(
    IPC_CHANNELS.LAB_UPDATE,
    (_event, id: unknown, patch: unknown) => {
      const result = wrapWrite(() =>
        dataService.labs.update(
          parseIpc(tokenSchema, id),
          parseIpc(labPatchSchema, patch) as Partial<Lab>,
        ),
      );
      if (result.ok) refreshReminders();
      return result;
    },
  );
  registerIpcHandler(IPC_CHANNELS.LAB_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.labs.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  registerIpcHandler(IPC_CHANNELS.GRADE_LIST, () =>
    wrap(() => dataService.grades.list()),
  );
  registerIpcHandler(IPC_CHANNELS.GRADE_PAGE, (_event, query: unknown) =>
    wrap(() =>
      dataService.grades.listPage(parseIpc(gradePageQuerySchema, query)),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.GRADE_DASHBOARD, () =>
    wrap(() => dataService.grades.getDashboard(getDefaultGradeFormula())),
  );
  registerIpcHandler(IPC_CHANNELS.GRADE_ADD, (_event, item: unknown) =>
    wrapWrite(() =>
      dataService.grades.add(
        parseIpc(gradeAddSchema, item) as Omit<
          Grade,
          "id" | "createdAt" | "updatedAt"
        >,
      ),
    ),
  );
  registerIpcHandler(
    IPC_CHANNELS.GRADE_UPDATE,
    (_event, id: unknown, patch: unknown) =>
      wrapWrite(() =>
        dataService.grades.update(
          parseIpc(tokenSchema, id),
          parseIpc(gradePatchSchema, patch) as Partial<Grade>,
        ),
      ),
  );
  registerIpcHandler(IPC_CHANNELS.GRADE_REMOVE, (_event, id: unknown) =>
    wrapWrite(() => dataService.grades.remove(parseIpc(tokenSchema, id))),
  );
  registerIpcHandler(IPC_CHANNELS.FORMULA_GET, (_event, id: unknown) =>
    wrap(() => dataService.formulas.getById(parseIpc(formulaIdSchema, id))),
  );
  registerIpcHandler(IPC_CHANNELS.FORMULA_LIST, () =>
    wrap(() => dataService.formulas.list()),
  );
  registerIpcHandler(IPC_CHANNELS.FORMULA_SAVE, (_event, formula: unknown) =>
    wrapWrite(() =>
      dataService.formulas.save(
        parseIpc(formulaSchema, formula) as Omit<
          GpaFormula,
          "createdAt" | "updatedAt"
        > & { id?: string },
      ),
    ),
  );
}

function registerImportHandlers(): void {
  registerImportBrowserIpcHandlers((event) =>
    windowService.isTrustedMainFrameEvent(event),
  );
  registerIpcHandler(
    IPC_CHANNELS.TIMETABLE_PARSE_DOM,
    (_event, html: unknown) =>
      wrap(() => parseDomWithMeta(parseIpc(htmlSchema, html))),
  );
  registerIpcHandler(IPC_CHANNELS.EXAM_PARSE_DOM, (_event, html: unknown) =>
    wrap(() => parseDomForExams(parseIpc(htmlSchema, html))),
  );
  registerIpcHandler(IPC_CHANNELS.LAB_PARSE_DOM, (_event, html: unknown) =>
    wrap(() => parseDomForLabs(parseIpc(htmlSchema, html))),
  );
  registerIpcHandler(IPC_CHANNELS.TIMETABLE_RUN_OCR, (_event, image: unknown) =>
    runOcr(image, "course"),
  );
  registerIpcHandler(IPC_CHANNELS.EXAM_RUN_OCR, (_event, image: unknown) =>
    runOcr(image, "exam"),
  );
  registerIpcHandler(IPC_CHANNELS.LAB_RUN_OCR, (_event, image: unknown) =>
    runOcr(image, "lab"),
  );
}

async function runOcr(
  image: unknown,
  kind: "course" | "exam" | "lab",
): Promise<IpcResult<unknown>> {
  return wrapAsync(async () => {
    const imageBase64 = parseIpc(imageBase64Schema, image);
    const text = await ocrService.recognize(Buffer.from(imageBase64, "base64"));
    if (kind === "course") return ocrService.parseOcrToCourses(text);
    if (kind === "exam") return parseOcrToExams(text);
    return parseOcrToLabs(text);
  });
}

function registerNotificationHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.NOTIFY_SEND, (_event, payload: unknown) =>
    wrapWriteIpcAsync(() =>
      notificationService.send(parseIpc(notificationPayloadSchema, payload)),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.NOTIFY_SET_DND, (_event, config: unknown) =>
    wrapWriteIpcAsync(() =>
      notificationService.setDnd(parseIpc(dndSchema, config)),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.NOTIFY_GET_DND, () =>
    wrapIpcAsync(() => notificationService.getDnd()),
  );
  registerIpcHandler(IPC_CHANNELS.NOTIFY_GET_HISTORY, () =>
    wrapIpcAsync(() => notificationService.getHistory()),
  );
  registerIpcHandler(IPC_CHANNELS.NOTIFY_CLEAR_HISTORY, () =>
    wrapWriteIpcAsync(() => notificationService.clearHistory()),
  );
}

function registerDataHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.DATA_EXPORT_BACKUP, (event) =>
    wrapIpcAsync(() =>
      dataService.exportBackup(BrowserWindow.fromWebContents(event.sender)),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.DATA_PREPARE_IMPORT, (event) =>
    wrapIpcAsync(() =>
      dataService.prepareImport(
        event.sender.id,
        BrowserWindow.fromWebContents(event.sender),
      ),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.DATA_COMMIT_IMPORT, (event, token: unknown) =>
    wrapIpcAsync(async () => {
      const result = await dataService.commitImport(
        event.sender.id,
        parseIpc(tokenSchema, token),
      );
      if (result.ok) {
        themeService.applyPortableSettings();
        timetableService.applyPortableSettings();
        notificationService.applyPortableSettings();
        appearanceService.applyPortableSettings();
        await reminderScheduler.recompute();
        broadcastRestoreCompleted();
      }
      return result;
    }),
  );
  registerIpcHandler(IPC_CHANNELS.DATA_CANCEL_IMPORT, (event, token: unknown) =>
    wrapIpcAsync(() =>
      dataService.cancelImport(event.sender.id, parseIpc(tokenSchema, token)),
    ),
  );
}

function broadcastRestoreCompleted(): void {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send(IPC_CHANNELS.DATA_RESTORE_COMPLETED);
}

function registerSettingsHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.THEME_GET, () =>
    wrap(() => themeService.getMode()),
  );
  registerIpcHandler(IPC_CHANNELS.THEME_SET, (_event, mode: unknown) =>
    wrapWrite(() => {
      themeService.setMode(parseIpc(themeModeSchema, mode));
      return true;
    }),
  );
  registerIpcHandler(IPC_CHANNELS.THEME_GET_RESOLVED, () =>
    wrap(() => themeService.getResolved()),
  );
  registerIpcHandler(IPC_CHANNELS.APPEARANCE_GET, () =>
    wrap(() => appearanceService.getConfig()),
  );
  registerIpcHandler(IPC_CHANNELS.APPEARANCE_CHOOSE_BG, () =>
    wrapWriteAsync(() => appearanceService.chooseBackgroundImage()),
  );
  registerIpcHandler(
    IPC_CHANNELS.APPEARANCE_SET_MATERIAL,
    (_event, mode: unknown) =>
      wrapWrite(() => {
        appearanceService.setMaterial(
          parseIpc(materialModeSchema, mode) as MaterialMode,
        );
        return true;
      }),
  );
  registerIpcHandler(IPC_CHANNELS.APPEARANCE_CLEAR_BG, () =>
    wrapWriteAsync(async () => {
      await appearanceService.clearBackgroundImage();
      return true;
    }),
  );
  registerIpcHandler(
    IPC_CHANNELS.APPEARANCE_SET_BLUR,
    (_event, value: unknown) =>
      wrapWrite(() => {
        appearanceService.setBlurRadius(parseIpc(blurSchema, value));
        return true;
      }),
  );
  registerIpcHandler(
    IPC_CHANNELS.APPEARANCE_SET_CLARITY,
    (_event, value: unknown) =>
      wrapWrite(() => {
        appearanceService.setClarity(parseIpc(claritySchema, value));
        return true;
      }),
  );
  registerIpcHandler(IPC_CHANNELS.UPDATE_CHECK, () =>
    wrapIpcAsync(() => updateService.checkManual()),
  );
  registerIpcHandler(IPC_CHANNELS.UPDATE_INSTALL, () =>
    wrapWriteIpcAsync(() => updateService.installUpdate()),
  );
  registerIpcHandler(IPC_CHANNELS.UPDATE_GET_CURRENT_VERSION, () =>
    wrap(() => PRODUCT_VERSION),
  );
  registerIpcHandler(IPC_CHANNELS.UPDATE_GET_CHANNEL, () =>
    wrap(() => updateService.getChannel()),
  );
}

function onboardingStatePath(): string {
  return path.join(app.getPath("userData"), "onboarding-state.json");
}

function samePeriodConfig(left: PeriodConfig, right: PeriodConfig): boolean {
  return (
    left.index === right.index &&
    left.startTime === right.startTime &&
    left.endTime === right.endTime &&
    left.breakAfter === right.breakAfter &&
    left.isLab === right.isLab &&
    left.reminderOffset === right.reminderOffset
  );
}

function hasNonDefaultDatabaseSettings(): boolean {
  const counts = dataService.getRecordCounts();
  if (
    counts.schedules > 0 ||
    counts.courses > 0 ||
    counts.exams > 0 ||
    counts.labs > 0 ||
    counts.grades > 0
  )
    return true;
  const defaultFormula = dataService.formulas.getById("default");
  if (
    !defaultFormula ||
    defaultFormula.formula.trim() !== CURRENT_DEFAULT_GPA_FORMULA ||
    !defaultFormula.isDefault ||
    counts.formulas !== 1
  )
    return true;
  const periods = dataService.periodConfig.getAll();
  return (
    periods.length !== DEFAULT_PERIODS.length ||
    periods.some(
      (period, index) => !samePeriodConfig(period, DEFAULT_PERIODS[index]),
    )
  );
}

function hasNonDefaultPortableSettings(): boolean {
  const settings = portableSettingsService.get();
  return Boolean(
    settings.themeMode !== "system" ||
      settings.timetable.semesterStart ||
      settings.dnd.enabled ||
      settings.notificationHistory.length ||
      settings.appearance.material !== "none" ||
      settings.appearance.backgroundImage ||
      settings.appearance.blurRadius !== 0 ||
      settings.appearance.clarity !== 100 ||
      !settings.acm.enabled ||
      settings.acm.noticeDismissedVersion,
  );
}

function hasCustomCompilerSelection(): boolean {
  const selection = acmCompilerService.getSelection();
  return Boolean(
    selection.ok &&
      selection.data &&
      (selection.data.mode === "user" || Boolean(selection.data.path)),
  );
}

function hasExistingUserData(): boolean {
  try {
    return (
      hasNonDefaultDatabaseSettings() ||
      hasNonDefaultPortableSettings() ||
      hasCustomCompilerSelection()
    );
  } catch {
    return false;
  }
}

function readOnboardingState(): OnboardingState {
  let marker: boolean | undefined;
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(onboardingStatePath(), "utf8"),
    );
    if (
      raw &&
      typeof raw === "object" &&
      "completed" in raw &&
      typeof raw.completed === "boolean"
    ) {
      marker = raw.completed;
    }
  } catch {
    // Missing or malformed local marker means the welcome page is required.
  }
  return resolveOnboardingState(marker, hasExistingUserData());
}

function writeOnboardingState(completed: boolean): OnboardingState {
  const target = onboardingStatePath();
  writeTextFileAtomically(target, JSON.stringify({ completed }));
  return { required: !completed, completed };
}

function registerOnboardingHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.ONBOARDING_GET_STATE, () =>
    wrap(() => readOnboardingState()),
  );
  registerIpcHandler(IPC_CHANNELS.ONBOARDING_COMPLETE, () =>
    wrapWrite(() => writeOnboardingState(true)),
  );
}

function registerOcrComponentHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.OCR_COMPONENT_GET_STATUS, () =>
    wrapIpc(() => ocrComponentService.getStatus()),
  );
  registerIpcHandler(IPC_CHANNELS.OCR_COMPONENT_INSTALL, () =>
    wrapWriteIpcAsync(async () => {
      const result = await ocrComponentService.install();
      if (result.ok) await ocrService.invalidateWorker();
      return result;
    }),
  );
  registerIpcHandler(IPC_CHANNELS.OCR_COMPONENT_CANCEL_INSTALL, () =>
    wrapWriteIpc(() => ocrComponentService.cancelInstall()),
  );
  registerIpcHandler(IPC_CHANNELS.OCR_COMPONENT_REMOVE, () =>
    wrapWriteIpcAsync(async () => {
      const result = ocrComponentService.remove();
      if (result.ok) await ocrService.invalidateWorker();
      return result;
    }),
  );
}

function acmUnavailable<T>(): IpcResult<T> | null {
  const status = acmPluginService.getStatus();
  if (!status.ok || !status.data) {
    return {
      ok: false,
      error: status.error ?? "ACM 插件状态不可用",
      errorCode: status.errorCode ?? "ACM_PLUGIN_INVALID",
    };
  }
  if (status.data.state === "unsupported")
    return {
      ok: false,
      error: "ACM 工具仅支持 Windows 11 x64",
      errorCode: "ACM_UNSUPPORTED",
    };
  if (status.data.state === "disabled")
    return { ok: false, error: "ACM 插件已禁用", errorCode: "ACM_DISABLED" };
  if (status.data.state === "initializing")
    return {
      ok: false,
      error: "ACM 插件仍在初始化，请稍后重试",
      errorCode: "ACM_PLUGIN_INVALID",
    };
  if (status.data.state === "error")
    return {
      ok: false,
      error: status.data.error ?? "ACM 插件初始化失败",
      errorCode: status.data.errorCode ?? "ACM_PLUGIN_INVALID",
    };
  return null;
}

function withAcm<T>(fn: () => IpcResult<T>): IpcResult<T> {
  return acmUnavailable<T>() ?? fn();
}

function acmExecutionUnavailable<T>(): IpcResult<T> | null {
  if (acmPluginService.isEnabled()) return acmUnavailable<T>();
  return (
    acmUnavailable<T>() ?? {
      ok: false,
      error: "ACM 插件当前不可用",
      errorCode: "ACM_DISABLED",
    }
  );
}

function acmNoticeState(): AcmNoticeState {
  const dismissedVersion =
    portableSettingsService.getAcmNoticeDismissedVersion();
  const status = acmPluginService.getStatus();
  const pluginMustShow =
    !status.ok ||
    !status.data ||
    ["disabled", "unsupported", "error"].includes(status.data.state);
  return {
    visible: pluginMustShow || dismissedVersion !== PRODUCT_VERSION,
    currentVersion: PRODUCT_VERSION,
    dismissedVersion,
  };
}

function setAcmNoticeVersion(version: string | null): AcmNoticeState {
  portableSettingsService.setAcmNoticeDismissedVersion(version);
  return acmNoticeState();
}

function parseDocumentScope(
  sender: WebContents,
  value: unknown,
): AcmDocumentScope {
  const scope = parseIpc(acmDocumentScopeSchema, value) ?? "workbench";
  if (!canUseAcmDocumentScope(scope, sender.getURL()))
    throw new IpcValidationError("对拍源码只能在 ACM 对拍页面中打开");
  return scope;
}

function registerAcmPluginHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.ACM_GET_STATUS, () =>
    wrapIpc(() => acmPluginService.getStatus()),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_SET_ENABLED, (_event, enabled: unknown) =>
    wrapWriteIpcAsync<AcmPluginStatus>(() =>
      acmLifecycleQueue.run(async () => {
        if (typeof enabled !== "boolean")
          return {
            ok: false,
            error: "ACM 插件开关必须是布尔值",
            errorCode: "VALIDATION_FAILED" as const,
          };
        const current = acmPluginService.getStatus();
        if (!current.ok || !current.data) return current;
        if (current.data.state === "initializing")
          return {
            ok: false,
            error: "ACM 插件仍在初始化，请稍后重试",
            errorCode: "ACM_PLUGIN_INVALID" as const,
          };
        if (!enabled) {
          const stopped = await acmRunnerService.stop();
          if (!stopped.ok)
            return {
              ok: false,
              error: stopped.error,
              errorCode: stopped.errorCode,
            };
          const stoppedDiff = await acmDifferService.stop();
          if (!stoppedDiff.ok)
            return {
              ok: false,
              error: stoppedDiff.error,
              errorCode: stoppedDiff.errorCode,
            };
        }
        return acmPluginService.setEnabled(enabled);
      }),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_RETRY, () =>
    wrapIpcAsync(() => acmLifecycleQueue.run(() => acmPluginService.retry())),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_NOTICE_GET_STATE, () =>
    wrap(() => acmNoticeState()),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_NOTICE_DISMISS, () =>
    wrapWrite(() => setAcmNoticeVersion(PRODUCT_VERSION)),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_NOTICE_CLEAR, () =>
    wrapWrite(() => setAcmNoticeVersion(null)),
  );

  registerIpcHandler(
    IPC_CHANNELS.ACM_DOCUMENT_CREATE,
    (event, template: unknown, scope: unknown) =>
      wrapIpc(() =>
        withAcm(() =>
          acmFileService.createDocument(
            parseIpc(acmTemplateSchema, template),
            parseDocumentScope(event.sender, scope),
          ),
        ),
      ),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_DOCUMENT_OPEN, (event, scope: unknown) =>
    wrapIpcAsync(async () => {
      const unavailable = acmUnavailable<AcmDocument | null>();
      if (unavailable) return unavailable;
      return acmFileService.openDocument(
        BrowserWindow.fromWebContents(event.sender),
        parseDocumentScope(event.sender, scope),
      );
    }),
  );
  registerIpcHandler(
    IPC_CHANNELS.ACM_DOCUMENT_SAVE,
    (_event, request: unknown) =>
      wrapIpcAsync(async () => {
        const unavailable = acmUnavailable<AcmDocument>();
        if (unavailable) return unavailable;
        return acmFileService.saveDocument(
          parseIpc(acmDocumentSaveSchema, request),
        );
      }),
  );
  registerIpcHandler(
    IPC_CHANNELS.ACM_DOCUMENT_SAVE_AS,
    (event, request: unknown) =>
      wrapIpcAsync(async () => {
        const unavailable = acmUnavailable<AcmDocument | null>();
        if (unavailable) return unavailable;
        return acmFileService.saveDocumentAs(
          parseIpc(acmDocumentSaveSchema, request),
          BrowserWindow.fromWebContents(event.sender),
        );
      }),
  );
  registerIpcHandler(
    IPC_CHANNELS.ACM_DOCUMENT_RELEASE,
    (_event, documentId: unknown) =>
      wrapIpc(() =>
        acmFileService.releaseDocument(
          parseIpc(acmDocumentReleaseSchema, documentId),
        ),
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.ACM_DOCUMENT_CHECK_EXTERNAL,
    (_event, document: unknown) =>
      wrapIpcAsync(async () => {
        const unavailable = acmUnavailable<AcmDocumentExternalState>();
        if (unavailable) return unavailable;
        return acmFileService.checkExternal(
          parseIpc(acmExternalDocumentSchema, document),
        );
      }),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_COMPILER_GET_SELECTION, () =>
    wrapIpc(() => withAcm(() => acmCompilerService.getSelection())),
  );
  registerIpcHandler(
    IPC_CHANNELS.ACM_COMPILER_SET_SELECTION,
    (_event, selection: unknown) =>
      wrapIpc(() =>
        withAcm(() =>
          acmCompilerService.setSelection(
            parseIpc(acmCompilerSelectionSchema, selection),
          ),
        ),
      ),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_COMPILER_SELECT_PATH, (event) =>
    wrapIpcAsync(async () => {
      const unavailable = acmUnavailable<CompilerSelection | null>();
      if (unavailable) return unavailable;
      return acmCompilerService.selectCompilerPath(
        BrowserWindow.fromWebContents(event.sender),
      );
    }),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_COMPILER_PROBE, () =>
    wrapIpcAsync(async () => {
      const unavailable = acmUnavailable<CompilerProbeResult>();
      if (unavailable) return unavailable;
      const result = await acmCompilerService.probe();
      if (result.ok && result.data)
        acmPluginService.setCompilerHealth(
          result.data.available,
          result.data.reason,
        );
      return result;
    }),
  );
  registerIpcHandler(
    IPC_CHANNELS.ACM_RUNNER_START,
    (_event, request: unknown) =>
      wrapIpcAsync(() =>
        acmLifecycleQueue.runDetached(() => {
          const unavailable = acmExecutionUnavailable<{ taskId: string }>();
          if (unavailable) return unavailable;
          return acmRunnerService.start(
            parseIpc(acmRunnerStartSchema, request),
          );
        }),
      ),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_RUNNER_STOP, () =>
    wrapIpcAsync(() =>
      acmLifecycleQueue.run(async () => {
        const unavailable = acmExecutionUnavailable<boolean>();
        if (unavailable) return unavailable;
        return acmRunnerService.stop();
      }),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_DIFF_START, (_event, request: unknown) =>
    wrapIpcAsync(() =>
      acmLifecycleQueue.runDetached(() => {
        const unavailable = acmExecutionUnavailable<{ taskId: string }>();
        if (unavailable) return unavailable;
        const parsed = parseIpc(
          acmDiffStartSchema,
          request,
        ) as AcmDiffStartRequest;
        return acmDifferService.start(parsed);
      }),
    ),
  );
  registerIpcHandler(IPC_CHANNELS.ACM_DIFF_STOP, () =>
    wrapIpcAsync(() =>
      acmLifecycleQueue.run(async () => {
        const unavailable = acmExecutionUnavailable<boolean>();
        if (unavailable) return unavailable;
        return acmDifferService.stop();
      }),
    ),
  );
  acmRunnerService.onEvent((event: RunnerEvent) => {
    const win = windowService.getMainWindow();
    if (win && !win.isDestroyed())
      win.webContents.send(IPC_CHANNELS.ACM_RUNNER_EVENT, event);
  });
  acmDifferService.onEvent((event: AcmDiffEvent) => {
    const win = windowService.getMainWindow();
    if (win && !win.isDestroyed())
      win.webContents.send(IPC_CHANNELS.ACM_DIFF_EVENT, event);
  });
}

function registerIpcHandlers(): void {
  registerCrudHandlers();
  registerImportHandlers();
  registerNotificationHandlers();
  registerDataHandlers();
  registerSettingsHandlers();
  registerOcrComponentHandlers();
  registerAcmPluginHandlers();
  registerOnboardingHandlers();
}

async function disposeServices(): Promise<void> {
  for (const service of [...services].reverse()) {
    try {
      await service.dispose();
    } catch (error) {
      console.error(`[main] 释放服务失败: ${errorMessage(error)}`);
    }
  }
}

app.on("second-instance", () => windowService.showMainWindow());

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  protocol.handle("app-background", (request) => {
    try {
      const fileName = decodeURIComponent(
        new URL(request.url).pathname,
      ).replace(/^\/+/, "");
      if (!isSafeImageFileName(fileName))
        return new Response("Not found", { status: 404 });
      const filePath = path.join(
        app.getPath("userData"),
        "backgrounds",
        fileName,
      );
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.size > MAX_BACKGROUND_IMAGE_BYTES)
        return new Response("Not found", { status: 404 });
      assertImageSignature(fs.readFileSync(filePath), path.extname(fileName));
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });
  let criticalFailure: Error | null = null;
  for (const service of services) {
    try {
      await service.init();
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      console.error(`[main] 服务初始化失败: ${value.message}`);
      if (service === dataService || service === portableSettingsService) {
        criticalFailure = value;
        break;
      }
    }
  }
  if (criticalFailure) {
    const logPath = path.join(app.getPath("logs"), "main.log");
    dialog.showErrorBox(
      "大学生工具组无法启动",
      `本地关键服务初始化失败，应用未继续运行。\n\n${criticalFailure.message}\n\n日志位置：${logPath}`,
    );
    await disposeServices();
    app.exit(1);
    return;
  }
  try {
    registerIpcHandlers();
    registerReminderSystemEvents();
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox("大学生工具组无法启动", errorMessage(error));
    await disposeServices();
    app.exit(1);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", async (event) => {
  windowService.markQuitting();
  event.preventDefault();
  await disposeServices();
  const unconfirmed =
    acmRunnerService.hasUnconfirmedChild() ||
    acmDifferService.hasUnconfirmedChild();
  if (unconfirmed)
    console.warn("[main] ACM 子进程退出未确认，应用退出后外部进程可能残留");
  app.exit(0);
});
