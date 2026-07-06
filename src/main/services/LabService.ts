// 实验服务：管理实验提醒调度。
// CRUD 由 main.ts 中直接调用 DataService.labs 仓库完成（IPC 层），
// 本服务负责启动每分钟的提醒调度器，对每个实验的每个 reminderOffset 计算触发时机并调用 NotificationService。
// 实现阶段：Phase 5
import type { Lab, NotificationPayload } from '../../shared/types';
import { DataService } from './DataService';
import { NotificationService } from './NotificationService';

/** 调度器检查间隔：每分钟一次 */
const TICK_INTERVAL_MS = 60_000;
/** 触发时间窗口：与理想触发时间相差 ±1 分钟内视为应当触发 */
const TRIGGER_WINDOW_MS = 60_000;

/** 将 Date 格式化为 YYYY-MM-DD */
function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 计算实验的触发时间（Date）。
 * 触发时间 = 实验日期 + 开始时间 - reminderOffset（分钟）
 */
function computeTriggerTime(lab: Lab, offsetMinutes: number): Date | null {
  const dt = new Date(`${lab.date}T${lab.startTime}:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return new Date(dt.getTime() - offsetMinutes * 60_000);
}

export class LabService {
  private static instance: LabService | null = null;
  private initialized = false;
  private timer: NodeJS.Timeout | null = null;
  /**
   * 已触发记录：labId -> 触发键集合（YYYY-MM-DD-offset）
   * 用内存 Map 防止同一实验的同一档提醒被重复触发；应用重启后重置。
   */
  private triggeredRecords: Map<string, Set<string>> = new Map();

  private constructor() {}

  static getInstance(): LabService {
    if (!LabService.instance) {
      LabService.instance = new LabService();
    }
    return LabService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    void this.tick();
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.triggeredRecords.clear();
    this.initialized = false;
  }

  /** 每分钟执行：遍历所有实验，对每个 reminderOffset 检查是否需要触发 */
  private async tick(): Promise<void> {
    try {
      const labs = DataService.getInstance().labs.list();
      const now = new Date();
      for (const lab of labs) {
        await this.checkAndNotify(lab, now);
      }
    } catch (err) {
      console.error(`[LabService] tick 异常: ${(err as Error).message}`);
    }
  }

  /**
   * 检查单个实验是否需要触发提醒。
   * 对每个 reminderOffset 计算触发时间，若落在 ±1 分钟窗口内且未触发过则发送通知。
   */
  private async checkAndNotify(lab: Lab, now: Date): Promise<void> {
    if (!lab.reminderOffsets || lab.reminderOffsets.length === 0) return;
    for (const offset of lab.reminderOffsets) {
      const triggerTime = computeTriggerTime(lab, offset);
      if (!triggerTime) continue;
      const diffMs = Math.abs(now.getTime() - triggerTime.getTime());
      if (diffMs > TRIGGER_WINDOW_MS) continue;

      const dedupKey = `${formatDateKey(triggerTime)}-${offset}`;
      if (this.isTriggered(lab.id, dedupKey)) continue;
      this.markTriggered(lab.id, dedupKey);

      const instructorText = lab.instructor ? ` 指导教师:${lab.instructor}` : '';
      const payload: NotificationPayload = {
        title: '实验提醒',
        body: `${lab.name} ${lab.date} ${lab.startTime}${lab.location ? ' ' + lab.location : ''}${instructorText}`,
        source: 'lab',
        refId: lab.id,
      };
      await NotificationService.getInstance().send(payload);
    }
  }

  private isTriggered(labId: string, key: string): boolean {
    return this.triggeredRecords.get(labId)?.has(key) ?? false;
  }

  private markTriggered(labId: string, key: string): void {
    let set = this.triggeredRecords.get(labId);
    if (!set) {
      set = new Set<string>();
      this.triggeredRecords.set(labId, set);
    }
    set.add(key);
  }
}

export const labService = LabService.getInstance();
