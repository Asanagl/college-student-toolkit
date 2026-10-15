// 外观服务：管理材质模式、背景图、模糊度、清晰度的持久化与广播。
// 亚克力材质在 Win11 22H2+ 使用 Electron 原生 setBackgroundMaterial，其他系统 CSS 降级。
// 背景图存储在 userData/backgrounds/ 目录，文件名用时间戳+原扩展名避免冲突。
import { app, BrowserWindow, dialog } from "electron";
import Store from "electron-store";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import {
  IPC_CHANNELS,
  type AppearanceConfig,
  type MaterialMode,
} from "../../shared/types";
import { WindowService, windowService } from "./WindowService";
import { portableSettingsService } from "./PortableSettingsService";
import {
  isSafeImageFileName,
  isSupportedImageExtension,
  SUPPORTED_IMAGE_EXTENSIONS,
  validateImageFile,
} from "./ImageValidation";

interface AppearanceStoreSchema {
  material: MaterialMode;
  backgroundImage: string | null;
  blurRadius: number;
  clarity: number;
}

const DEFAULT_CONFIG: AppearanceStoreSchema = {
  material: "none",
  backgroundImage: null,
  blurRadius: 0,
  clarity: 100,
};

export class AppearanceService {
  private static instance: AppearanceService | null = null;
  private initialized = false;
  private store: Store<AppearanceStoreSchema> | null = null;
  /** 背景图目录的绝对路径：userData/backgrounds/ */
  private backgroundsDir = "";

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
      name: "appearance-preference",
      defaults: DEFAULT_CONFIG,
    });
    this.store.set(portableSettingsService.get().appearance);
    this.backgroundsDir = path.join(app.getPath("userData"), "backgrounds");
    // 确保背景图目录存在
    try {
      await fs.mkdir(this.backgroundsDir, { recursive: true });
    } catch {
      // 目录已存在或其他错误，忽略
    }
    // 主窗口在服务初始化之后才创建；窗口创建完成后由 main.ts 应用材质。
    this.initialized = true;
  }

  /** 获取当前完整外观配置（含运行时 acrylicSupported 标志）。 */
  getConfig(): AppearanceConfig {
    const material = this.getEffectiveMaterial();
    const backgroundFileName =
      this.store?.get("backgroundImage") ?? DEFAULT_CONFIG.backgroundImage;
    const blurRadius =
      this.store?.get("blurRadius") ?? DEFAULT_CONFIG.blurRadius;
    const clarity = this.store?.get("clarity") ?? DEFAULT_CONFIG.clarity;
    // 对外只暴露受限 app-background URL，渲染层无需接触本机绝对路径。
    const backgroundImage = backgroundFileName
      ? this.getBackgroundImageUrl()
      : null;
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
    const effective =
      mode === "acrylic" && !WindowService.isAcrylicSupported() ? "none" : mode;
    this.store?.set("material", effective);
    portableSettingsService.update({
      appearance: {
        ...portableSettingsService.get().appearance,
        material: effective,
      },
    });
    windowService.setBackgroundMaterial(effective);
    this.broadcast();
  }

  /** 在主窗口创建或重新创建后应用当前有效材质。 */
  applyMaterial(): void {
    windowService.setBackgroundMaterial(this.getEffectiveMaterial());
  }

  /** 上传背景图，并在新资源与设置均落盘后才淘汰旧资源。 */
  async uploadBackgroundImage(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    if (!isSupportedImageExtension(ext)) {
      throw new Error(
        `不支持的图片格式: ${ext}，仅支持 ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`,
      );
    }
    await validateImageFile(filePath);
    const previousFileName = this.store?.get("backgroundImage") ?? null;
    const uniquePart = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const fileName = `${uniquePart}${ext}`;
    const destPath = path.join(this.backgroundsDir, fileName);
    // 临时文件仍保留真实扩展名，才能在提交前再次检查 source 的 TOCTOU 变化。
    const tempPath = path.join(
      this.backgroundsDir,
      `.${uniquePart}.pending${ext}`,
    );
    try {
      await fs.copyFile(filePath, tempPath);
      await validateImageFile(tempPath);
      await fs.rename(tempPath, destPath);
      this.setBackgroundReference(fileName);
    } catch (error) {
      await this.removeBackgroundFile(path.basename(tempPath));
      await this.removeBackgroundFile(fileName);
      throw error;
    }
    // 旧文件仅在新配置已提交后尽力清理；失败时保留孤儿文件优于丢失用户数据。
    await this.removeBackgroundFile(previousFileName);
    this.broadcast();
    return fileName;
  }

  /** 由主进程弹出文件选择器，避免渲染层提交任意绝对路径。 */
  async chooseBackgroundImage(): Promise<string | null> {
    const parent = windowService.getMainWindow();
    const options = {
      title: "选择背景图片",
      properties: ["openFile"] as "openFile"[],
      filters: [
        {
          name: "图片",
          extensions: SUPPORTED_IMAGE_EXTENSIONS.map((item) => item.slice(1)),
        },
      ],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.uploadBackgroundImage(result.filePaths[0]);
  }

  /** 清除背景图：删除文件并清空持久化字段 */
  async clearBackgroundImage(): Promise<void> {
    const current = this.store?.get("backgroundImage") ?? null;
    this.setBackgroundReference(null);
    await this.removeBackgroundFile(current);
    this.broadcast();
  }

  /** 先更新两份配置；任一落盘失败时尽力恢复内存与持久化指向。 */
  private setBackgroundReference(fileName: string | null): void {
    const previousStoreValue = this.store?.get("backgroundImage") ?? null;
    const previousPortableValue =
      portableSettingsService.get().appearance.backgroundImage;
    try {
      this.store?.set("backgroundImage", fileName);
      portableSettingsService.update({
        appearance: {
          ...portableSettingsService.get().appearance,
          backgroundImage: fileName,
        },
      });
    } catch (error) {
      try {
        this.store?.set("backgroundImage", previousStoreValue);
      } catch {
        // 主配置仍由 portable settings 决定，不能用回滚失败掩盖原始异常。
      }
      try {
        if (
          portableSettingsService.get().appearance.backgroundImage !==
          previousPortableValue
        ) {
          portableSettingsService.update({
            appearance: {
              ...portableSettingsService.get().appearance,
              backgroundImage: previousPortableValue,
            },
          });
        }
      } catch {
        // 旧图片尚未删除，保留它以便下次启动时仍可恢复。
      }
      throw error;
    }
  }

  private async removeBackgroundFile(fileName: string | null): Promise<void> {
    if (!fileName || !isSafeImageFileName(fileName)) return;
    const fullPath = path.join(this.backgroundsDir, fileName);
    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isFile()) await fs.unlink(fullPath);
    } catch {
      // 文件可能已不存在、被锁定或是符号链接；配置已经安全切换，无需再冒删除风险。
    }
  }

  /** 设置模糊度（0-50px） */
  setBlurRadius(value: number): void {
    const clamped = Math.max(0, Math.min(50, Math.round(value)));
    this.store?.set("blurRadius", clamped);
    portableSettingsService.update({
      appearance: {
        ...portableSettingsService.get().appearance,
        blurRadius: clamped,
      },
    });
    this.broadcast();
  }

  /** 设置清晰度（0-100，百分比） */
  setClarity(value: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    this.store?.set("clarity", clamped);
    portableSettingsService.update({
      appearance: {
        ...portableSettingsService.get().appearance,
        clarity: clamped,
      },
    });
    this.broadcast();
  }

  /** 获取受限 app-background URL，供渲染进程加载；无背景图返回 null。 */
  getBackgroundImageUrl(): string | null {
    const fileName = this.store?.get("backgroundImage") ?? null;
    if (!fileName || !isSafeImageFileName(fileName)) return null;
    return `app-background:///${encodeURIComponent(fileName)}`;
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
    this.applyMaterial();
    this.broadcast();
  }

  private getEffectiveMaterial(): MaterialMode {
    const material = this.store?.get("material") ?? DEFAULT_CONFIG.material;
    return material === "acrylic" && !WindowService.isAcrylicSupported()
      ? "none"
      : material;
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }
}

export const appearanceService = AppearanceService.getInstance();
