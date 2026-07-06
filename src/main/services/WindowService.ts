// 窗口服务：集中管理主窗口生命周期、状态持久化、系统托盘、全局快捷键、原生右键菜单。
// 将窗口相关逻辑从 main.ts 抽离，保持 main.ts 仅负责 IPC 注册与服务编排。
// 实现阶段：桌面端强制检查项（标题栏/托盘/快捷键/右键菜单/窗口状态）
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  screen,
  type WebContents,
} from 'electron';
import * as path from 'node:path';
import Store from 'electron-store';
import { IPC_CHANNELS } from '../../shared/types';

/** 窗口状态持久化字段 */
interface WindowStateSchema {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

/** 默认窗口尺寸，首次启动或状态丢失时使用 */
const DEFAULT_BOUNDS: WindowStateSchema = {
  width: 1280,
  height: 800,
  isMaximized: false,
};

/** 全局快捷键：Ctrl+Shift+T 显示/隐藏主窗口 */
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+T';

/** 标题栏 overlay 高度（px），与渲染进程 Header 高度一致 */
const TITLEBAR_HEIGHT = 40;

export class WindowService {
  private static instance: WindowService | null = null;
  private initialized = false;
  private store: Store<WindowStateSchema> | null = null;
  private tray: Tray | null = null;
  /** 主窗口引用，单例 */
  private mainWindow: BrowserWindow | null = null;
  /**
   * 退出标志：区分"用户点关闭按钮隐藏到托盘"与"真正退出"。
   * before-quit 事件触发时置 true，close 事件据此决定是否 preventDefault。
   */
  private isQuitting = false;

  private constructor() {}

  static getInstance(): WindowService {
    if (!WindowService.instance) {
      WindowService.instance = new WindowService();
    }
    return WindowService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.store = new Store<WindowStateSchema>({
      name: 'window-state',
      defaults: DEFAULT_BOUNDS,
    });
    this.initialized = true;
  }

  /** 创建主窗口，恢复上次位置/大小，并挂载托盘、快捷键、右键菜单 */
  createMainWindow(loadHandler: (win: BrowserWindow) => void): BrowserWindow {
    // 读取持久化的窗口状态；store 未初始化时回退到默认尺寸
    const state: WindowStateSchema = this.store ? this.store.store : DEFAULT_BOUNDS;
    // 确保窗口不出现在不可见的显示器上（如外接屏拔掉后坐标越界）
    const bounds = this.clampBoundsToVisible({
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
    });

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: 1024,
      minHeight: 600,
      title: '大学生工具组',
      show: false,
      autoHideMenuBar: true,
      // Windows 11 自定义标题栏：隐藏原生标题栏但保留窗口控制按钮
      // 配合 titleBarOverlay 使最小化/最大化/关闭按钮仍可用
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#001529',
        symbolColor: '#ffffff',
        height: TITLEBAR_HEIGHT,
      },
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // 最大化状态恢复（必须在窗口创建后调用）
    if (state.isMaximized) {
      win.maximize();
    }

    this.mainWindow = win;
    this.attachWindowStateListeners(win);
    this.setupTray();
    this.registerShortcuts();
    this.attachContextMenu(win.webContents);

    win.once('ready-to-show', () => {
      win.show();
    });

    // 拦截关闭：首次点关闭按钮时隐藏到托盘而非退出
    win.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });

    win.on('closed', () => {
      this.mainWindow = null;
    });

    loadHandler(win);
    return win;
  }

  /** 获取当前主窗口引用（可能为 null） */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /** 标记应用正在退出，使 close 事件不再 preventDefault */
  markQuitting(): void {
    this.isQuitting = true;
  }

  /** 显示并聚焦主窗口（从托盘恢复） */
  showMainWindow(): void {
    const win = this.mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // ==================== 窗口状态持久化 ====================

  /** 挂载窗口状态监听器，在 resize/move/maximize 时持久化 */
  private attachWindowStateListeners(win: BrowserWindow): void {
    const save = () => this.saveWindowState(win);
    // 节流：resize/move 触发频繁，延迟 500ms 合并写入
    let timer: NodeJS.Timeout | null = null;
    const debouncedSave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 500);
    };
    win.on('resize', debouncedSave);
    win.on('move', debouncedSave);
    win.on('maximize', () => {
      this.store?.set('isMaximized', true);
      // 通知渲染进程切换标题栏最大化按钮图标
      win.webContents.send(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGE, true);
    });
    win.on('unmaximize', () => {
      this.store?.set('isMaximized', false);
      win.webContents.send(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGE, false);
    });
    win.on('close', () => {
      // 同步写入，确保关闭前状态不丢失
      if (timer) clearTimeout(timer);
      save();
    });
  }

  private saveWindowState(win: BrowserWindow): void {
    if (!this.store) return;
    if (win.isMaximized()) {
      this.store.set('isMaximized', true);
      return;
    }
    const bounds = win.getBounds();
    // electron-store 支持传入对象一次性更新多个字段
    this.store.set({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: false,
    } satisfies WindowStateSchema);
  }

  /**
   * 将窗口坐标约束到可见显示器范围内，防止外接屏拔掉后窗口跑出屏幕
   */
  private clampBoundsToVisible(bounds: {
    x?: number;
    y?: number;
    width: number;
    height: number;
  }): { x?: number; y?: number; width: number; height: number } {
    const displays = screen.getAllDisplays();
    if (displays.length === 0 || bounds.x === undefined || bounds.y === undefined) {
      return bounds;
    }
    const visible = displays.some((display) => {
      const { x, y, width, height } = display.bounds;
      // 窗口至少有 100px 在某个显示器内才算可见
      return (
        bounds.x! + 100 > x &&
        bounds.x! < x + width - 100 &&
        bounds.y! + 100 > y &&
        bounds.y! < y + height - 100
      );
    });
    if (visible) return bounds;
    // 不可见时居中到主显示器
    const primary = screen.getPrimaryDisplay();
    return {
      x: Math.round(primary.bounds.x + (primary.bounds.width - bounds.width) / 2),
      y: Math.round(primary.bounds.y + (primary.bounds.height - bounds.height) / 2),
      width: bounds.width,
      height: bounds.height,
    };
  }

  // ==================== 系统托盘 ====================

  private setupTray(): void {
    if (this.tray) return;
    // 托盘图标使用应用图标，Windows 需要 16x16 或 32x32 ico/png
    const iconPath = path.join(__dirname, '../../resources/icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    // 缩小到托盘合适尺寸（Windows 推荐 16x16）
    if (!icon.isEmpty()) {
      icon = icon.resize({ width: 16, height: 16 });
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('大学生工具组');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => this.showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.isQuitting = true;
          app.quit();
        },
      },
    ]);
    this.tray.setContextMenu(contextMenu);

    // 单击托盘图标也显示主窗口
    this.tray.on('click', () => this.showMainWindow());
  }

  // ==================== 全局快捷键 ====================

  private registerShortcuts(): void {
    // Ctrl+Shift+T 切换主窗口显示/隐藏
    // 应用退出时必须注销，否则快捷键残留导致其他应用无法使用
    const success = globalShortcut.register(TOGGLE_SHORTCUT, () => {
      const win = this.mainWindow;
      if (!win) return;
      if (win.isVisible() && win.isFocused()) {
        win.hide();
      } else {
        this.showMainWindow();
      }
    });
    if (!success) {
      console.warn(`[WindowService] 全局快捷键 ${TOGGLE_SHORTCUT} 注册失败，可能被其他应用占用`);
    }
  }

  private unregisterShortcuts(): void {
    globalShortcut.unregister(TOGGLE_SHORTCUT);
    // unregisterAll 更保险，确保不留残留快捷键
    globalShortcut.unregisterAll();
  }

  // ==================== 原生右键菜单 ====================

  /**
   * 为 webContents 挂载原生右键菜单。
   * 使用 Electron Menu API 而非 DOM 模拟，保证与系统原生行为一致。
   */
  private attachContextMenu(webContents: WebContents): void {
    webContents.on('context-menu', (_event, params) => {
      const menu = Menu.buildFromTemplate(this.buildContextMenuItems(params));
      menu.popup();
    });
  }

  private buildContextMenuItems(params: Electron.ContextMenuParams): Electron.MenuItemConstructorOptions[] {
    const items: Electron.MenuItemConstructorOptions[] = [];

    // 撤销/重做（仅在有编辑区域时显示）
    if (params.isEditable) {
      if (params.editFlags.canUndo) {
        items.push({ label: '撤销', role: 'undo' });
      }
      if (params.editFlags.canRedo) {
        items.push({ label: '重做', role: 'redo' });
      }
      if (items.length > 0) items.push({ type: 'separator' });

      // 剪切/复制/粘贴
      if (params.editFlags.canCut) {
        items.push({ label: '剪切', role: 'cut' });
      }
      if (params.editFlags.canCopy) {
        items.push({ label: '复制', role: 'copy' });
      }
      if (params.editFlags.canPaste) {
        items.push({ label: '粘贴', role: 'paste' });
      }
      if (params.editFlags.canDelete) {
        items.push({ label: '删除', role: 'delete' });
      }
      if (params.editFlags.canSelectAll) {
        items.push({ type: 'separator' });
        items.push({ label: '全选', role: 'selectAll' });
      }
    }

    // 有选中文本时也提供复制
    if (params.selectionText && !params.isEditable) {
      items.push({ label: '复制', role: 'copy' });
    }

    return items;
  }

  // ==================== 主题相关窗口操作 ====================

  /**
   * 更新标题栏 overlay 颜色，使自定义标题栏与当前主题一致。
   * 由 ThemeService 在主题切换时调用。
   */
  setTitleBarOverlay(color: string, symbolColor: string): void {
    const win = this.mainWindow;
    if (!win) return;
    win.setTitleBarOverlay({
      color,
      symbolColor,
      height: TITLEBAR_HEIGHT,
    });
  }

  async dispose(): Promise<void> {
    this.unregisterShortcuts();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    this.initialized = false;
  }
}

export const windowService = WindowService.getInstance();
