// 更新服务：基于 electron-updater 实现自动更新检查与安装。
// 实现阶段：Phase 7
import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC_CHANNELS, type IpcResult } from '../../shared/types';

/**
 * 推送给渲染进程的更新状态载荷。
 * 渲染进程通过 preload 暴露的 window.api.update.onUpdateStatus 监听。
 * 注意：preload 的回调签名是 (status: string) => void，运行时实际透传此结构化对象，
 * 渲染进程需自行做类型还原（见 UpdateNotifier.tsx）。
 */
export interface UpdateStatusPayload {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  data?: {
    version?: string;
    percent?: number;
    transferred?: number;
    total?: number;
    error?: string;
  };
}

/**
 * 将更新状态广播到所有渲染窗口。
 * 使用 BrowserWindow.getAllWindows() 而非持有单一窗口引用，
 * 以兼容窗口重建（如 macOS activate 重建）场景。
 */
function broadcastStatus(payload: UpdateStatusPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.UPDATE_STATUS, payload);
  }
}

export class UpdateService {
  private static instance: UpdateService | null = null;
  private initialized = false;

  private constructor() {}

  static getInstance(): UpdateService {
    if (!UpdateService.instance) {
      UpdateService.instance = new UpdateService();
    }
    return UpdateService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // 开发模式下 electron-updater 找不到 app-update.yml 会抛错，
    // 直接跳过更新检查，避免阻塞开发流程
    if (!app.isPackaged) {
      console.log('[UpdateService] 开发模式不检查更新');
      this.initialized = true;
      return;
    }

    // 自动后台下载；下载完成后不自动安装，由用户在 UI 确认
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    this.registerListeners();

    this.initialized = true;

    // 启动后延迟 5 秒自动检查一次，避免与窗口创建、服务初始化抢资源
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err: unknown) => {
        console.error(`[UpdateService] 自动检查更新失败: ${(err as Error).message}`);
      });
    }, 5000);
  }

  /**
   * 注册 electron-updater 事件监听器，将底层事件转化为渲染进程可消费的状态推送。
   * 每个事件对应 UpdateStatusPayload.status 的一个取值。
   */
  private registerListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      broadcastStatus({ status: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      broadcastStatus({
        status: 'available',
        data: { version: info.version },
      });
    });

    autoUpdater.on('update-not-available', () => {
      broadcastStatus({ status: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress) => {
      broadcastStatus({
        status: 'downloading',
        data: {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        },
      });
    });

    autoUpdater.on('update-downloaded', () => {
      broadcastStatus({ status: 'downloaded' });
    });

    autoUpdater.on('error', (err) => {
      broadcastStatus({
        status: 'error',
        data: { error: err?.message ?? String(err) },
      });
    });
  }

  /** 手动触发更新检查（由渲染进程通过 update:check IPC 调用） */
  async checkManual(): Promise<IpcResult<boolean>> {
    if (!app.isPackaged) {
      return { ok: false, error: '开发模式不支持检查更新' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, data: !!result?.updateInfo };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * 退出应用并启动安装程序（由渲染进程在用户确认后通过 update:install IPC 调用）。
   * 注意：quitAndInstaller 会退出当前应用，正常情况下不会返回。
   */
  async installUpdate(): Promise<IpcResult<boolean>> {
    try {
      autoUpdater.quitAndInstall();
      return { ok: true, data: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * 注册更新状态回调（保留以兼容接口契约）。
   * 实际推送方向是主进程 → 渲染进程：主进程通过 broadcastStatus 主动发起，
   * 渲染进程通过 preload 的 window.api.update.onUpdateStatus 监听。
   * 因此主进程侧无需注册回调，此方法保留以维持类接口稳定。
   */
  onUpdateStatus(_callback: (status: string) => void): void {
    // 主进程主动推送，无需在此挂载回调；_callback 保留以维持签名稳定
  }

  async dispose(): Promise<void> {
    // 移除所有监听器避免内存泄漏
    try {
      autoUpdater.removeAllListeners();
    } catch {
      // 释放阶段忽略错误，继续清理
    }
    this.initialized = false;
  }
}

export const updateService = UpdateService.getInstance();
