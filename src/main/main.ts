// 主进程入口：启动关键服务、注册经过 schema 校验的 IPC，并管理单实例与受限资源协议。
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  protocol,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  IPC_CHANNELS,
  type Course,
  type Exam,
  type GpaFormula,
  type Grade,
  type IpcErrorCode,
  type IpcResult,
  type Lab,
  type MaterialMode,
  type PeriodConfig,
  type Schedule,
} from "../shared/types";
import { PRODUCT_VERSION } from "../shared/version";
import { dataService } from "./services/DataService";
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
import { parseDomWithAllParsers } from "./services/parsers";
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
  windowService.createMainWindow((win) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) void win.loadURL(devUrl);
    else void win.loadFile(path.join(__dirname, "../../dist/index.html"));
  });
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
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_LIST, () =>
    wrap(() => dataService.schedules.list()),
  );
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_ADD, (_event, item: unknown) => {
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
  ipcMain.handle(
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
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.schedules.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.TIMETABLE_LIST, () =>
    wrap(() => dataService.courses.list()),
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_ADD, (_event, item: unknown) => {
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
  ipcMain.handle(
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
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.courses.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_GET_PREFERENCES, () =>
    timetableService.getPreferences(),
  );
  ipcMain.handle(
    IPC_CHANNELS.TIMETABLE_SET_SEMESTER_START,
    (_event, value: unknown) => {
      const result = wrapWrite(() =>
        timetableService.setSemesterStart(parseIpc(semesterStartSchema, value)),
      );
      if (result.ok) refreshReminders();
      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERIOD_CONFIG_GET, () =>
    wrap(() => dataService.periodConfig.getAll()),
  );
  ipcMain.handle(IPC_CHANNELS.PERIOD_CONFIG_SAVE, (_event, config: unknown) => {
    const result = wrapWrite(() => {
      dataService.periodConfig.saveAll(
        parseIpc(periodConfigSchema, config) as PeriodConfig[],
      );
      return true;
    });
    if (result.ok) refreshReminders();
    return result;
  });

  registerEntityHandlers();
}

function registerEntityHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.EXAM_LIST, () =>
    wrap(() => dataService.exams.list()),
  );
  ipcMain.handle(IPC_CHANNELS.EXAM_ADD, (_event, item: unknown) => {
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
  ipcMain.handle(
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
  ipcMain.handle(IPC_CHANNELS.EXAM_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.exams.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.LAB_LIST, () =>
    wrap(() => dataService.labs.list()),
  );
  ipcMain.handle(IPC_CHANNELS.LAB_ADD, (_event, item: unknown) => {
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
  ipcMain.handle(
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
  ipcMain.handle(IPC_CHANNELS.LAB_REMOVE, (_event, id: unknown) => {
    const result = wrapWrite(() =>
      dataService.labs.remove(parseIpc(tokenSchema, id)),
    );
    if (result.ok) refreshReminders();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.GRADE_LIST, () =>
    wrap(() => dataService.grades.list()),
  );
  ipcMain.handle(IPC_CHANNELS.GRADE_PAGE, (_event, query: unknown) =>
    wrap(() =>
      dataService.grades.listPage(parseIpc(gradePageQuerySchema, query)),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.GRADE_DASHBOARD, () =>
    wrap(() => dataService.grades.getDashboard(getDefaultGradeFormula())),
  );
  ipcMain.handle(IPC_CHANNELS.GRADE_ADD, (_event, item: unknown) =>
    wrapWrite(() =>
      dataService.grades.add(
        parseIpc(gradeAddSchema, item) as Omit<
          Grade,
          "id" | "createdAt" | "updatedAt"
        >,
      ),
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.GRADE_UPDATE,
    (_event, id: unknown, patch: unknown) =>
      wrapWrite(() =>
        dataService.grades.update(
          parseIpc(tokenSchema, id),
          parseIpc(gradePatchSchema, patch) as Partial<Grade>,
        ),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.GRADE_REMOVE, (_event, id: unknown) =>
    wrapWrite(() => dataService.grades.remove(parseIpc(tokenSchema, id))),
  );
  ipcMain.handle(IPC_CHANNELS.FORMULA_GET, (_event, id: unknown) =>
    wrap(() => dataService.formulas.getById(parseIpc(formulaIdSchema, id))),
  );
  ipcMain.handle(IPC_CHANNELS.FORMULA_LIST, () =>
    wrap(() => dataService.formulas.list()),
  );
  ipcMain.handle(IPC_CHANNELS.FORMULA_SAVE, (_event, formula: unknown) =>
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
  registerImportBrowserIpcHandlers();
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_PARSE_DOM, (_event, html: unknown) =>
    wrap(() => parseDomWithAllParsers(parseIpc(htmlSchema, html))),
  );
  ipcMain.handle(IPC_CHANNELS.EXAM_PARSE_DOM, (_event, html: unknown) =>
    wrap(() => parseDomForExams(parseIpc(htmlSchema, html))),
  );
  ipcMain.handle(IPC_CHANNELS.LAB_PARSE_DOM, (_event, html: unknown) =>
    wrap(() => parseDomForLabs(parseIpc(htmlSchema, html))),
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_RUN_OCR, (_event, image: unknown) =>
    runOcr(image, "course"),
  );
  ipcMain.handle(IPC_CHANNELS.EXAM_RUN_OCR, (_event, image: unknown) =>
    runOcr(image, "exam"),
  );
  ipcMain.handle(IPC_CHANNELS.LAB_RUN_OCR, (_event, image: unknown) =>
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
  ipcMain.handle(IPC_CHANNELS.NOTIFY_SEND, (_event, payload: unknown) =>
    wrapWriteIpcAsync(() =>
      notificationService.send(parseIpc(notificationPayloadSchema, payload)),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFY_SET_DND, (_event, config: unknown) =>
    wrapWriteIpcAsync(() =>
      notificationService.setDnd(parseIpc(dndSchema, config)),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFY_GET_DND, () =>
    wrapIpcAsync(() => notificationService.getDnd()),
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFY_GET_HISTORY, () =>
    wrapIpcAsync(() => notificationService.getHistory()),
  );
  ipcMain.handle(IPC_CHANNELS.NOTIFY_CLEAR_HISTORY, () =>
    wrapWriteIpcAsync(() => notificationService.clearHistory()),
  );
}

function registerDataHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DATA_EXPORT_BACKUP, (event) =>
    wrapIpcAsync(() =>
      dataService.exportBackup(BrowserWindow.fromWebContents(event.sender)),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.DATA_PREPARE_IMPORT, (event) =>
    wrapIpcAsync(() =>
      dataService.prepareImport(
        event.sender.id,
        BrowserWindow.fromWebContents(event.sender),
      ),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.DATA_COMMIT_IMPORT, (event, token: unknown) =>
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
  ipcMain.handle(IPC_CHANNELS.DATA_CANCEL_IMPORT, (event, token: unknown) =>
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
  ipcMain.handle(IPC_CHANNELS.THEME_GET, () =>
    wrap(() => themeService.getMode()),
  );
  ipcMain.handle(IPC_CHANNELS.THEME_SET, (_event, mode: unknown) =>
    wrapWrite(() => {
      themeService.setMode(parseIpc(themeModeSchema, mode));
      return true;
    }),
  );
  ipcMain.handle(IPC_CHANNELS.THEME_GET_RESOLVED, () =>
    wrap(() => themeService.getResolved()),
  );
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_GET, () =>
    wrap(() => appearanceService.getConfig()),
  );
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_CHOOSE_BG, () =>
    wrapWriteAsync(() => appearanceService.chooseBackgroundImage()),
  );
  ipcMain.handle(
    IPC_CHANNELS.APPEARANCE_SET_MATERIAL,
    (_event, mode: unknown) =>
      wrapWrite(() => {
        appearanceService.setMaterial(
          parseIpc(materialModeSchema, mode) as MaterialMode,
        );
        return true;
      }),
  );
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_CLEAR_BG, () =>
    wrapWriteAsync(async () => {
      await appearanceService.clearBackgroundImage();
      return true;
    }),
  );
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_SET_BLUR, (_event, value: unknown) =>
    wrapWrite(() => {
      appearanceService.setBlurRadius(parseIpc(blurSchema, value));
      return true;
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.APPEARANCE_SET_CLARITY,
    (_event, value: unknown) =>
      wrapWrite(() => {
        appearanceService.setClarity(parseIpc(claritySchema, value));
        return true;
      }),
  );
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, () =>
    wrapIpcAsync(() => updateService.checkManual()),
  );
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () =>
    wrapWriteIpcAsync(() => updateService.installUpdate()),
  );
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_CURRENT_VERSION, () =>
    wrap(() => PRODUCT_VERSION),
  );
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_CHANNEL, () =>
    wrap(() => updateService.getChannel()),
  );
}

function registerOcrComponentHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.OCR_COMPONENT_GET_STATUS, () =>
    wrapIpc(() => ocrComponentService.getStatus()),
  );
  ipcMain.handle(IPC_CHANNELS.OCR_COMPONENT_INSTALL, () =>
    wrapWriteIpcAsync(async () => {
      const result = await ocrComponentService.install();
      if (result.ok) await ocrService.invalidateWorker();
      return result;
    }),
  );
  ipcMain.handle(IPC_CHANNELS.OCR_COMPONENT_CANCEL_INSTALL, () =>
    wrapWriteIpc(() => ocrComponentService.cancelInstall()),
  );
  ipcMain.handle(IPC_CHANNELS.OCR_COMPONENT_REMOVE, () =>
    wrapWriteIpcAsync(async () => {
      const result = ocrComponentService.remove();
      if (result.ok) await ocrService.invalidateWorker();
      return result;
    }),
  );
}

function registerIpcHandlers(): void {
  registerCrudHandlers();
  registerImportHandlers();
  registerNotificationHandlers();
  registerDataHandlers();
  registerSettingsHandlers();
  registerOcrComponentHandlers();
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
  app.exit(0);
});
