// 外观服务：管理材质模式、背景图、模糊度、清晰度的持久化与广播。
// 亚克力材质在 Win11 22H2+ 使用 Electron 原生 setBackgroundMaterial，其他系统 CSS 降级。
// 背景图存储在 userData/backgrounds/ 目录，文件名用时间戳+原扩展名避免冲突。
import { app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import type { AppearanceConfig, MaterialMode } from '../../shared/types';
import { WindowService, windowService } from './WindowService';

interface AppearanceStoreSchema {
  material: MaterialMode;
  backgroundImage: string | null;
  blurRadius: number;
  clarity: number;
}

const DEFAULT_CONFIG: AppearanceStoreSchema = {
  material: 'none',
  backgroundImage: null,
  blurRadius: 0,
  clarity: 100,
};

/** 支持的图片扩展名（Chromium 可解析） */
const SUPPORTED_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

/** 背景图最大字节数 10MB */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export class AppearanceService {
  private static instance: AppearanceService | null = null;
  private initialized = false;
  private store: Store<AppearanceStoreSchema> | null = null;
  /** 背景图目录的绝对路径：userData/backgrounds/ */
  private backgroundsDir = '';

  private constructor() {}

  static getInstance(): AppearanceService {
    if (!AppearanceService.instance) {
      AppearanceService.instance = new AppearanceService();
    }
    return AppearanceService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.store = new Store<AppearanceStoreSchema>({
      name: 'appearance-preference',
      defaults: DEFAULT_CONFIG,
    });
    this.backgroundsDir = path.join(app.getPath('userData'), 'backgrounds');
    // 确保背景图目录存在
    try {
      await fs.mkdir(this.backgroundsDir, { recursive: true });
    } catch {
      // 目录已存在或其他错误，忽略
    }
    // 应用初始材质到主窗口
    const material = this.store.get('material');
    if (material === 'acrylic') {
      windowService.setBackgroundMaterial('acrylic');
    }
    this.initialized = true;
  }

  /** 获取当前完整外观配置（含运行时 acrylicSupported 标志） */
  getConfig(): AppearanceConfig {
    const material = this.store?.get('material') ?? DEFAULT_CONFIG.material;
    const backgroundFileName = this.store?.get('backgroundImage') ?? DEFAULT_CONFIG.backgroundImage;
    const blurRadius = this.store?.get('blurRadius') ?? DEFAULT_CONFIG.blurRadius;
    const clarity = this.store?.get('clarity') ?? DEFAULT_CONFIG.clarity;
    // backgroundImage 字段对外暴露完整 file:// URL，方便渲染进程直接加载
    const backgroundImage = backgroundFileName ? this.getBackgroundImageUrl() : null;
    return {
      material,
      backgroundImage,
      blurRadius,
      clarity,
      acrylicSupported: WindowService.isAcrylicSupported(),
    };
  }

  /** 设置材质模式并应用到主窗口 */
  setMaterial(mode: MaterialMode): void {
    this.store?.set('material', mode);
    if (mode === 'acrylic') {
      windowService.setBackgroundMaterial('acrylic');
    } else {
      windowService.setBackgroundMaterial('none');
    }
    this.broadcast();
  }

  /**
   * 上传背景图：将用户选择的图片复制到 userData/backgrounds/。
   * 返回存储后的文件名。若已有旧图，先删除。
   */
  async uploadBackgroundImage(filePath: string): Promise<string> {
    // 校验文件扩展名
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.includes(ext)) {
      throw new Error(`不支持的图片格式: ${ext}，仅支持 ${SUPPORTED_IMAGE_EXTS.join(', ')}`);
    }
    // 校验文件大小
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      throw new Error(`图片大小超过 10MB 限制（当前 ${(stat.size / 1024 / 1024).toFixed(2)}MB）`);
    }
    // 删除旧背景图
    await this.clearBackgroundImage();
    // 生成唯一文件名：时间戳+随机6位hex+原扩展名
    const fileName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    const destPath = path.join(this.backgroundsDir, fileName);
    await fs.copyFile(filePath, destPath);
    this.store?.set('backgroundImage', fileName);
    this.broadcast();
    return fileName;
  }

  /** 清除背景图：删除文件并清空持久化字段 */
  async clearBackgroundImage(): Promise<void> {
    const current = this.store?.get('backgroundImage') ?? null;
    if (current) {
      const fullPath = path.join(this.backgroundsDir, current);
      try {
        await fs.unlink(fullPath);
      } catch {
        // 文件可能已不存在，忽略
      }
    }
    this.store?.set('backgroundImage', null);
    this.broadcast();
  }

  /** 设置模糊度（0-50px） */
  setBlurRadius(value: number): void {
    const clamped = Math.max(0, Math.min(50, Math.round(value)));
    this.store?.set('blurRadius', clamped);
    this.broadcast();
  }

  /** 设置清晰度（0-100，百分比） */
  setClarity(value: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    this.store?.set('clarity', clamped);
    this.broadcast();
  }

  /** 获取背景图的完整 file:// URL，供渲染进程加载；无背景图返回 null */
  getBackgroundImageUrl(): string | null {
    const fileName = this.store?.get('backgroundImage') ?? null;
    if (!fileName) return null;
    const fullPath = path.join(this.backgroundsDir, fileName);
    // 转换为 file:// URL，Windows 路径反斜杠需转正斜杠
    return `file:///${fullPath.replace(/\\/g, '/')}`;
  }

  /** 向所有窗口广播当前外观配置 */
  private broadcast(): void {
    const config = this.getConfig();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('appearance:onChange', config);
    }
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }
}

export const appearanceService = AppearanceService.getInstance();
