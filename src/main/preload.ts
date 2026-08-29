// preload 脚本
// 职责：通过 contextBridge 安全地暴露主进程能力给渲染进程
// 严格遵守 Electron 安全最佳实践：contextIsolation + 不直接暴露 require/ipcRenderer
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AppearanceConfig,
  type CompilerSelection,
  type AcmDocumentSaveRequest,
  type AcmTemplateId,
  type AcmDocument,
  type RunnerEvent,
  type RunnerStartRequest,
  type OcrComponentStatus,
  type RendererApi,
  type UpdateStatusPayload,
} from "../shared/types";

// 统一的 invoke 封装，避免每个通道手写一遍 ipcRenderer.invoke
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

const api: RendererApi = {
  schedule: {
    list: () => invoke(IPC_CHANNELS.SCHEDULE_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.SCHEDULE_ADD, item),
    update: (id: string, patch: unknown) =>
      invoke(IPC_CHANNELS.SCHEDULE_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.SCHEDULE_REMOVE, id),
  },
  timetable: {
    list: () => invoke(IPC_CHANNELS.TIMETABLE_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.TIMETABLE_ADD, item),
    update: (id: string, patch: unknown) =>
      invoke(IPC_CHANNELS.TIMETABLE_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.TIMETABLE_REMOVE, id),
    getPreferences: () => invoke(IPC_CHANNELS.TIMETABLE_GET_PREFERENCES),
    setSemesterStart: (value: string | null) =>
      invoke(IPC_CHANNELS.TIMETABLE_SET_SEMESTER_START, value),
  },
  exam: {
    list: () => invoke(IPC_CHANNELS.EXAM_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.EXAM_ADD, item),
    update: (id: string, patch: unknown) =>
      invoke(IPC_CHANNELS.EXAM_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.EXAM_REMOVE, id),
  },
  lab: {
    list: () => invoke(IPC_CHANNELS.LAB_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.LAB_ADD, item),
    update: (id: string, patch: unknown) =>
      invoke(IPC_CHANNELS.LAB_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.LAB_REMOVE, id),
  },
  grade: {
    list: () => invoke(IPC_CHANNELS.GRADE_LIST),
    listPage: (query: unknown) => invoke(IPC_CHANNELS.GRADE_PAGE, query),
    getDashboard: () => invoke(IPC_CHANNELS.GRADE_DASHBOARD),
    add: (item: unknown) => invoke(IPC_CHANNELS.GRADE_ADD, item),
    update: (id: string, patch: unknown) =>
      invoke(IPC_CHANNELS.GRADE_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.GRADE_REMOVE, id),
  },
  formula: {
    get: (id: string) => invoke(IPC_CHANNELS.FORMULA_GET, id),
    save: (formula: unknown) => invoke(IPC_CHANNELS.FORMULA_SAVE, formula),
    list: () => invoke(IPC_CHANNELS.FORMULA_LIST),
  },
  periodConfig: {
    get: () => invoke(IPC_CHANNELS.PERIOD_CONFIG_GET),
    save: (config: unknown) => invoke(IPC_CHANNELS.PERIOD_CONFIG_SAVE, config),
  },
  importBrowser: {
    openBrowser: () => invoke(IPC_CHANNELS.TIMETABLE_OPEN_BROWSER),
    closeBrowser: () => invoke(IPC_CHANNELS.TIMETABLE_CLOSE_BROWSER),
    extractDom: () => invoke(IPC_CHANNELS.TIMETABLE_EXTRACT_DOM),
    capturePage: () => invoke(IPC_CHANNELS.TIMETABLE_CAPTURE_PAGE),
    parseDom: (html: string) => invoke(IPC_CHANNELS.TIMETABLE_PARSE_DOM, html),
    runOcr: (imageBase64: string) =>
      invoke(IPC_CHANNELS.TIMETABLE_RUN_OCR, imageBase64),
  },
  examImport: {
    parseDomForExams: (html: string) =>
      invoke(IPC_CHANNELS.EXAM_PARSE_DOM, html),
    runOcrForExams: (imageBase64: string) =>
      invoke(IPC_CHANNELS.EXAM_RUN_OCR, imageBase64),
  },
  labImport: {
    parseDomForLabs: (html: string) => invoke(IPC_CHANNELS.LAB_PARSE_DOM, html),
    runOcrForLabs: (imageBase64: string) =>
      invoke(IPC_CHANNELS.LAB_RUN_OCR, imageBase64),
  },
  notify: {
    send: (payload: unknown) => invoke(IPC_CHANNELS.NOTIFY_SEND, payload),
    setDnd: (config: unknown) => invoke(IPC_CHANNELS.NOTIFY_SET_DND, config),
    getDnd: () => invoke(IPC_CHANNELS.NOTIFY_GET_DND),
    getHistory: () => invoke(IPC_CHANNELS.NOTIFY_GET_HISTORY),
    clearHistory: () => invoke(IPC_CHANNELS.NOTIFY_CLEAR_HISTORY),
  },
  data: {
    exportBackup: () => invoke(IPC_CHANNELS.DATA_EXPORT_BACKUP),
    prepareImport: () => invoke(IPC_CHANNELS.DATA_PREPARE_IMPORT),
    commitImport: (token: string) =>
      invoke(IPC_CHANNELS.DATA_COMMIT_IMPORT, token),
    cancelImport: (token: string) =>
      invoke(IPC_CHANNELS.DATA_CANCEL_IMPORT, token),
    onRestoreCompleted: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.DATA_RESTORE_COMPLETED, handler);
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.DATA_RESTORE_COMPLETED,
          handler,
        );
    },
  },
  update: {
    checkManual: () => invoke(IPC_CHANNELS.UPDATE_CHECK),
    installUpdate: () => invoke(IPC_CHANNELS.UPDATE_INSTALL),
    getCurrentVersion: () => invoke(IPC_CHANNELS.UPDATE_GET_CURRENT_VERSION),
    getChannel: () => invoke(IPC_CHANNELS.UPDATE_GET_CHANNEL),
    // 返回取消订阅函数：调用方（React 组件）必须在卸载时调用，
    // 否则重复挂载会不断叠加 listener，最终触发 MaxListenersExceededWarning
    onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => {
      const handler = (_e: unknown, payload: UpdateStatusPayload) =>
        callback(payload);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, handler);
      };
    },
  },
  window: {
    minimize: () => invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: () => invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: () => invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    // 同 onUpdateStatus：返回取消订阅函数，避免 listener 叠加
    onMaximizeChange: (callback: (maximized: boolean) => void) => {
      const handler = (_e: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGE, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGE,
          handler,
        );
      };
    },
  },
  theme: {
    get: () => invoke(IPC_CHANNELS.THEME_GET),
    set: (mode: "system" | "light" | "dark") =>
      invoke(IPC_CHANNELS.THEME_SET, mode),
    getResolved: () => invoke(IPC_CHANNELS.THEME_GET_RESOLVED),
    // 同 onUpdateStatus：返回取消订阅函数，避免 listener 叠加
    onChange: (callback: (resolved: "light" | "dark") => void) => {
      const handler = (_e: unknown, resolved: "light" | "dark") =>
        callback(resolved);
      ipcRenderer.on(IPC_CHANNELS.THEME_ON_CHANGE, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.THEME_ON_CHANGE, handler);
      };
    },
  },
  appearance: {
    get: () => invoke(IPC_CHANNELS.APPEARANCE_GET),
    chooseBackground: () => invoke(IPC_CHANNELS.APPEARANCE_CHOOSE_BG),
    setMaterial: (mode: "none" | "acrylic") =>
      invoke(IPC_CHANNELS.APPEARANCE_SET_MATERIAL, mode),
    clearBackground: () => invoke(IPC_CHANNELS.APPEARANCE_CLEAR_BG),
    setBlur: (value: number) => invoke(IPC_CHANNELS.APPEARANCE_SET_BLUR, value),
    setClarity: (value: number) =>
      invoke(IPC_CHANNELS.APPEARANCE_SET_CLARITY, value),
    // 同 onUpdateStatus：外观弹窗每次打开都会重新订阅，不返回取消函数必然泄漏
    onChange: (callback: (config: AppearanceConfig) => void) => {
      const handler = (_e: unknown, config: AppearanceConfig) =>
        callback(config);
      ipcRenderer.on(IPC_CHANNELS.APPEARANCE_ON_CHANGE, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.APPEARANCE_ON_CHANGE, handler);
      };
    },
  },
  ocrComponent: {
    getStatus: () => invoke(IPC_CHANNELS.OCR_COMPONENT_GET_STATUS),
    install: () => invoke(IPC_CHANNELS.OCR_COMPONENT_INSTALL),
    cancelInstall: () => invoke(IPC_CHANNELS.OCR_COMPONENT_CANCEL_INSTALL),
    remove: () => invoke(IPC_CHANNELS.OCR_COMPONENT_REMOVE),
    onStatusChange: (callback: (status: OcrComponentStatus) => void) => {
      const handler = (_event: unknown, status: OcrComponentStatus) =>
        callback(status);
      ipcRenderer.on(IPC_CHANNELS.OCR_COMPONENT_ON_STATUS_CHANGE, handler);
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.OCR_COMPONENT_ON_STATUS_CHANGE,
          handler,
        );
    },
  },
  acm: {
    getStatus: () => invoke(IPC_CHANNELS.ACM_GET_STATUS),
    setEnabled: (enabled: boolean) =>
      invoke(IPC_CHANNELS.ACM_SET_ENABLED, enabled),
    retry: () => invoke(IPC_CHANNELS.ACM_RETRY),
    createDocument: (template: AcmTemplateId) =>
      invoke(IPC_CHANNELS.ACM_DOCUMENT_CREATE, template),
    openDocument: () => invoke(IPC_CHANNELS.ACM_DOCUMENT_OPEN),
    saveDocument: (request: AcmDocumentSaveRequest) =>
      invoke(IPC_CHANNELS.ACM_DOCUMENT_SAVE, request),
    saveDocumentAs: (request: AcmDocumentSaveRequest) =>
      invoke(IPC_CHANNELS.ACM_DOCUMENT_SAVE_AS, request),
    releaseDocument: (documentId: string) =>
      invoke(IPC_CHANNELS.ACM_DOCUMENT_RELEASE, documentId),
    checkDocumentExternal: (
      document: Pick<AcmDocument, "filePath" | "savedFingerprint">,
    ) => invoke(IPC_CHANNELS.ACM_DOCUMENT_CHECK_EXTERNAL, document),
    getCompilerSelection: () => invoke(IPC_CHANNELS.ACM_COMPILER_GET_SELECTION),
    setCompilerSelection: (selection: CompilerSelection) =>
      invoke(IPC_CHANNELS.ACM_COMPILER_SET_SELECTION, selection),
    selectCompilerPath: () => invoke(IPC_CHANNELS.ACM_COMPILER_SELECT_PATH),
    probeCompiler: () => invoke(IPC_CHANNELS.ACM_COMPILER_PROBE),
    startRunner: (request: RunnerStartRequest) =>
      invoke(IPC_CHANNELS.ACM_RUNNER_START, request),
    stopRunner: () => invoke(IPC_CHANNELS.ACM_RUNNER_STOP),
    onRunnerEvent: (callback: (event: RunnerEvent) => void) => {
      const handler = (_event: unknown, event: RunnerEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.ACM_RUNNER_EVENT, handler);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.ACM_RUNNER_EVENT, handler);
    },
  },
};

contextBridge.exposeInMainWorld("api", api);
