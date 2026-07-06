// 主进程入口
// 职责：创建 BrowserWindow、初始化服务、注册 IPC handler、退出清理
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { IPC_CHANNELS, type IpcResult, type ThemeMode, type ResolvedTheme } from '../shared/types';
import { dataService } from './services/DataService';
import { notificationService } from './services/NotificationService';
import { scheduleService } from './services/ScheduleService';
import { timetableService } from './services/TimetableService';
import { examService } from './services/ExamService';
import { labService } from './services/LabService';
import { gradeService } from './services/GradeService';
import { updateService } from './services/UpdateService';
import { windowService } from './services/WindowService';
import { themeService } from './services/ThemeService';
import { importBrowserService, registerImportBrowserIpcHandlers } from './services/ImportBrowserService';
import { ocrService } from './services/OcrService';
import { parseDomWithAllParsers } from './services/parsers';
import { parseDomForExams } from './services/parsers/exam';
import { parseOcrToExams } from './services/ExamOcrParser';
import { parseDomForLabs } from './services/parsers/lab';
import { parseOcrToLabs } from './services/LabOcrParser';

// 所有需要在启动时初始化的服务
// 顺序：窗口/主题服务在前（窗口创建依赖状态恢复），数据层随后，业务服务最后
const services = [
  windowService,
  themeService,
  dataService,
  notificationService,
  scheduleService,
  timetableService,
  examService,
  labService,
  gradeService,
  updateService,
  importBrowserService,
  ocrService,
];

/**
 * 创建主窗口并加载页面。
 * 窗口标题栏/托盘/快捷键/右键菜单/状态持久化均由 WindowService 统一管理。
 */
function createMainWindow(): void {
  windowService.createMainWindow((win) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      win.loadURL(devUrl);
      win.webContents.openDevTools();
    } else {
      win.loadFile(path.join(__dirname, '../../dist/index.html'));
    }
  });
}

/**
 * 同步调用的统一错误包装：repository 方法均为同步，捕获异常转为 IpcResult。
 * 这样渲染进程拿到的都是 { ok, data?, error? } 结构，无需关心是否抛错。
 */
function wrap<T>(fn: () => T): IpcResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 异步调用的统一错误包装，用于导入导出等 Promise 场景 */
async function wrapAsync<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// 注册所有 IPC handler，绑定到对应服务
// Phase 1：数据 CRUD 直接走 DataService 的 repositories；业务 service 在 Phase 2-6 接入
function registerIpcHandlers(): void {
  // ===== 日程 =====
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_LIST, () => wrap(() => dataService.schedules.list()));
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_ADD, (_e, item) => wrap(() => dataService.schedules.add(item)));
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_UPDATE, (_e, id, patch) =>
    wrap(() => dataService.schedules.update(id, patch))
  );
  ipcMain.handle(IPC_CHANNELS.SCHEDULE_REMOVE, (_e, id) => wrap(() => dataService.schedules.remove(id)));

  // ===== 课程表（对应 courses 表）=====
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_LIST, () => wrap(() => dataService.courses.list()));
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_ADD, (_e, item) => wrap(() => dataService.courses.add(item)));
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_UPDATE, (_e, id, patch) =>
    wrap(() => dataService.courses.update(id, patch))
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_REMOVE, (_e, id) => wrap(() => dataService.courses.remove(id)));

  // ===== 节次配置（对应 period_config 表）=====
  ipcMain.handle(IPC_CHANNELS.PERIOD_CONFIG_GET, () => wrap(() => dataService.periodConfig.getAll()));
  ipcMain.handle(IPC_CHANNELS.PERIOD_CONFIG_SAVE, (_e, config) =>
    wrap(() => {
      dataService.periodConfig.saveAll(config);
      return true;
    })
  );

  // ===== 课程表导入：嵌入式浏览器 + DOM/OCR 解析 =====
  // openBrowser/closeBrowser/extractDom/capturePage 委托给 ImportBrowserService
  registerImportBrowserIpcHandlers();
  // parseDom：在主进程用 cheerio 解析 HTML，避免渲染进程引入大依赖
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_PARSE_DOM, (_e, html: string) =>
    wrap(() => parseDomWithAllParsers(html))
  );
  // runOcr：将 base64 转 Buffer 调用 OcrService，再解析文本为课程列表
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_RUN_OCR, async (_e, imageBase64: string) => {
    try {
      const buffer = Buffer.from(imageBase64, 'base64');
      const text = await ocrService.recognize(buffer);
      const courses = ocrService.parseOcrToCourses(text);
      return { ok: true, data: courses };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ===== 考试 =====
  ipcMain.handle(IPC_CHANNELS.EXAM_LIST, () => wrap(() => dataService.exams.list()));
  ipcMain.handle(IPC_CHANNELS.EXAM_ADD, (_e, item) => wrap(() => dataService.exams.add(item)));
  ipcMain.handle(IPC_CHANNELS.EXAM_UPDATE, (_e, id, patch) => wrap(() => dataService.exams.update(id, patch)));
  ipcMain.handle(IPC_CHANNELS.EXAM_REMOVE, (_e, id) => wrap(() => dataService.exams.remove(id)));
  // 考试导入：DOM 解析与 OCR 解析
  ipcMain.handle(IPC_CHANNELS.EXAM_PARSE_DOM, (_e, html: string) =>
    wrap(() => parseDomForExams(html))
  );
  ipcMain.handle(IPC_CHANNELS.EXAM_RUN_OCR, async (_e, imageBase64: string) => {
    try {
      const buffer = Buffer.from(imageBase64, 'base64');
      const text = await ocrService.recognize(buffer);
      const exams = parseOcrToExams(text);
      return { ok: true, data: exams };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ===== 实验 =====
  ipcMain.handle(IPC_CHANNELS.LAB_LIST, () => wrap(() => dataService.labs.list()));
  ipcMain.handle(IPC_CHANNELS.LAB_ADD, (_e, item) => wrap(() => dataService.labs.add(item)));
  ipcMain.handle(IPC_CHANNELS.LAB_UPDATE, (_e, id, patch) => wrap(() => dataService.labs.update(id, patch)));
  ipcMain.handle(IPC_CHANNELS.LAB_REMOVE, (_e, id) => wrap(() => dataService.labs.remove(id)));
  // 实验导入：DOM 解析与 OCR 解析
  ipcMain.handle(IPC_CHANNELS.LAB_PARSE_DOM, (_e, html: string) =>
    wrap(() => parseDomForLabs(html))
  );
  ipcMain.handle(IPC_CHANNELS.LAB_RUN_OCR, async (_e, imageBase64: string) => {
    try {
      const buffer = Buffer.from(imageBase64, 'base64');
      const text = await ocrService.recognize(buffer);
      const labs = parseOcrToLabs(text);
      return { ok: true, data: labs };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ===== 成绩 =====
  ipcMain.handle(IPC_CHANNELS.GRADE_LIST, () => wrap(() => dataService.grades.list()));
  ipcMain.handle(IPC_CHANNELS.GRADE_ADD, (_e, item) => wrap(() => dataService.grades.add(item)));
  ipcMain.handle(IPC_CHANNELS.GRADE_UPDATE, (_e, id, patch) => wrap(() => dataService.grades.update(id, patch)));
  ipcMain.handle(IPC_CHANNELS.GRADE_REMOVE, (_e, id) => wrap(() => dataService.grades.remove(id)));

  // ===== GPA 公式 =====
  ipcMain.handle(IPC_CHANNELS.FORMULA_GET, (_e, id) => wrap(() => dataService.formulas.getById(id)));
  ipcMain.handle(IPC_CHANNELS.FORMULA_SAVE, (_e, formula) => wrap(() => dataService.formulas.save(formula)));
  ipcMain.handle(IPC_CHANNELS.FORMULA_LIST, () => wrap(() => dataService.formulas.list()));

  // ===== 通知 =====
  ipcMain.handle(IPC_CHANNELS.NOTIFY_SEND, (_e, payload) => notificationService.send(payload));
  ipcMain.handle(IPC_CHANNELS.NOTIFY_SET_DND, (_e, config) => notificationService.setDnd(config));
  ipcMain.handle(IPC_CHANNELS.NOTIFY_GET_DND, () => notificationService.getDnd());
  ipcMain.handle(IPC_CHANNELS.NOTIFY_GET_HISTORY, () => notificationService.getHistory());
  ipcMain.handle(IPC_CHANNELS.NOTIFY_CLEAR_HISTORY, () => notificationService.clearHistory());

  // ===== 数据导入导出 =====
  // 先通过 dialog 选择文件路径，再交由 DataService 执行打包/解压
  ipcMain.handle(IPC_CHANNELS.DATA_PICK_EXPORT_PATH, async () => {
    const result = await dialog.showSaveDialog({
      title: '选择导出位置',
      defaultPath: 'toolkit-backup.zip',
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    return { ok: true, data: result.canceled ? null : result.filePath };
  });

  ipcMain.handle(IPC_CHANNELS.DATA_PICK_IMPORT_PATH, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择备份文件',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    return {
      ok: true,
      data: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0],
    };
  });

  ipcMain.handle(IPC_CHANNELS.DATA_EXPORT, (_e, filePath: string) =>
    wrapAsync(async () => {
      await dataService.exportToZip(filePath);
      return true;
    })
  );
  ipcMain.handle(IPC_CHANNELS.DATA_IMPORT, (_e, filePath: string) =>
    wrapAsync(async () => {
      await dataService.importFromZip(filePath);
      return true;
    })
  );

  // ===== 更新（Phase 7 实现）=====
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, () => updateService.checkManual());
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => updateService.installUpdate());

  // ===== 窗口控制（自定义标题栏按钮）=====
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    windowService.getMainWindow()?.minimize();
    return { ok: true, data: true };
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    const win = windowService.getMainWindow();
    if (!win) return { ok: true, data: false };
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { ok: true, data: true };
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, () => {
    windowService.getMainWindow()?.close();
    return { ok: true, data: true };
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => ({
    ok: true,
    data: windowService.getMainWindow()?.isMaximized() ?? false,
  }));
  // 最大化状态变更通知由 WindowService 在窗口创建时挂载（见 createMainWindow）

  // ===== 主题（跟随系统 + 手动切换）=====
  ipcMain.handle(IPC_CHANNELS.THEME_GET, () => ({
    ok: true,
    data: themeService.getMode() as ThemeMode,
  }));
  ipcMain.handle(IPC_CHANNELS.THEME_SET, (_e, mode: ThemeMode) => {
    themeService.setMode(mode);
    return { ok: true, data: true };
  });
  ipcMain.handle(IPC_CHANNELS.THEME_GET_RESOLVED, () => ({
    ok: true,
    data: themeService.getResolved() as ResolvedTheme,
  }));
}

// 应用退出时按依赖逆序释放资源
async function disposeServices(): Promise<void> {
  for (const service of [...services].reverse()) {
    try {
      await service.dispose();
    } catch {
      // 释放阶段忽略单点错误，继续清理其他服务
    }
  }
}

app.whenReady().then(async () => {
  // 服务初始化失败不阻断窗口创建，但记录到控制台
  for (const service of services) {
    try {
      await service.init();
    } catch (err) {
      console.error(`[main] 服务初始化失败: ${(err as Error).message}`);
    }
  }

  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    // macOS 下点击 Dock 图标时若没有窗口则重建
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // macOS 保留 Dock 行为；其他平台窗口全部关闭时退出
  // 注意：关闭按钮被 WindowService 拦截为隐藏到托盘，此事件仅在真正退出时触发
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  // 标记应用正在退出，使 WindowService 的 close 拦截不再 preventDefault
  windowService.markQuitting();
  event.preventDefault();
  await disposeServices();
  app.exit(0);
});

// 防止文件协议被解析为相对路径
void url;
