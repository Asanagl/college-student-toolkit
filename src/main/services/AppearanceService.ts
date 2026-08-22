// 外观服务：管理材质模式、背景图、模糊度、清晰度的持久化与广播。
// 亚克力材质在 Win11 22H2+ 使用 Electron 原生 setBackgroundMaterial，其他系统 CSS 降级。
// 背景图存储在 userData/backgrounds/ 目录，文件名用时间戳+原扩展名避免冲突。
import { app, BrowserWindow, dialog } from 'electron';
import Store from 'electron-store';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { IPC_CHANNELS, type AppearanceConfig, type MaterialMode } from '../../shared/types';
import { WindowService, windowService } from './WindowService';
import { portableSettingsService } from './PortableSettingsService';

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
    this.store.set(portableSettingsService.get().appearance);
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

  /** 获取当前完整外观配置（含运行时 acrylicSupported 标志）。 */
  getConfig(): AppearanceConfig {
    const material = this.store?.get('material') ?? DEFAULT_CONFIG.material;
    const backgroundFileName = this.store?.get('backgroundImage') ?? DEFAULT_CONFIG.backgroundImage;
    const blurRadius = this.store?.get('blurRadius') ?? DEFAULT_CONFIG.blurRadius;
    const clarity = this.store?.get('clarity') ?? DEFAULT_CONFIG.clarity;
    // 对外只暴露受限 app-background URL，渲染层无需接触本机绝对路径。
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
    await this.assertImageSignature(filePath, ext);
    // 删除旧背景图
    await this.clearBackgroundImage();
    // 生成唯一文件名：时间戳+随机6位hex+原扩展名
    const fileName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    const destPath = path.join(this.backgroundsDir, fileName);
    await fs.copyFile(filePath, destPath);
    this.store?.set('backgroundImage', fileName);
    portableSettingsService.update({ appearance: { ...portableSettingsService.get().appearance, backgroundImage: fileName } });
    this.broadcast();
    return fileName;
  }

  /** 由主进程弹出文件选择器，避免渲染层提交任意绝对路径。 */
  async chooseBackgroundImage(): Promise<string | null> {
    const parent = windowService.getMainWindow();
    const options = {
      title: '选择背景图片',
      properties: ['openFile'] as ('openFile')[],
      filters: [{ name: '图片', extensions: SUPPORTED_IMAGE_EXTS.map((item) => item.slice(1)) }],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.uploadBackgroundImage(result.filePaths[0]);
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
    portableSettingsService.update({ appearance: { ...portableSettingsService.get().appearance, backgroundImage: null } });
    this.broadcast();
  }

  /** 设置模糊度（0-50px） */
  setBlurRadius(value: number): void {
    const clamped = Math.max(0, Math.min(50, Math.round(value)));
    this.store?.set('blurRadius', clamped);
    portableSettingsService.update({ appearance: { ...portableSettingsService.get().appearance, blurRadius: clamped } });
    this.broadcast();
  }

  /** 设置清晰度（0-100，百分比） */
  setClarity(value: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    this.store?.set('clarity', clamped);
    portableSettingsService.update({ appearance: { ...portableSettingsService.get().appearance, clarity: clamped } });
    this.broadcast();
  }

  /** 获取受限 app-background URL，供渲染进程加载；无背景图返回 null。 */
  getBackgroundImageUrl(): string | null {
    const fileName = this.store?.get('backgroundImage') ?? null;
    if (!fileName) return null;
    return `app-background:///${encodeURIComponent(fileName)}`;
  }

  private async assertImageSignature(filePath: string, ext: string): Promise<void> {
    const header = await fs.readFile(filePath, { encoding: null });
    const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    const isGif = header.length >= 6 && (header.subarray(0, 6).toString() === 'GIF87a' || header.subarray(0, 6).toString() === 'GIF89a');
    const isWebp = header.length >= 12 && header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP';
    const isBmp = header.length >= 2 && header.subarray(0, 2).toString() === 'BM';
    const valid = ext === '.png' ? isPng : ext === '.jpg' || ext === '.jpeg' ? isJpeg : ext === '.gif' ? isGif : ext === '.webp' ? isWebp : ext === '.bmp' ? isBmp : false;
    if (!valid) throw new Error('图片内容与扩展名不匹配或无法解析');
  }

  /** 向所有窗口广播当前外观配置 */
  private broadcast(): void {
    const config = this.getConfig();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.APPEARANCE_ON_CHANGE, config);
    }
  }

  applyPortableSettings(): void {
    const appearance = portableSettingsService.get().appearance;
    this.store?.set(appearance);
    if (appearance.material === 'acrylic') windowService.setBackgroundMaterial('acrylic');
    else windowService.setBackgroundMaterial('none');
    this.broadcast();
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }
}

export const appearanceService = AppearanceService.getInstance();
