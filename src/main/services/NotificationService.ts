// 通知服务：基于 Electron Notification 实现本地提醒，并管理免打扰时段与通知历史。
// 实现阶段：Phase 1
import { Notification } from 'electron';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import type {
  DndConfig,
  IpcResult,
  NotificationPayload,
  NotificationRecord,
} from '../../shared/types';

/** electron-store 持久化的字段 */
interface NotificationStoreSchema {
  dnd: DndConfig;
  notificationHistory: NotificationRecord[];
}

/** 通知历史上限，超过则丢弃最旧的一条 */
const HISTORY_LIMIT = 100;

/** 默认 DnD 配置：关闭，时段 22:00-08:00（跨天） */
const DEFAULT_DND: DndConfig = {
  enabled: false,
  startTime: '22:00',
  endTime: '08:00',
};

export class NotificationService {
  private static instance: NotificationService | null = null;
  private initialized = false;
  private store: Store<NotificationStoreSchema> | null = null;
  private dnd: DndConfig = DEFAULT_DND;

  private constructor() {}

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // electron-store 在实例化时即读取磁盘配置，并合并 defaults
    this.store = new Store<NotificationStoreSchema>({
      name: 'notification',
      defaults: {
        dnd: DEFAULT_DND,
        notificationHistory: [],
      },
    });
    this.dnd = this.store.get('dnd', DEFAULT_DND);
    this.initialized = true;
  }

  /** 发送一条桌面通知；命中 DnD 时段则仅记录历史不弹出 */
  async send(payload: NotificationPayload): Promise<IpcResult<boolean>> {
    if (!this.store) {
      return { ok: false, error: 'NotificationService 未初始化' };
    }
    const inDnd = this.isInDndNow(this.dnd, new Date());
    const record: NotificationRecord = {
      id: randomUUID(),
      title: payload.title,
      body: payload.body,
      source: payload.source,
      timestamp: new Date().toISOString(),
      delivered: !inDnd,
    };
    this.appendHistory(record);

    if (inDnd) {
      // DnD 时段静默，仅记录不弹出
      return { ok: true, data: false };
    }

    // 不支持 Notification 的环境（如部分 Linux）下静默跳过，避免抛错
    if (!Notification.isSupported()) {
      return { ok: true, data: false };
    }
    const iconPath = path.join(__dirname, '../../resources/icon.png');
    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      icon: iconPath,
    });
    notification.show();
    return { ok: true, data: true };
  }

  /** 更新免打扰配置并持久化 */
  async setDnd(config: DndConfig): Promise<IpcResult<boolean>> {
    if (!this.store) {
      return { ok: false, error: 'NotificationService 未初始化' };
    }
    this.dnd = config;
    this.store.set('dnd', config);
    return { ok: true, data: true };
  }

  /** 读取当前免打扰配置 */
  async getDnd(): Promise<IpcResult<DndConfig>> {
    if (!this.store) {
      return { ok: false, error: 'NotificationService 未初始化' };
    }
    return { ok: true, data: this.dnd };
  }

  /** 返回通知历史（新的在前） */
  async getHistory(): Promise<IpcResult<NotificationRecord[]>> {
    if (!this.store) {
      return { ok: false, error: 'NotificationService 未初始化' };
    }
    return { ok: true, data: this.store.get('notificationHistory', []) };
  }

  /** 清空通知历史 */
  async clearHistory(): Promise<IpcResult<boolean>> {
    if (!this.store) {
      return { ok: false, error: 'NotificationService 未初始化' };
    }
    this.store.set('notificationHistory', []);
    return { ok: true, data: true };
  }

  async dispose(): Promise<void> {
    // electron-store 在 set 时已写盘，无需额外释放
    this.initialized = false;
  }

  /** 追加一条历史，超出上限时丢弃最旧的记录 */
  private appendHistory(record: NotificationRecord): void {
    if (!this.store) {
      return;
    }
    const history = this.store.get('notificationHistory', []);
    history.unshift(record);
    // 仅保留最近 HISTORY_LIMIT 条，避免无限增长
    if (history.length > HISTORY_LIMIT) {
      history.length = HISTORY_LIMIT;
    }
    this.store.set('notificationHistory', history);
  }

  /** 判断给定时间是否落在 DnD 时段内，支持跨天（如 22:00-08:00） */
  private isInDndNow(dnd: DndConfig, now: Date): boolean {
    if (!dnd.enabled) {
      return false;
    }
    const current = this.toMinutes(now);
    const start = this.parseHHmm(dnd.startTime);
    const end = this.parseHHmm(dnd.endTime);
    if (start === end) {
      // 起止相同视为全天静默
      return true;
    }
    if (start < end) {
      // 不跨天，如 09:00-12:00
      return current >= start && current < end;
    }
    // 跨天，如 22:00-08:00：当前 >= 22:00 或 < 08:00
    return current >= start || current < end;
  }

  /** 将 Date 转为当天 0 点起的分钟数，便于区间比较 */
  private toMinutes(date: Date): number {
    return date.getHours() * 60 + date.getMinutes();
  }

  /** 解析 HH:mm 字符串为分钟数；非法格式返回 0 */
  private parseHHmm(value: string): number {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match) {
      return 0;
    }
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    return hours * 60 + minutes;
  }
}

export const notificationService = NotificationService.getInstance();
