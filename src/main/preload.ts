// preload 脚本
// 职责：通过 contextBridge 安全地暴露主进程能力给渲染进程
// 严格遵守 Electron 安全最佳实践：contextIsolation + 不直接暴露 require/ipcRenderer
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type AppearanceConfig } from '../shared/types';

// 统一的 invoke 封装，避免每个通道手写一遍 ipcRenderer.invoke
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

const api = {
  schedule: {
    list: () => invoke(IPC_CHANNELS.SCHEDULE_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.SCHEDULE_ADD, item),
    update: (id: string, patch: unknown) => invoke(IPC_CHANNELS.SCHEDULE_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.SCHEDULE_REMOVE, id),
  },
  timetable: {
    list: () => invoke(IPC_CHANNELS.TIMETABLE_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.TIMETABLE_ADD, item),
    update: (id: string, patch: unknown) => invoke(IPC_CHANNELS.TIMETABLE_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.TIMETABLE_REMOVE, id),
  },
  exam: {
    list: () => invoke(IPC_CHANNELS.EXAM_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.EXAM_ADD, item),
    update: (id: string, patch: unknown) => invoke(IPC_CHANNELS.EXAM_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.EXAM_REMOVE, id),
  },
  lab: {
    list: () => invoke(IPC_CHANNELS.LAB_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.LAB_ADD, item),
    update: (id: string, patch: unknown) => invoke(IPC_CHANNELS.LAB_UPDATE, id, patch),
    remove: (id: string) => invoke(IPC_CHANNELS.LAB_REMOVE, id),
  },
  grade: {
    list: () => invoke(IPC_CHANNELS.GRADE_LIST),
    add: (item: unknown) => invoke(IPC_CHANNELS.GRADE_ADD, item),
    update: (id: string, patch: unknown) => invoke(IPC_CHANNELS.GRADE_UPDATE, id, patch),
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
    runOcr: (imageBase64: string) => invoke(IPC_CHANNELS.TIMETABLE_RUN_OCR, imageBase64),
  },
  examImport: {
    parseDomForExams: (html: string) => invoke(IPC_CHANNELS.EXAM_PARSE_DOM, html),
    runOcrForExams: (imageBase64: string) => invoke(IPC_CHANNELS.EXAM_RUN_OCR, imageBase64),
  },
  labImport: {
    parseDomForLabs: (html: string) => invoke(IPC_CHANNELS.LAB_PARSE_DOM, html),
    runOcrForLabs: (imageBase64: string) => invoke(IPC_CHANNELS.LAB_RUN_OCR, imageBase64),
  },
  notify: {
    send: (payload: unknown) => invoke(IPC_CHANNELS.NOTIFY_SEND, payload),
    setDnd: (config: unknown) => invoke(IPC_CHANNELS.NOTIFY_SET_DND, config),
    getDnd: () => invoke(IPC_CHANNELS.NOTIFY_GET_DND),
    getHistory: () => invoke(IPC_CHANNELS.NOTIFY_GET_HISTORY),
    clearHistory: () => invoke(IPC_CHANNELS.NOTIFY_CLEAR_HISTORY),
  },
  data: {
    export: (filePath: string) => invoke(IPC_CHANNELS.DATA_EXPORT, filePath),
    import: (filePath: string) => invoke(IPC_CHANNELS.DATA_IMPORT, filePath),
    pickExportPath: () => invoke(IPC_CHANNELS.DATA_PICK_EXPORT_PATH),
    pickImportPath: () => invoke(IPC_CHANNELS.DATA_PICK_IMPORT_PATH),
  },
  update: {
    checkManual: () => invoke(IPC_CHANNELS.UPDATE_CHECK),
    installUpdate: () => invoke(IPC_CHANNELS.UPDATE_INSTALL),
    onUpdateStatus: (callback: (status: string) => void) => {
      // 仅监听，不返回 Promise；保留一次性 listener 以便后续扩展
      const handler = (_e: unknown, status: string) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, handler);
    },
  },
  window: {
    minimize: () => invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: () => invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: () => invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    onMaximizeChange: (callback: (maximized: boolean) => void) => {
      const handler = (_e: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGE, handler);
    },
  },
  theme: {
    get: () => invoke(IPC_CHANNELS.THEME_GET),
    set: (mode: 'system' | 'light' | 'dark') => invoke(IPC_CHANNELS.THEME_SET, mode),
    getResolved: () => invoke(IPC_CHANNELS.THEME_GET_RESOLVED),
    onChange: (callback: (resolved: 'light' | 'dark') => void) => {
      const handler = (_e: unknown, resolved: 'light' | 'dark') => callback(resolved);
      ipcRenderer.on(IPC_CHANNELS.THEME_ON_CHANGE, handler);
    },
  },
  appearance: {
    get: () => invoke(IPC_CHANNELS.APPEARANCE_GET),
    setMaterial: (mode: 'none' | 'acrylic') => invoke(IPC_CHANNELS.APPEARANCE_SET_MATERIAL, mode),
    uploadBackground: (filePath: string) => invoke(IPC_CHANNELS.APPEARANCE_UPLOAD_BG, filePath),
    clearBackground: () => invoke(IPC_CHANNELS.APPEARANCE_CLEAR_BG),
    setBlur: (value: number) => invoke(IPC_CHANNELS.APPEARANCE_SET_BLUR, value),
    setClarity: (value: number) => invoke(IPC_CHANNELS.APPEARANCE_SET_CLARITY, value),
    onChange: (callback: (config: AppearanceConfig) => void) => {
      const handler = (_e: unknown, config: AppearanceConfig) => callback(config);
      ipcRenderer.on(IPC_CHANNELS.APPEARANCE_ON_CHANGE, handler);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
