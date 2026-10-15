// 嵌入式浏览器子窗口专用 preload
// 职责：通过 contextBridge 暴露 window.importBrowser 给工具栏页面，
// 工具栏通过 sendAction 把"前往/刷新/开始识别"等动作发给主进程，
// 主进程通过 import-browser:action 通道反向推送状态变更（如 URL 变化）。
import { contextBridge, ipcRenderer } from 'electron';

const importBrowserApi = {
  /** 注册 action 监听器：主进程 → 工具栏（URL 变更等通知） */
  onAction: (callback: (action: unknown) => void): (() => void) => {
    const handler = (_e: unknown, action: unknown) => callback(action);
    ipcRenderer.on('import-browser:action', handler);
    return () => ipcRenderer.removeListener('import-browser:action', handler);
  },
  /** 发送 action 到主进程：工具栏 → 主进程（导航/刷新/识别） */
  sendAction: (action: unknown): void => {
    ipcRenderer.send('import-browser:action', action);
  },
};

contextBridge.exposeInMainWorld('importBrowser', importBrowserApi);
