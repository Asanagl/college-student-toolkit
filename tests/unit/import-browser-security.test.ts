import { afterEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: any[]) => any;

  class FakeEmitter {
    private listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener): this {
      const handlers = this.listeners.get(event) ?? new Set<Listener>();
      handlers.add(listener);
      this.listeners.set(event, handlers);
      return this;
    }

    removeListener(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        void listener(...args);
      }
    }
  }

  class FakeWebContents extends FakeEmitter {
    destroyed = false;
    currentUrl = "https://jw.example.edu/current";
    historyIndex = 2;
    readonly historyEntries = [
      { url: "https://jw.example.edu/first", title: "first" },
      { url: "http://jw.example.edu/plain", title: "plain" },
      { url: "https://jw.example.edu/current", title: "current" },
    ];
    readonly navigationHistory = {
      getActiveIndex: () => this.historyIndex,
      getEntryAtIndex: (index: number) => this.historyEntries[index] ?? null,
      length: () => this.historyEntries.length,
    };
    // Electron does not emit will-frame-navigate for programmatic APIs such as
    // loadURL/back/reload. User/page navigation is simulated explicitly in tests.
    loadURL = vi.fn(async (url: string) => {
      this.currentUrl = url;
      this.emit("did-navigate", {}, url);
    });
    goBack = vi.fn(() => this.goToIndex(this.historyIndex - 1));
    goForward = vi.fn(() => this.goToIndex(this.historyIndex + 1));
    goToIndex = vi.fn((index: number) => {
      const entry = this.historyEntries[index];
      if (entry) {
        this.historyIndex = index;
        this.currentUrl = entry.url;
        this.emit("did-navigate", {}, entry.url);
      }
    });
    reload = vi.fn(() => {
      this.emit("did-navigate", {}, this.currentUrl);
    });
    setWindowOpenHandler = vi.fn();
    send = vi.fn();
    executeJavaScript = vi.fn(async () => "<html><body>fixture</body></html>");
    capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from("png") }));

    isDestroyed(): boolean {
      return this.destroyed;
    }

    getURL(): string {
      return this.currentUrl;
    }

    close(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("destroyed");
    }
  }

  class FakeBrowserWindow extends FakeEmitter {
    static instances: FakeBrowserWindow[] = [];
    readonly webContents = new FakeWebContents();
    readonly contentView = { addChildView: vi.fn() };
    readonly loadURL = vi.fn(async (_url: string) => undefined);
    readonly focus = vi.fn();
    readonly getContentSize = vi.fn(() => [1100, 720]);
    readonly options: unknown;
    destroyed = false;

    constructor(options: unknown) {
      super();
      this.options = options;
      FakeBrowserWindow.instances.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.close();
      this.emit("closed");
    }

    close(): void {
      this.destroy();
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = [];
    readonly webContents = new FakeWebContents();
    readonly setBounds = vi.fn();
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
      FakeWebContentsView.instances.push(this);
    }
  }

  class FakeSession extends FakeEmitter {
    static instances: FakeSession[] = [];
    readonly setPermissionCheckHandler = vi.fn();
    readonly setPermissionRequestHandler = vi.fn();
    readonly clearAuthCache = vi.fn(async () => undefined);
    readonly clearStorageData = vi.fn(async () => undefined);
    readonly clearCache = vi.fn(async () => undefined);

    constructor() {
      super();
      FakeSession.instances.push(this);
    }
  }

  const ipcListeners = new Map<string, Listener>();
  const ipcHandlers = new Map<string, Listener>();
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      ipcListeners.set(channel, listener);
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      if (ipcListeners.get(channel) === listener) ipcListeners.delete(channel);
    }),
    handle: vi.fn((channel: string, listener: Listener) => {
      ipcHandlers.set(channel, listener);
    }),
  };
  const dialog = {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  };
  const session = {
    fromPartition: vi.fn(() => new FakeSession()),
  };

  return {
    FakeBrowserWindow,
    FakeWebContentsView,
    FakeSession,
    dialog,
    ipcListeners,
    ipcHandlers,
    ipcMain,
    session,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMocks.FakeBrowserWindow,
  WebContentsView: electronMocks.FakeWebContentsView,
  dialog: electronMocks.dialog,
  ipcMain: electronMocks.ipcMain,
  session: electronMocks.session,
}));

import {
  ImportBrowserService,
  registerImportBrowserIpcHandlers,
  validateImportUrl,
} from "../../src/main/services/ImportBrowserService";
import { IPC_CHANNELS } from "../../src/shared/types";

describe("教务导入地址边界", () => {
  it.each([
    "file:///C:/secret.txt",
    "javascript:alert(1)",
    "data:text/html,x",
    "custom://host/path",
  ])("拒绝危险协议 %s", (value) => {
    expect(validateImportUrl(value)).toBeNull();
  });

  it.each([
    "\\\\server\\share",
    "C:\\secret.txt",
    "https://user:password@example.com",
  ])("拒绝本地路径或凭据 URL %s", (value) => {
    expect(validateImportUrl(value)).toBeNull();
  });

  it("只接受无凭据的 HTTP 或 HTTPS 地址", () => {
    expect(validateImportUrl("https://jw.example.edu/login")?.protocol).toBe(
      "https:",
    );
    expect(validateImportUrl("http://jw.example.edu/login")?.protocol).toBe(
      "http:",
    );
    expect(validateImportUrl("https://")).toBeNull();
    expect(validateImportUrl("https://a".repeat(700))).toBeNull();
  });
});

describe("教务导入临时窗口生命周期与导航安全", () => {
  const service = ImportBrowserService.getInstance();

  afterEach(async () => {
    await service.dispose();
    electronMocks.FakeBrowserWindow.instances.length = 0;
    electronMocks.FakeWebContentsView.instances.length = 0;
    electronMocks.FakeSession.instances.length = 0;
    electronMocks.ipcListeners.clear();
    electronMocks.ipcHandlers.clear();
    vi.clearAllMocks();
  });

  async function openForInteraction() {
    const completion = service.openBrowser();
    await Promise.resolve();
    await Promise.resolve();
    const window = electronMocks.FakeBrowserWindow.instances.at(-1);
    const view = electronMocks.FakeWebContentsView.instances.at(-1);
    const action = electronMocks.ipcListeners.get("import-browser:action");
    expect(window).toBeDefined();
    expect(view).toBeDefined();
    return { completion, window: window!, view: view!, action };
  }

  it("保持 openBrowser pending，直到提取完成并清理窗口", async () => {
    await service.init();
    const { completion, window, view, action } = await openForInteraction();
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const html = "<html><body>脱敏课程</body></html>";
    view.webContents.executeJavaScript.mockResolvedValue(html);
    await action?.({ sender: window.webContents }, "extract");
    await expect(completion).resolves.toMatchObject({ ok: true });
    expect((await service.extractDom()).data).toBe(html);
    expect((await service.capturePage()).data).toBe(
      Buffer.from("png").toString("base64"),
    );
    expect(view.webContents.isDestroyed()).toBe(true);
    expect(
      electronMocks.FakeSession.instances[0].clearStorageData,
    ).toHaveBeenCalled();
  });

  it("手动关闭时让 openBrowser 完成并返回空提取结果", async () => {
    const { completion, window } = await openForInteraction();
    const closeResult = service.closeBrowser();
    await expect(closeResult).resolves.toMatchObject({ ok: true });
    await expect(completion).resolves.toMatchObject({ ok: true });
    expect((await service.extractDom()).ok).toBe(false);
    expect(window.destroyed).toBe(true);
  });

  it("等待临时 session 清理完成后才允许创建下一代窗口", async () => {
    const first = await openForInteraction();
    const firstSession = electronMocks.FakeSession.instances[0];
    let releaseCleanup!: () => void;
    firstSession.clearStorageData.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );

    const closePromise = service.closeBrowser();
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseCleanup).toBeDefined();
    expect(electronMocks.FakeBrowserWindow.instances).toHaveLength(1);

    const secondCompletion = service.openBrowser();
    await Promise.resolve();
    expect(electronMocks.FakeBrowserWindow.instances).toHaveLength(1);
    releaseCleanup();
    await closePromise;
    await Promise.resolve();
    await Promise.resolve();
    expect(electronMocks.FakeBrowserWindow.instances).toHaveLength(2);
    await service.closeBrowser();
    await expect(secondCompletion).resolves.toMatchObject({ ok: true });
    await expect(first.completion).resolves.toMatchObject({ ok: true });
  });

  it("并发关闭和 dispose 都等待同一个清理 Promise", async () => {
    await openForInteraction();
    const firstSession = electronMocks.FakeSession.instances[0];
    let releaseCleanup!: () => void;
    firstSession.clearStorageData.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );

    const firstClose = service.closeBrowser();
    await Promise.resolve();
    await Promise.resolve();
    const secondClose = service.closeBrowser();
    expect(secondClose).toBe(firstClose);
    const dispose = service.dispose();
    let secondSettled = false;
    void secondClose.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    releaseCleanup();
    await expect(firstClose).resolves.toMatchObject({ ok: true });
    await expect(secondClose).resolves.toMatchObject({ ok: true });
    await expect(dispose).resolves.toBeUndefined();
  });

  it("处置开始后阻断并发打开，直到清理完成", async () => {
    await service.init();
    await openForInteraction();
    const firstSession = electronMocks.FakeSession.instances[0];
    let releaseCleanup!: () => void;
    firstSession.clearStorageData.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );

    const close = service.closeBrowser();
    await Promise.resolve();
    await Promise.resolve();
    const dispose = service.dispose();
    await expect(service.openBrowser()).resolves.toMatchObject({ ok: false });
    expect(electronMocks.FakeBrowserWindow.instances).toHaveLength(1);

    releaseCleanup();
    await expect(close).resolves.toMatchObject({ ok: true });
    await expect(dispose).resolves.toBeUndefined();
    expect(electronMocks.FakeBrowserWindow.instances).toHaveLength(1);
  });

  it("清理失败时阻止新一代，成功重试后才恢复", async () => {
    const first = await openForInteraction();
    const firstSession = electronMocks.FakeSession.instances[0];
    firstSession.clearStorageData.mockRejectedValue(
      new Error("storage failure"),
    );
    firstSession.clearAuthCache.mockRejectedValue(new Error("auth failure"));
    firstSession.clearCache.mockRejectedValue(new Error("cache failure"));

    await expect(service.closeBrowser()).resolves.toMatchObject({ ok: false });
    await expect(first.completion).resolves.toMatchObject({ ok: false });
    expect(first.window.destroyed).toBe(true);
    expect(firstSession.clearAuthCache).toHaveBeenCalledTimes(2);
    expect(firstSession.clearStorageData).toHaveBeenCalledTimes(2);
    expect(firstSession.clearCache).toHaveBeenCalledTimes(2);

    const blocked = await service.openBrowser();
    expect(blocked).toMatchObject({ ok: false });
    expect(electronMocks.FakeBrowserWindow.instances).toHaveLength(1);
    expect(firstSession.clearAuthCache).toHaveBeenCalledTimes(4);
    expect(firstSession.clearStorageData).toHaveBeenCalledTimes(4);
    expect(firstSession.clearCache).toHaveBeenCalledTimes(4);

    firstSession.clearStorageData.mockResolvedValue(undefined);
    firstSession.clearAuthCache.mockResolvedValue(undefined);
    firstSession.clearCache.mockResolvedValue(undefined);
    const secondCompletion = service.openBrowser();
    await vi.waitFor(() =>
      expect(electronMocks.FakeBrowserWindow.instances).toHaveLength(2),
    );
    await expect(service.closeBrowser()).resolves.toMatchObject({ ok: true });
    expect(firstSession.clearAuthCache).toHaveBeenCalledTimes(5);
    expect(firstSession.clearStorageData).toHaveBeenCalledTimes(5);
    expect(firstSession.clearCache).toHaveBeenCalledTimes(5);

    const second = {
      window: electronMocks.FakeBrowserWindow.instances[1],
    };
    expect(electronMocks.FakeSession.instances).toHaveLength(2);
    await expect(secondCompletion).resolves.toMatchObject({ ok: true });
    expect(second.window.destroyed).toBe(true);
  });

  it("旧代异步提取完成后不能清理新代窗口或覆盖新结果", async () => {
    await service.init();
    const first = await openForInteraction();
    const firstSession = electronMocks.FakeSession.instances[0];
    let releaseExtraction!: (value: string) => void;
    first.view.webContents.executeJavaScript.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseExtraction = resolve;
        }),
    );
    const oldExtraction = first.action?.(
      { sender: first.window.webContents },
      "extract",
    );
    await Promise.resolve();
    expect(releaseExtraction).toBeDefined();

    await service.closeBrowser();
    const second = await openForInteraction();
    releaseExtraction("<html><body>旧代</body></html>");
    await oldExtraction;
    expect(firstSession.clearStorageData).toHaveBeenCalledTimes(1);
    expect(second.view.webContents.isDestroyed()).toBe(false);
    expect((await service.extractDom()).ok).toBe(false);

    await service.closeBrowser();
    await expect(second.completion).resolves.toMatchObject({ ok: true });
  });

  it("renderer 崩溃时完成当前请求并清理临时 session", async () => {
    const { completion, view } = await openForInteraction();
    view.webContents.emit("render-process-gone", {}, "crashed");
    await expect(completion).resolves.toMatchObject({ ok: true });
    expect(view.webContents.isDestroyed()).toBe(true);
    expect(
      electronMocks.FakeSession.instances[0].clearAuthCache,
    ).toHaveBeenCalled();
    expect(
      electronMocks.FakeSession.instances[0].clearCache,
    ).toHaveBeenCalled();
  });

  it("工具栏 renderer 崩溃时也清理远程 view 和临时 session", async () => {
    const { completion, window, view } = await openForInteraction();
    window.webContents.emit("render-process-gone", {}, "crashed");
    await expect(completion).resolves.toMatchObject({ ok: true });
    expect(window.destroyed).toBe(true);
    expect(view.webContents.isDestroyed()).toBe(true);
  });

  it("远程 view 被单独销毁时也终结请求并清理临时 session", async () => {
    const { completion, window, view } = await openForInteraction();
    view.webContents.close();

    await expect(completion).resolves.toMatchObject({ ok: true });
    expect(window.destroyed).toBe(true);
    expect(
      electronMocks.FakeSession.instances[0].clearStorageData,
    ).toHaveBeenCalled();
  });

  it("处理 HTTPS、HTTP 审批、历史导航和刷新", async () => {
    await service.init();
    const { window, view, action } = await openForInteraction();

    await action?.({ sender: window.webContents }, { type: "back" });
    expect(electronMocks.dialog.showMessageBox).toHaveBeenCalled();
    expect(view.webContents.goToIndex).not.toHaveBeenCalled();

    electronMocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await action?.({ sender: window.webContents }, { type: "back" });
    expect(view.webContents.goToIndex).toHaveBeenCalledWith(1);
    expect(electronMocks.dialog.showMessageBox).toHaveBeenCalledTimes(2);

    await action?.({ sender: window.webContents }, { type: "forward" });
    expect(view.webContents.goToIndex).toHaveBeenCalledWith(2);
    await action?.({ sender: window.webContents }, { type: "refresh" });
    expect(view.webContents.reload).toHaveBeenCalled();

    await action?.(
      { sender: window.webContents },
      { type: "navigate", url: "https://jw.example.edu/login" },
    );
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "https://jw.example.edu/login",
    );

    electronMocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await action?.(
      { sender: window.webContents },
      { type: "navigate", url: "http://jw.example.edu/login" },
    );
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "http://jw.example.edu/login",
    );
    const approvalCount = electronMocks.dialog.showMessageBox.mock.calls.length;
    await action?.({ sender: window.webContents }, { type: "refresh" });
    expect(electronMocks.dialog.showMessageBox.mock.calls.length).toBe(
      approvalCount + 1,
    );
  });

  it("历史导航和刷新会把 HTTP 确认绑定到实际导航事件", async () => {
    await service.init();
    const { window, view, action } = await openForInteraction();
    electronMocks.dialog.showMessageBox.mockResolvedValue({ response: 1 });

    await action?.({ sender: window.webContents }, { type: "back" });
    expect(view.webContents.goToIndex).toHaveBeenCalledWith(1);
    expect(electronMocks.dialog.showMessageBox).toHaveBeenCalledTimes(1);

    await action?.({ sender: window.webContents }, { type: "refresh" });
    expect(view.webContents.reload).toHaveBeenCalledTimes(1);
    expect(electronMocks.dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("HTTPS 重定向会使旧 HTTP 确认失效", async () => {
    await service.init();
    const { window, view, action } = await openForInteraction();
    let releaseLoad!: () => void;
    view.webContents.loadURL.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
    );
    electronMocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });

    const navigation = action?.(
      { sender: window.webContents },
      { type: "navigate", url: "http://jw.example.edu/approved" },
    );
    await vi.waitFor(() =>
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        "http://jw.example.edu/approved",
      ),
    );

    const httpsRedirect = {
      preventDefault: vi.fn(),
      url: "https://jw.example.edu/secure",
      isMainFrame: true,
    };
    view.webContents.emit("will-redirect", httpsRedirect);
    expect(httpsRedirect.preventDefault).not.toHaveBeenCalled();

    electronMocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const staleHttp = {
      preventDefault: vi.fn(),
      url: "http://jw.example.edu/approved",
      isMainFrame: true,
    };
    view.webContents.emit("will-redirect", staleHttp);
    expect(staleHttp.preventDefault).toHaveBeenCalledTimes(1);

    releaseLoad();
    await navigation;
    await Promise.resolve();
    expect(electronMocks.dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("快速连续工具栏导航会使旧请求失效并按顺序加载", async () => {
    await service.init();
    const { window, view, action } = await openForInteraction();
    let releaseFirstLoad!: () => void;
    view.webContents.loadURL.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstLoad = resolve;
        }),
    );
    electronMocks.dialog.showMessageBox.mockResolvedValue({ response: 1 });

    const first = action?.(
      { sender: window.webContents },
      { type: "navigate", url: "http://jw.example.edu/approved" },
    );
    await vi.waitFor(() =>
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        "http://jw.example.edu/approved",
      ),
    );
    const second = action?.(
      { sender: window.webContents },
      { type: "navigate", url: "https://jw.example.edu/new-request" },
    );
    await Promise.resolve();
    expect(view.webContents.loadURL).not.toHaveBeenCalledWith(
      "https://jw.example.edu/new-request",
    );

    releaseFirstLoad();
    await first;
    await vi.waitFor(() =>
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        "https://jw.example.edu/new-request",
      ),
    );
    await second;
    const changedUrls = window.webContents.send.mock.calls
      .filter(([channel]) => channel === "import-browser:action")
      .map(([, message]) => (message as { url?: string }).url);
    expect(changedUrls).not.toContain("http://jw.example.edu/approved");
    expect(changedUrls).toContain("https://jw.example.edu/new-request");
  });

  it("程序化 HTTP 导航事件只能消费当前请求的审批", async () => {
    await service.init();
    const { window, view, action } = await openForInteraction();
    let releaseLoad!: () => void;
    view.webContents.loadURL.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
    );
    electronMocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });

    const navigation = action?.(
      { sender: window.webContents },
      { type: "navigate", url: "http://jw.example.edu/programmatic" },
    );
    await vi.waitFor(() =>
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        "http://jw.example.edu/programmatic",
      ),
    );

    const event = {
      preventDefault: vi.fn(),
      url: "http://jw.example.edu/programmatic",
      isMainFrame: true,
    };
    view.webContents.emit("will-frame-navigate", event);
    expect(event.preventDefault).not.toHaveBeenCalled();

    releaseLoad();
    await navigation;
  });

  it("拒绝无效发送者、危险导航和不安全子 frame", async () => {
    await service.init();
    const { view, action } = await openForInteraction();
    const foreignSender = new electronMocks.FakeBrowserWindow({}).webContents;
    await action?.({ sender: foreignSender }, { type: "refresh" });
    expect(view.webContents.reload).not.toHaveBeenCalled();

    const fileEvent = {
      preventDefault: vi.fn(),
      url: "file:///secret",
      isMainFrame: true,
    };
    view.webContents.emit("will-frame-navigate", fileEvent);
    expect(fileEvent.preventDefault).toHaveBeenCalledTimes(1);

    const httpFrameEvent = {
      preventDefault: vi.fn(),
      url: "http://jw.example.edu/frame",
      isMainFrame: false,
    };
    view.webContents.emit("will-frame-navigate", httpFrameEvent);
    expect(httpFrameEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.dialog.showMessageBox).not.toHaveBeenCalled();

    const httpMainEvent = {
      preventDefault: vi.fn(),
      url: "http://jw.example.edu/redirect",
      isMainFrame: true,
    };
    view.webContents.emit("will-redirect", httpMainEvent);
    await Promise.resolve();
    expect(httpMainEvent.preventDefault).toHaveBeenCalledTimes(1);

    const httpsUserNavigation = {
      preventDefault: vi.fn(),
      url: "https://jw.example.edu/next",
      isMainFrame: true,
    };
    view.webContents.emit("will-frame-navigate", httpsUserNavigation);
    expect(httpsUserNavigation.preventDefault).not.toHaveBeenCalled();

    electronMocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    const approvedRedirect = {
      preventDefault: vi.fn(),
      url: "http://jw.example.edu/approved-redirect",
      isMainFrame: true,
    };
    view.webContents.emit("will-redirect", approvedRedirect);
    await vi.waitFor(() =>
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        "http://jw.example.edu/approved-redirect",
      ),
    );
    expect(approvedRedirect.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("拒绝窗口弹出、下载和所有权限请求", async () => {
    await service.init();
    const { view } = await openForInteraction();
    const popupHandler = view.webContents.setWindowOpenHandler.mock
      .calls[0][0] as (details: { url: string }) => { action: string };
    expect(popupHandler({ url: "https://jw.example.edu/popup" })).toEqual({
      action: "deny",
    });
    const session = electronMocks.FakeSession.instances[0];
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    const check = session.setPermissionCheckHandler.mock
      .calls[0][0] as () => boolean;
    expect(check()).toBe(false);
    const request = session.setPermissionRequestHandler.mock.calls[0][0] as (
      contents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
    ) => void;
    const callback = vi.fn();
    request({}, "notifications", callback);
    expect(callback).toHaveBeenCalledWith(false);

    const download = { cancel: vi.fn() };
    session.emit("will-download", {}, download);
    expect(download.cancel).toHaveBeenCalledTimes(1);
  });

  it("覆盖初始化幂等、窗口复用、尺寸同步和异常动作", async () => {
    await service.init();
    await service.init();
    expect(electronMocks.ipcMain.on).toHaveBeenCalledTimes(1);
    const first = await openForInteraction();
    const secondCompletion = service.openBrowser();
    await Promise.resolve();
    expect(first.window.focus).toHaveBeenCalledTimes(1);
    first.window.emit("resize");
    expect(first.view.setBounds).toHaveBeenCalledTimes(2);

    await first.action?.(
      { sender: first.window.webContents },
      { type: "navigate" },
    );
    await first.action?.({ sender: first.window.webContents }, { type: 123 });
    first.view.webContents.navigationHistory.getEntryAtIndex = () => null;
    await first.action?.({ sender: first.window.webContents }, "back");
    await service.closeBrowser();
    await expect(secondCompletion).resolves.toMatchObject({ ok: true });
  });

  it("拒绝格式错误动作，并在窗口失效后安全降级", async () => {
    await service.init();
    const { window, view, action } = await openForInteraction();

    await action?.({ sender: window.webContents }, 123);
    await action?.(
      { sender: window.webContents },
      { type: "navigate", url: 123 },
    );
    await action?.(
      { sender: window.webContents },
      { type: "navigate", url: "file:///C:/secret.txt" },
    );
    expect(electronMocks.dialog.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ title: "地址不安全" }),
    );
    expect(view.webContents.loadURL).not.toHaveBeenCalledWith(
      "file:///C:/secret.txt",
    );

    view.webContents.reload.mockImplementationOnce(() => {
      throw new Error("reload failed");
    });
    await action?.({ sender: window.webContents }, "refresh");

    window.destroyed = true;
    window.emit("resize");
    electronMocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await action?.(
      { sender: window.webContents },
      { type: "navigate", url: "http://jw.example.edu/plain" },
    );
    await expect(service.closeBrowser()).resolves.toMatchObject({ ok: true });
  });

  it("提取超限或失败时清空结果并仍然清理 session", async () => {
    await service.init();
    const { completion, window, view, action } = await openForInteraction();
    view.webContents.executeJavaScript.mockResolvedValue(
      "x".repeat(8 * 1024 * 1024 + 1),
    );

    await action?.({ sender: window.webContents }, "extract");
    await expect(completion).resolves.toMatchObject({ ok: true });
    expect((await service.extractDom()).ok).toBe(false);
    expect((await service.capturePage()).ok).toBe(false);
    expect(
      electronMocks.FakeSession.instances[0].clearStorageData,
    ).toHaveBeenCalled();
  });

  it("只注册一次导入 IPC handlers", () => {
    registerImportBrowserIpcHandlers(() => false);
    registerImportBrowserIpcHandlers(() => true);
    expect(electronMocks.ipcMain.handle).toHaveBeenCalledTimes(4);
    const handler = electronMocks.ipcHandlers.get(
      IPC_CHANNELS.TIMETABLE_OPEN_BROWSER,
    );
    expect(handler).toBeDefined();
    expect(handler?.({})).toMatchObject({
      ok: false,
      errorCode: "IPC_UNAUTHORIZED",
    });
  });
});
