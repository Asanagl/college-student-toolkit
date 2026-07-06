// 主题服务：管理主题偏好持久化、nativeTheme 同步、向渲染进程广播主题变更。
// 支持三种模式：system（跟随系统）、light（强制亮色）、dark（强制暗色）。
// 实现阶段：桌面端强制检查项（暗黑模式跟随系统 + 手动切换）
import { nativeTheme, BrowserWindow } from 'electron';
import Store from 'electron-store';
import type { ThemeMode, ResolvedTheme } from '../../shared/types';
import { windowService } from './WindowService';

interface ThemeStoreSchema {
  mode: ThemeMode;
}

/** 亮色标题栏 overlay 颜色 */
const LIGHT_TITLEBAR = { color: '#ffffff', symbolColor: '#333333' };
/** 暗色标题栏 overlay 颜色 */
const DARK_TITLEBAR = { color: '#001529', symbolColor: '#ffffff' };

export class ThemeService {
  private static instance: ThemeService | null = null;
  private initialized = false;
  private store: Store<ThemeStoreSchema> | null = null;
  private mode: ThemeMode = 'system';

  private constructor() {}

  static getInstance(): ThemeService {
    if (!ThemeService.instance) {
      ThemeService.instance = new ThemeService();
    }
    return ThemeService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.store = new Store<ThemeStoreSchema>({
      name: 'theme-preference',
      defaults: { mode: 'system' },
    });
    this.mode = this.store.get('mode');
    // 应用初始主题到 nativeTheme
    this.applyToNativeTheme(this.mode);
    // 监听系统主题变化：当 mode=system 时需要广播实际主题给渲染进程
    nativeTheme.on('updated', () => {
      if (this.mode === 'system') {
        this.broadcast();
      }
    });
    this.initialized = true;
  }

  /** 获取用户偏好模式（system/light/dark） */
  getMode(): ThemeMode {
    return this.mode;
  }

  /** 设置用户偏好模式并持久化，同步 nativeTheme 与标题栏 */
  setMode(mode: ThemeMode): void {
    this.mode = mode;
    this.store?.set('mode', mode);
    this.applyToNativeTheme(mode);
    this.broadcast();
  }

  /** 获取当前实际生效的主题（解析 system 后的 light/dark） */
  getResolved(): ResolvedTheme {
    if (this.mode === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    }
    return this.mode;
  }

  /**
   * 将模式应用到 Electron nativeTheme。
   * system 模式下 nativeTheme 跟随操作系统，light/dark 则强制覆盖。
   */
  private applyToNativeTheme(mode: ThemeMode): void {
    nativeTheme.themeSource = mode;
    this.updateTitleBarOverlay();
  }

  /** 根据实际主题更新窗口标题栏 overlay 颜色 */
  private updateTitleBarOverlay(): void {
    const resolved = this.getResolved();
    if (resolved === 'dark') {
      windowService.setTitleBarOverlay(DARK_TITLEBAR.color, DARK_TITLEBAR.symbolColor);
    } else {
      windowService.setTitleBarOverlay(LIGHT_TITLEBAR.color, LIGHT_TITLEBAR.symbolColor);
    }
  }

  /** 向所有窗口的渲染进程广播当前实际主题 */
  private broadcast(): void {
    const resolved = this.getResolved();
    this.updateTitleBarOverlay();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:onChange', resolved);
    }
  }

  async dispose(): Promise<void> {
    nativeTheme.removeAllListeners('updated');
    this.initialized = false;
  }
}

export const themeService = ThemeService.getInstance();
