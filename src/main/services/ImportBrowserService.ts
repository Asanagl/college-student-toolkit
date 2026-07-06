// 嵌入式浏览器服务：创建 modal BrowserWindow 供用户登录教务系统，
// 提取页面 DOM 与截图供解析器使用。
// 实现阶段：Phase 3
import { BrowserWindow, ipcMain, type WebContents, type WebFrameMain } from 'electron';
import * as path from 'node:path';
import type { IpcResult } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/types';

/**
 * 子窗口工具栏 HTML：URL 输入框、刷新/后退按钮、"开始识别"按钮。
 * 通过 data: URL 加载，工具栏内通过 window.importBrowser 与主进程通信。
 */
const TOOLBAR_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>课程表导入 - 教务系统</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: 'Microsoft YaHei UI', sans-serif; background: #f0f2f5; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  #topbar { position: relative; z-index: 10; flex-shrink: 0; }
  .toolbar-bar {
    display: flex; gap: 8px; padding: 10px 14px; align-items: center;
    background: rgba(255, 255, 255, 0.65);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid rgba(255, 255, 255, 0.4);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
  }
  .toolbar-bar input {
    flex: 1; padding: 6px 12px; border: 1px solid rgba(217, 217, 217, 0.6);
    border-radius: 8px; font-size: 13px; background: rgba(255, 255, 255, 0.7);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    transition: all 0.2s ease; outline: none;
  }
  .toolbar-bar input:focus { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.1); }
  .toolbar-bar button {
    padding: 6px 12px; border: 1px solid rgba(217, 217, 217, 0.5);
    background: rgba(255, 255, 255, 0.6); border-radius: 8px; cursor: pointer;
    font-size: 13px; color: #333; transition: all 0.2s ease;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  .toolbar-bar button:hover { background: rgba(255, 255, 255, 0.85); transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08); }
  .toolbar-bar button:active { transform: translateY(0); }
  .toolbar-bar button.primary {
    background: linear-gradient(135deg, #1677ff, #4096ff);
    color: #fff; border: none; font-weight: 500;
    box-shadow: 0 2px 8px rgba(22, 119, 255, 0.3);
  }
  .toolbar-bar button.primary:hover { box-shadow: 0 4px 14px rgba(22, 119, 255, 0.4); transform: translateY(-1px); }
  .tip-bar {
    padding: 6px 14px; color: #5a6b7e; font-size: 12px;
    background: rgba(22, 119, 255, 0.06);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(22, 119, 255, 0.1);
  }
  iframe { flex: 1; border: none; width: 100%; }
</style>
</head>
<body>
  <div id="topbar">
    <div class="toolbar-bar">
      <button title="后退" onclick="window.importBrowser.sendAction('back')">←</button>
      <button title="前进" onclick="window.importBrowser.sendAction('forward')">→</button>
      <button title="刷新" onclick="window.importBrowser.sendAction('refresh')">⟳</button>
      <input id="url" placeholder="在此输入教务系统网址并回车访问" />
      <button onclick="navigate()">前往</button>
      <button class="primary" onclick="startExtract()">开始识别</button>
    </div>
    <div class="tip-bar">提示：登录教务系统并打开课表页面后，点击"开始识别"自动提取课程</div>
  </div>
  <iframe id="frame" src="about:blank"></iframe>
  <script>
    const urlInput = document.getElementById('url');
    function navigate() {
      const url = urlInput.value.trim();
      if (!url) return;
      window.importBrowser.sendAction({ type: 'navigate', url });
    }
    function startExtract() {
      window.importBrowser.sendAction({ type: 'extract' });
    }
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigate();
    });
    window.importBrowser.onAction(function (action) {
      if (action && action.type === 'urlChanged') {
        urlInput.value = action.url || '';
      }
    });
  </script>
</body>
</html>`;

/** 工具栏 preload 暴露的接口 */
interface ImportBrowserWindowApi {
  onAction: (callback: (action: unknown) => void) => void;
  sendAction: (action: unknown) => void;
}

declare global {
  interface Window {
    importBrowser?: ImportBrowserWindowApi;
  }
}

export class ImportBrowserService {
  private static instance: ImportBrowserService | null = null;
  private initialized = false;
  /** 子窗口实例；为 null 表示当前未打开 */
  private browserWin: BrowserWindow | null = null;
  /** 嵌入 iframe 的 webContents，由 attachIframeWebContents 注入 */
  private targetWebContents: WebContents | null = null;
  /** 缓存最近一次提取的 DOM 与截图，浏览器关闭后 extractDom/capturePage 仍可读取 */
  private cachedDom: string | null = null;
  private cachedScreenshotBase64: string | null = null;
  /** openBrowser() 的 resolve；子窗口关闭时调用 */
  private openResolver: ((value: IpcResult<boolean>) => void) | null = null;

  private constructor() {}

  static getInstance(): ImportBrowserService {
    if (!ImportBrowserService.instance) {
      ImportBrowserService.instance = new ImportBrowserService();
    }
    return ImportBrowserService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.registerIpcHandlers();
    this.initialized = true;
  }

  /** 注册子窗口工具栏的 action 通道（不走 shared IPC_CHANNELS） */
  private registerIpcHandlers(): void {
    // 工具栏 → 主进程：处理导航/刷新/识别等动作
    ipcMain.on('import-browser:action', (_e, action: unknown) => {
      void this.handleToolbarAction(action);
    });
  }

  /** 处理工具栏发来的 action */
  private async handleToolbarAction(action: unknown): Promise<void> {
    if (!this.browserWin || !this.targetWebContents) return;
    const a = action as { type: string; url?: string };
    try {
      switch (a.type) {
        case 'back':
          this.executeInIframe('history.back()');
          break;
        case 'forward':
          this.executeInIframe('history.forward()');
          break;
        case 'refresh':
          this.executeInIframe('location.reload()');
          break;
        case 'navigate':
          if (a.url) {
            // 在 iframe 内导航，工具栏保持可见（不替换整个窗口）
            this.browserWin.webContents.executeJavaScript(`
              (function () {
                var f = document.getElementById('frame');
                if (f) { f.src = ${JSON.stringify(a.url)}; }
              })();
            `).catch((err: unknown) => {
              console.error(`[ImportBrowserService] iframe 导航失败: ${(err as Error).message}`);
            });
            this.notifyUrlChanged(a.url);
          }
          break;
        case 'extract':
          await this.performExtraction();
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`[ImportBrowserService] action 处理失败: ${(err as Error).message}`);
    }
  }

  /** 执行 DOM 提取 + 截图，缓存后关闭子窗口 */
  private async performExtraction(): Promise<void> {
    if (!this.targetWebContents || !this.browserWin) return;
    // 优先在 iframe 子 frame 上提取 DOM；无子 frame 时降级到主 frame
    const iframeFrame = this.findIframeFrame();
    try {
      if (iframeFrame) {
        this.cachedDom = (await iframeFrame.executeJavaScript(
          'document.documentElement.outerHTML'
        )) as string;
      } else {
        // 降级：iframe 仍为 about:blank，提取主 frame（工具栏 HTML）
        this.cachedDom = (await this.targetWebContents.executeJavaScript(
          'document.documentElement.outerHTML'
        )) as string;
      }
    } catch (err) {
      console.error(`[ImportBrowserService] DOM 提取失败: ${(err as Error).message}`);
    }
    // 截图前隐藏顶栏，避免工具栏文字干扰 OCR
    try {
      await this.targetWebContents.executeJavaScript(`
        var bar = document.getElementById('topbar');
        if (bar) bar.style.display = 'none';
      `);
      const image = await this.targetWebContents.capturePage();
      this.cachedScreenshotBase64 = image.toPNG().toString('base64');
    } catch (err) {
      console.error(`[ImportBrowserService] 截图失败: ${(err as Error).message}`);
    } finally {
      // 恢复顶栏显示（虽然窗口即将关闭，保持一致性）
      try {
        await this.targetWebContents.executeJavaScript(`
          var bar = document.getElementById('topbar');
          if (bar) bar.style.display = '';
        `);
      } catch {
        // 忽略恢复失败
      }
      if (this.browserWin && !this.browserWin.isDestroyed()) {
        this.browserWin.close();
      }
    }
  }

  /**
   * 查找 iframe 对应的子 frame。
   * 返回第一个 URL 非 about:blank 且非 data: 的子 frame；无则返回 null。
   */
  private findIframeFrame(): WebFrameMain | null {
    if (!this.targetWebContents) return null;
    const frames = this.targetWebContents.mainFrame.frames;
    return (
      frames.find(
        (f) => f.url && f.url !== 'about:blank' && !f.url.startsWith('data:')
      ) ?? null
    );
  }

  /** 在 iframe 子 frame 上执行 JavaScript；无子 frame 时静默跳过 */
  private executeInIframe(code: string): void {
    const frame = this.findIframeFrame();
    if (frame) {
      frame.executeJavaScript(code).catch((err: unknown) => {
        console.error(`[ImportBrowserService] iframe 执行失败: ${(err as Error).message}`);
      });
    }
  }

  /**
   * 打开嵌入式浏览器子窗口。
   * promise 在子窗口关闭后 resolve（用户点击"开始识别"或手动关闭）。
   */
  async openBrowser(): Promise<IpcResult<boolean>> {
    if (this.browserWin) {
      this.browserWin.focus();
      return { ok: true, data: true };
    }
    this.cachedDom = null;
    this.cachedScreenshotBase64 = null;
    const win = new BrowserWindow({
      width: 1100,
      height: 720,
      modal: true,
      title: '课程表导入',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/importBrowserPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: false, // 允许跨域加载教务系统页面（部分系统 http）
      },
    });
    this.browserWin = win;

    // 加载工具栏页面
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOOLBAR_HTML));
    // 工具栏加载完成后，在工具栏内动态创建 iframe 并附加 webContents 监听
    this.attachIframeWebContents(win);

    return new Promise<IpcResult<boolean>>((resolve) => {
      this.openResolver = resolve;
      win.on('closed', () => {
        this.browserWin = null;
        this.targetWebContents = null;
        if (this.openResolver) {
          this.openResolver({ ok: true, data: true });
          this.openResolver = null;
        }
      });
    });
  }

  /** 在工具栏页面中创建 iframe 并把主 webContents 设为提取目标 */
  private attachIframeWebContents(win: BrowserWindow): void {
    // 通过 executeJavaScript 动态设置 iframe src 至 about:blank
    win.webContents.executeJavaScript(`
      (function () {
        var f = document.getElementById('frame');
        f.src = 'about:blank';
      })();
    `).catch((err: unknown) => {
      console.error(`[ImportBrowserService] iframe 初始化失败: ${(err as Error).message}`);
    });
    // 主 webContents 作为提取目标：capturePage 截取整个窗口，mainFrame.frames 访问 iframe DOM
    this.targetWebContents = win.webContents;
    // 监听 iframe 内导航：frame-created 在 iframe 加载新页面时触发，用于同步工具栏 URL
    win.webContents.on('frame-created', (_e, { frame }) => {
      const url = frame.url;
      if (url && url !== 'about:blank' && !url.startsWith('data:')) {
        this.notifyUrlChanged(url);
      }
    });
    // 拦截 iframe 内 window.open() / target=_blank，强制在当前 iframe 内导航
    // 部分教务系统会唤起多个标签页，此 handler 确保浏览器始终维持单标签页
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url && url !== 'about:blank') {
        // 将新窗口 URL 重定向到 iframe 内，避免弹出多个窗口
        win.webContents.executeJavaScript(`
          (function () {
            var f = document.getElementById('frame');
            if (f) { f.src = ${JSON.stringify(url)}; }
          })();
        `).catch((err: unknown) => {
          console.error(`[ImportBrowserService] 拦截新窗口导航失败: ${(err as Error).message}`);
        });
        this.notifyUrlChanged(url);
      }
      return { action: 'deny' };
    });
  }

  /** 通知工具栏 URL 已变更 */
  private notifyUrlChanged(url: string): void {
    if (this.browserWin && !this.browserWin.isDestroyed()) {
      this.browserWin.webContents.send('import-browser:action', { type: 'urlChanged', url });
    }
  }

  /** 关闭子窗口 */
  async closeBrowser(): Promise<IpcResult<boolean>> {
    if (this.browserWin && !this.browserWin.isDestroyed()) {
      this.browserWin.close();
    }
    return { ok: true, data: true };
  }

  /** 返回缓存的 DOM；未提取过则返回空字符串 */
  async extractDom(): Promise<IpcResult<string>> {
    if (this.cachedDom === null) {
      return { ok: false, error: '尚未提取 DOM，请先在浏览器中点击"开始识别"' };
    }
    return { ok: true, data: this.cachedDom };
  }

  /** 返回缓存的截图 base64；未提取过则返回错误 */
  async capturePage(): Promise<IpcResult<string>> {
    if (this.cachedScreenshotBase64 === null) {
      return { ok: false, error: '尚未截图，请先在浏览器中点击"开始识别"' };
    }
    return { ok: true, data: this.cachedScreenshotBase64 };
  }

  async dispose(): Promise<void> {
    if (this.browserWin && !this.browserWin.isDestroyed()) {
      this.browserWin.close();
    }
    this.browserWin = null;
    this.targetWebContents = null;
    this.cachedDom = null;
    this.cachedScreenshotBase64 = null;
    this.initialized = false;
  }
}

// 修正 getInstance 实现（避免上面写法歧义）
// (已直接在 class 内实现，此处无需覆盖)
export const importBrowserService = ImportBrowserService.getInstance();

// 注册 IPC handler（在 main.ts 中 import 本模块即自动注册）
// 注意：handler 必须在 app.whenReady 后调用，因此在 main.ts 的 registerIpcHandlers 中触发
export function registerImportBrowserIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_OPEN_BROWSER, () =>
    importBrowserService.openBrowser()
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_CLOSE_BROWSER, () =>
    importBrowserService.closeBrowser()
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_EXTRACT_DOM, () =>
    importBrowserService.extractDom()
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_CAPTURE_PAGE, () =>
    importBrowserService.capturePage()
  );
}
