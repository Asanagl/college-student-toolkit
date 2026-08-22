// 教务导入服务：本地工具栏与远程教务页面严格隔离。
// 远程页面使用 WebContentsView + 临时 partition，关闭导入窗口即销毁会话。
import {
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  session,
} from "electron";
import * as path from "node:path";
import { IPC_CHANNELS, type IpcResult } from "../../shared/types";

const TOOLBAR_HEIGHT = 88;
const MAX_DOM_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const ACTION_CHANNEL = "import-browser:action";

/** 工具栏页面只负责按钮和地址输入，不承载远程页面。 */
const TOOLBAR_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>教务系统导入</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:"Microsoft YaHei UI",sans-serif;background:#f0f2f5}
.bar{display:flex;gap:8px;align-items:center;padding:10px 14px;background:#fff;border-bottom:1px solid #d9d9d9;height:48px}
input{flex:1;min-width:100px;padding:6px 12px;border:1px solid #d9d9d9;border-radius:6px}
button{padding:6px 12px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;cursor:pointer}
button.primary{background:#1677ff;color:#fff;border-color:#1677ff}.tip{height:40px;padding:6px 14px;color:#5a6b7e;font-size:12px;background:#f5f9ff}
</style></head><body><div class="bar">
<button title="后退" onclick="send('back')">←</button><button title="前进" onclick="send('forward')">→</button>
<button title="刷新" onclick="send('refresh')">⟳</button><input id="url" placeholder="输入教务系统网址并回车">
<button onclick="go()">前往</button><button class="primary" onclick="send('extract')">开始识别</button>
</div><div class="tip">仅允许 HTTPS；HTTP 仅在本次明确确认后使用。导入窗口关闭后不会保存 Cookie、缓存或页面内容。</div>
<script>const input=document.getElementById('url');function send(action){window.importBrowser.sendAction(action)}
function go(){const value=input.value.trim();if(value)send({type:'navigate',url:value})}
input.addEventListener('keydown',e=>{if(e.key==='Enter')go()});window.importBrowser.onAction(action=>{
if(action&&action.type==='urlChanged')input.value=action.url||''})</script></body></html>`;

interface ToolbarAction {
  type?: string;
  url?: string;
}

interface ImportBrowserWindowApi {
  onAction: (callback: (action: unknown) => void) => () => void;
  sendAction: (action: unknown) => void;
}

type CleanupResult = IpcResult<boolean>;

interface BrowserGeneration {
  id: number;
  win: BrowserWindow;
  view: WebContentsView;
  remoteSession: Electron.Session;
  approvedHttpUrl: string | null;
  completion: Promise<CleanupResult>;
  resolveCompletion: (result: CleanupResult) => void;
  completionSettled: boolean;
  cleanupPromise: Promise<CleanupResult> | null;
  cleanupCompleted: boolean;
  cleanupResult: CleanupResult | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAction(value: unknown): ToolbarAction | null {
  if (typeof value === "string") return { type: value };
  if (!isPlainObject(value)) return null;
  if (typeof value.type !== "string") return null;
  if (value.type === "navigate" && typeof value.url !== "string") return null;
  return { type: value.type, url: value.url as string | undefined };
}

/** 统一校验远程地址，避免 file/javascript/data/UNC 和自定义协议逃逸。 */
export function validateImportUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return null;
  }
  if (raw.includes("\\") || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  return parsed;
}

export class ImportBrowserService {
  private static instance: ImportBrowserService | null = null;
  private initialized = false;
  private browserWin: BrowserWindow | null = null;
  private remoteView: WebContentsView | null = null;
  private remoteSession: Electron.Session | null = null;
  private activeGeneration: BrowserGeneration | null = null;
  private generationCounter = 0;
  private cleanupPromise: Promise<CleanupResult> | null = null;
  private failedCleanupGeneration: BrowserGeneration | null = null;
  private cleanupFailure: CleanupResult | null = null;
  private cachedDom: string | null = null;
  private cachedScreenshotBase64: string | null = null;
  private toolbarActionHandler:
    | ((
        event: Electron.IpcMainEvent,
        rawAction: unknown,
      ) => void | Promise<void>)
    | null = null;

  private constructor() {}

  static getInstance(): ImportBrowserService {
    if (!ImportBrowserService.instance) {
      ImportBrowserService.instance = new ImportBrowserService();
    }
    return ImportBrowserService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.toolbarActionHandler = (event, rawAction) => {
      const generation = this.activeGeneration;
      if (!generation || event.sender !== generation.win.webContents) return;
      const action = parseAction(rawAction);
      if (action) return this.handleToolbarAction(generation, action);
    };
    ipcMain.on(ACTION_CHANNEL, this.toolbarActionHandler);
    this.initialized = true;
  }

  private isCurrentGeneration(generation: BrowserGeneration): boolean {
    return (
      this.activeGeneration === generation &&
      !generation.win.isDestroyed() &&
      !generation.view.webContents.isDestroyed()
    );
  }

  private async handleToolbarAction(
    generation: BrowserGeneration,
    action: ToolbarAction,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    try {
      if (action.type === "back") {
        await this.navigateHistory(generation, -1);
        return;
      }
      if (action.type === "forward") {
        await this.navigateHistory(generation, 1);
        return;
      }
      if (action.type === "refresh") {
        await this.reload(generation);
        return;
      }
      if (action.type === "extract") {
        await this.performExtraction(generation);
        return;
      }
      if (action.type === "navigate" && action.url) {
        await this.navigate(generation, action.url);
      }
    } catch (error) {
      console.error(
        `[ImportBrowserService] action failed: ${(error as Error).message}`,
      );
    }
  }

  private async navigate(
    generation: BrowserGeneration,
    rawUrl: string,
  ): Promise<void> {
    const parsed = validateImportUrl(rawUrl);
    if (!parsed || !this.isCurrentGeneration(generation)) {
      await this.showWarning(
        generation,
        "地址不安全",
        "只允许有效的 HTTPS 或 HTTP 地址；不支持文件、脚本或自定义协议。",
      );
      return;
    }
    await this.loadAfterApproval(generation, parsed);
  }

  private async showWarning(
    generation: BrowserGeneration,
    title: string,
    message: string,
  ): Promise<void> {
    const options = { type: "warning" as const, title, message };
    if (!generation.win.isDestroyed()) {
      await dialog.showMessageBox(generation.win, options);
      return;
    }
    await dialog.showMessageBox(options);
  }

  private async approveHttp(generation: BrowserGeneration): Promise<boolean> {
    const options = {
      type: "warning" as const,
      title: "连接未加密",
      message: "该网站使用 HTTP，登录信息可能被窃取。是否仅本次继续？",
      buttons: ["取消", "继续"],
      defaultId: 0,
      cancelId: 0,
    };
    const result = !generation.win.isDestroyed()
      ? await dialog.showMessageBox(generation.win, options)
      : await dialog.showMessageBox(options);
    return result.response === 1 && this.isCurrentGeneration(generation);
  }

  private async loadAfterApproval(
    generation: BrowserGeneration,
    url: URL,
  ): Promise<void> {
    if (url.protocol === "http:") {
      const approved = await this.approveHttp(generation);
      if (!approved) return;
      generation.approvedHttpUrl = url.toString();
    }
    if (!this.isCurrentGeneration(generation)) return;
    const target = url.toString();
    try {
      await generation.view.webContents.loadURL(target);
      if (this.isCurrentGeneration(generation)) {
        this.notifyUrlChanged(generation, target);
      }
    } finally {
      if (generation.approvedHttpUrl === target) {
        generation.approvedHttpUrl = null;
      }
    }
  }

  private guardRemoteNavigation(
    generation: BrowserGeneration,
    event: Electron.Event,
    rawUrl: string,
    isMainFrame: boolean,
  ): void {
    const parsed = validateImportUrl(rawUrl);
    if (!parsed || !this.isCurrentGeneration(generation)) {
      event.preventDefault();
      return;
    }
    if (!isMainFrame) {
      if (parsed.protocol !== "https:") event.preventDefault();
      return;
    }
    if (parsed.protocol === "https:") return;
    if (generation.approvedHttpUrl === parsed.toString()) {
      generation.approvedHttpUrl = null;
      return;
    }
    event.preventDefault();
    void this.loadAfterApproval(generation, parsed).catch((error: unknown) => {
      console.error(
        `[ImportBrowserService] navigation approval failed: ${(error as Error).message}`,
      );
    });
  }

  private async navigateHistory(
    generation: BrowserGeneration,
    offset: -1 | 1,
  ): Promise<void> {
    const contents = generation.view.webContents;
    const history = contents.navigationHistory;
    const targetIndex = history.getActiveIndex() + offset;
    const entry = history.getEntryAtIndex(targetIndex);
    const target = entry ? validateImportUrl(entry.url) : null;
    if (!target || !this.isCurrentGeneration(generation)) return;
    if (target.protocol === "http:" && !(await this.approveHttp(generation))) {
      return;
    }
    if (!this.isCurrentGeneration(generation)) return;
    this.runApprovedHttpNavigation(generation, target, () => {
      contents.goToIndex(targetIndex);
    });
  }

  private async reload(generation: BrowserGeneration): Promise<void> {
    const target = validateImportUrl(generation.view.webContents.getURL());
    if (!target || !this.isCurrentGeneration(generation)) return;
    if (target.protocol === "http:" && !(await this.approveHttp(generation))) {
      return;
    }
    if (this.isCurrentGeneration(generation)) {
      this.runApprovedHttpNavigation(generation, target, () => {
        generation.view.webContents.reload();
      });
    }
  }

  private runApprovedHttpNavigation(
    generation: BrowserGeneration,
    target: URL,
    navigate: () => void,
  ): void {
    if (target.protocol !== "http:") {
      navigate();
      return;
    }
    const approvedUrl = target.toString();
    generation.approvedHttpUrl = approvedUrl;
    try {
      navigate();
    } finally {
      if (generation.approvedHttpUrl === approvedUrl) {
        generation.approvedHttpUrl = null;
      }
    }
  }

  private async performExtraction(
    generation: BrowserGeneration,
  ): Promise<void> {
    const contents = generation.view.webContents;
    if (!this.isCurrentGeneration(generation)) return;
    try {
      const html = (await contents.executeJavaScript(
        "document.documentElement.outerHTML",
      )) as unknown;
      if (
        typeof html !== "string" ||
        Buffer.byteLength(html, "utf8") > MAX_DOM_BYTES
      ) {
        throw new Error("页面内容超过 8 MiB 限制");
      }
      if (this.isCurrentGeneration(generation)) this.cachedDom = html;
      const png = (await contents.capturePage()).toPNG();
      if (png.byteLength > MAX_SCREENSHOT_BYTES) {
        throw new Error("页面截图超过 20 MiB 限制");
      }
      if (this.isCurrentGeneration(generation)) {
        this.cachedScreenshotBase64 = png.toString("base64");
      }
    } catch (error) {
      if (this.activeGeneration === generation) {
        this.cachedDom = null;
        this.cachedScreenshotBase64 = null;
      }
      console.error(
        `[ImportBrowserService] extraction failed: ${(error as Error).message}`,
      );
    } finally {
      await this.cleanupBrowser(generation);
    }
  }

  async openBrowser(): Promise<CleanupResult> {
    if (this.cleanupPromise) {
      const cleanup = await this.cleanupPromise;
      if (!cleanup.ok) return cleanup;
    }
    if (this.cleanupFailure && this.failedCleanupGeneration) {
      const retry = await this.cleanupBrowser(this.failedCleanupGeneration);
      if (!retry.ok) return retry;
    }
    if (this.cleanupFailure) return this.cleanupFailure;
    const current = this.activeGeneration;
    if (current) {
      if (
        !current.win.isDestroyed() &&
        !current.view.webContents.isDestroyed()
      ) {
        current.win.focus();
        return current.completion;
      }
      const cleanup = await this.cleanupBrowser(current);
      if (!cleanup.ok) return cleanup;
    }
    const generation = this.createGeneration();
    this.attachGeneration(generation);
    try {
      await generation.win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(TOOLBAR_HTML)}`,
      );
    } catch (error) {
      const cleanup = await this.cleanupBrowser(generation);
      if (!cleanup.ok) return cleanup;
      return {
        ok: false,
        error: `无法打开导入窗口：${(error as Error).message}`,
      };
    }
    return generation.completion;
  }

  private createGeneration(): BrowserGeneration {
    const remoteSession = session.fromPartition(
      `import-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      { cache: false },
    );
    remoteSession.setPermissionCheckHandler(() => false);
    remoteSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    remoteSession.on("will-download", (_event, item) => item.cancel());
    const win = new BrowserWindow({
      width: 1100,
      height: 720,
      modal: true,
      title: "教务系统导入",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/importBrowserPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const view = new WebContentsView({
      webPreferences: {
        session: remoteSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    let resolveCompletion!: (result: CleanupResult) => void;
    const completion = new Promise<CleanupResult>((resolve) => {
      resolveCompletion = resolve;
    });
    return {
      id: ++this.generationCounter,
      win,
      view,
      remoteSession,
      approvedHttpUrl: null,
      completion,
      resolveCompletion,
      completionSettled: false,
      cleanupPromise: null,
      cleanupCompleted: false,
      cleanupResult: null,
    };
  }

  private attachGeneration(generation: BrowserGeneration): void {
    this.activeGeneration = generation;
    this.browserWin = generation.win;
    this.remoteView = generation.view;
    this.remoteSession = generation.remoteSession;
    generation.win.contentView.addChildView(generation.view);
    this.setViewBounds(generation);
    this.registerGenerationHandlers(generation);
    generation.win.on("resize", () => this.setViewBounds(generation));
    generation.win.on("closed", () => {
      void this.cleanupBrowser(generation);
    });
    generation.view.webContents.on("render-process-gone", () => {
      void this.cleanupBrowser(generation);
    });
    generation.win.webContents.on("render-process-gone", () => {
      void this.cleanupBrowser(generation);
    });
    this.cachedDom = null;
    this.cachedScreenshotBase64 = null;
  }

  private setViewBounds(generation: BrowserGeneration): void {
    if (
      generation.win.isDestroyed() ||
      generation.view.webContents.isDestroyed()
    ) {
      return;
    }
    const [width, height] = generation.win.getContentSize();
    generation.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    });
  }

  private registerGenerationHandlers(generation: BrowserGeneration): void {
    const contents = generation.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (url) {
        void this.navigate(generation, url).catch((error: unknown) => {
          console.error(
            `[ImportBrowserService] popup navigation failed: ${(error as Error).message}`,
          );
        });
      }
      return { action: "deny" };
    });
    contents.on("will-frame-navigate", (details) => {
      this.guardRemoteNavigation(
        generation,
        details,
        details.url,
        details.isMainFrame,
      );
    });
    contents.on("will-redirect", (details) => {
      this.guardRemoteNavigation(
        generation,
        details,
        details.url,
        details.isMainFrame,
      );
    });
    contents.on("did-navigate", (_event, url) => {
      if (this.isCurrentGeneration(generation)) {
        this.notifyUrlChanged(generation, url);
      }
    });
  }

  private notifyUrlChanged(generation: BrowserGeneration, url: string): void {
    if (!generation.win.isDestroyed()) {
      generation.win.webContents.send(ACTION_CHANNEL, {
        type: "urlChanged",
        url,
      });
    }
  }

  private cleanupBrowser(
    generation?: BrowserGeneration,
  ): Promise<CleanupResult> {
    if (!generation && this.cleanupPromise) return this.cleanupPromise;
    const target =
      generation ?? this.activeGeneration ?? this.failedCleanupGeneration;
    if (!target) {
      return Promise.resolve(this.cleanupFailure ?? { ok: true, data: true });
    }
    if (target.cleanupCompleted && target.cleanupResult) {
      return Promise.resolve(target.cleanupResult);
    }
    if (target.cleanupPromise) return target.cleanupPromise;
    const tracksServiceCleanup =
      this.activeGeneration === target ||
      this.failedCleanupGeneration === target;
    const task = Promise.resolve()
      .then(() => this.performBrowserCleanup(target))
      .catch(
        (error: unknown): CleanupResult => ({
          ok: false,
          error: `导入窗口清理失败：${(error as Error).message}`,
        }),
      );
    const wrapped = task.then((result) => {
      if (this.activeGeneration === target) {
        this.activeGeneration = null;
        this.browserWin = null;
        this.remoteView = null;
        this.remoteSession = null;
      }
      if (result.ok) {
        if (this.failedCleanupGeneration === target) {
          this.failedCleanupGeneration = null;
          this.cleanupFailure = null;
        }
      } else {
        if (tracksServiceCleanup) {
          this.failedCleanupGeneration = target;
          this.cleanupFailure = result;
        }
      }
      target.cleanupResult = result;
      target.cleanupCompleted = result.ok;
      target.cleanupPromise = null;
      if (!target.completionSettled) {
        target.completionSettled = true;
        target.resolveCompletion(result);
      }
      if (this.cleanupPromise === wrapped) this.cleanupPromise = null;
      return result;
    });
    target.cleanupPromise = wrapped;
    if (tracksServiceCleanup) this.cleanupPromise = wrapped;
    return wrapped;
  }

  private async performBrowserCleanup(
    generation: BrowserGeneration,
  ): Promise<CleanupResult> {
    if (this.activeGeneration === generation) {
      this.activeGeneration = null;
      this.browserWin = null;
      this.remoteView = null;
      this.remoteSession = null;
    }
    generation.approvedHttpUrl = null;
    const sessionCleared = await this.clearSessionData(generation.remoteSession);
    if (!generation.view.webContents.isDestroyed()) {
      generation.view.webContents.close();
    }
    if (!generation.win.isDestroyed()) generation.win.destroy();
    if (sessionCleared) {
      return { ok: true, data: true };
    }
    return {
      ok: false,
      error: "无法确认教务临时会话已清理，请重试或重启应用后再试",
    };
  }

  private async clearSessionData(
    remoteSession: Electron.Session,
  ): Promise<boolean> {
    const clearers: Array<[string, () => Promise<void>]> = [
      ["认证缓存", () => remoteSession.clearAuthCache()],
      ["存储数据", () => remoteSession.clearStorageData()],
      ["HTTP 缓存", () => remoteSession.clearCache()],
    ];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const failures: string[] = [];
      for (const [label, clear] of clearers) {
        try {
          await clear();
        } catch (error) {
          failures.push(`${label}: ${(error as Error).message}`);
        }
      }
      if (failures.length === 0) return true;
      console.error(
        `[ImportBrowserService] session cleanup attempt ${attempt} failed: ${failures.join(
          "; ",
        )}`,
      );
    }
    return false;
  }

  closeBrowser(): Promise<CleanupResult> {
    return this.cleanupBrowser();
  }

  async extractDom(): Promise<IpcResult<string>> {
    return this.cachedDom === null
      ? { ok: false, error: "尚未提取 DOM，请先在浏览器中点击“开始识别”" }
      : { ok: true, data: this.cachedDom };
  }

  async capturePage(): Promise<IpcResult<string>> {
    return this.cachedScreenshotBase64 === null
      ? { ok: false, error: "尚未截图，请先在浏览器中点击“开始识别”" }
      : { ok: true, data: this.cachedScreenshotBase64 };
  }

  async dispose(): Promise<void> {
    await this.closeBrowser();
    if (this.toolbarActionHandler) {
      ipcMain.removeListener(ACTION_CHANNEL, this.toolbarActionHandler);
    }
    this.toolbarActionHandler = null;
    this.cachedDom = null;
    this.cachedScreenshotBase64 = null;
    this.initialized = false;
  }
}

export const importBrowserService = ImportBrowserService.getInstance();

let importBrowserIpcRegistered = false;

export function registerImportBrowserIpcHandlers(): void {
  if (importBrowserIpcRegistered) return;
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_OPEN_BROWSER, () =>
    importBrowserService.openBrowser(),
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_CLOSE_BROWSER, () =>
    importBrowserService.closeBrowser(),
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_EXTRACT_DOM, () =>
    importBrowserService.extractDom(),
  );
  ipcMain.handle(IPC_CHANNELS.TIMETABLE_CAPTURE_PAGE, () =>
    importBrowserService.capturePage(),
  );
  importBrowserIpcRegistered = true;
}

declare global {
  interface Window {
    importBrowser?: ImportBrowserWindowApi;
  }
}
