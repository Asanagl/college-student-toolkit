// 日程服务：管理日程提醒调度。
// CRUD 由 main.ts 中直接调用 DataService.schedules 仓库完成（IPC 层），
// 本服务负责启动每分钟的提醒调度器，按重复规则计算触发时机并调用 NotificationService。
// 实现阶段：Phase 2
import type { IpcResult, NotificationPayload, RepeatRule, Schedule } from '../../shared/types';
import { DataService } from './DataService';
import { NotificationService } from './NotificationService';

/** 调度器检查间隔：每分钟一次 */
const TICK_INTERVAL_MS = 60_000;
/** 触发时间窗口：与理想触发时间相差 ±1 分钟内视为应当触发 */
const TRIGGER_WINDOW_MS = 60_000;

export class ScheduleService {
  private static instance: ScheduleService | null = null;
  private initialized = false;
  private timer: NodeJS.Timeout | null = null;
  /**
   * 已触发记录：scheduleId -> 触发日期集合（YYYY-MM-DD）
   * 用内存 Map 存储避免同一日程在同一天被重复提醒；应用重启后重置。
   */
  private triggeredRecords: Map<string, Set<string>> = new Map();

  private constructor() {}

  static getInstance(): ScheduleService {
    if (!ScheduleService.instance) {
      ScheduleService.instance = new ScheduleService();
    }
    return ScheduleService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    // 启动每分钟检查的定时器；使用箭头函数保持 this 绑定
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // 立即执行一次，避免启动后第一分钟内不检查即将到来的日程
    void this.tick();
  }

  async list(): Promise<IpcResult<Schedule[]>> {
    try {
      return { ok: true, data: DataService.getInstance().schedules.list() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async add(item: Omit<Schedule, 'id' | 'createdAt' | 'updatedAt'>): Promise<IpcResult<Schedule>> {
    try {
      const created = DataService.getInstance().schedules.add(item);
      return { ok: true, data: created };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async update(id: string, patch: Partial<Schedule>): Promise<IpcResult<Schedule>> {
    try {
      const updated = DataService.getInstance().schedules.update(id, patch);
      if (!updated) return { ok: false, error: '日程不存在' };
      return { ok: true, data: updated };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async remove(id: string): Promise<IpcResult<boolean>> {
    try {
      const ok = DataService.getInstance().schedules.remove(id);
      return { ok: true, data: ok };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.triggeredRecords.clear();
    this.initialized = false;
  }

  /** 每分钟执行一次：获取所有日程并检查是否需要触发提醒 */
  private async tick(): Promise<void> {
    try {
      const schedules = DataService.getInstance().schedules.list();
      const now = new Date();
      for (const schedule of schedules) {
        await this.checkAndNotify(schedule, now);
      }
    } catch (err) {
      // 调度器异常不应中断后续 tick，仅记录日志便于排查
      console.error(`[ScheduleService] tick 异常: ${(err as Error).message}`);
    }
  }

  /**
   * 检查单条日程是否需要触发提醒
   * 策略：生成前一个/当前/后一个候选 occurrence，取触发时间最接近 now 的，
   * 若落在 ±1 分钟窗口内且未触发过，则发送通知并记录。
   */
  private async checkAndNotify(schedule: Schedule, now: Date): Promise<void> {
    const occurrence = this.findNearestOccurrence(schedule, now);
    if (!occurrence) return;

    const offsetMs = schedule.reminderOffset * 60_000;
    const triggerTime = new Date(occurrence.getTime() - offsetMs);
    const diffMs = Math.abs(now.getTime() - triggerTime.getTime());

    if (diffMs > TRIGGER_WINDOW_MS) return;

    // 用 occurrence 日期作为去重 key，保证同一日程每天最多触发一次
    const occurrenceKey = this.formatDateKey(occurrence);
    if (this.isTriggered(schedule.id, occurrenceKey)) return;

    this.markTriggered(schedule.id, occurrenceKey);

    const payload: NotificationPayload = {
      title: '日程提醒',
      body: `${schedule.title} - ${this.formatTime(schedule.startTime)}`,
      source: 'schedule',
      refId: schedule.id,
    };
    await NotificationService.getInstance().send(payload);
  }

  /**
   * 找到触发时间最接近 now 的 occurrence（日程发生时间）
   * 对于重复日程，生成前/当/后三个候选 occurrence，取触发时间最接近 now 的，
   * 以覆盖大偏移量（如提前一天提醒）与跨天场景。
   */
  private findNearestOccurrence(schedule: Schedule, now: Date): Date | null {
    const originalStart = new Date(schedule.startTime);
    if (schedule.repeatRule === 'none') {
      return originalStart;
    }

    const candidates = this.generateRepeatCandidates(originalStart, now, schedule.repeatRule);
    let nearest: Date | null = null;
    let nearestDiff = Infinity;
    for (const candidate of candidates) {
      // 触发时间 = occurrence - reminderOffset；比较哪个候选的触发时间最接近 now
      const triggerMs = candidate.getTime() - schedule.reminderOffset * 60_000;
      const diff = Math.abs(now.getTime() - triggerMs);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = candidate;
      }
    }
    return nearest;
  }

  /**
   * 生成前/当/后三个候选 occurrence，覆盖大偏移量与跨天场景
   * daily: 昨天/今天/明天同一时刻
   * weekly: 上周/本周/下周对应星期几
   * monthly: 上月/本月/下月对应日期（月末按当月天数截断）
   */
  private generateRepeatCandidates(originalStart: Date, now: Date, rule: RepeatRule): Date[] {
    const h = originalStart.getHours();
    const m = originalStart.getMinutes();
    const s = originalStart.getSeconds();
    const ms = originalStart.getMilliseconds();
    const candidates: Date[] = [];

    if (rule === 'daily') {
      for (let delta = -1; delta <= 1; delta++) {
        candidates.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta, h, m, s, ms));
      }
    } else if (rule === 'weekly') {
      // 找本周对应星期几的日期：将 now 滚动到与 originalStart 相同的星期几
      const diffDays = now.getDay() - originalStart.getDay();
      const thisWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffDays, h, m, s, ms);
      for (let delta = -1; delta <= 1; delta++) {
        const d = new Date(thisWeek);
        d.setDate(d.getDate() + delta * 7);
        candidates.push(d);
      }
    } else if (rule === 'monthly') {
      const originalDate = originalStart.getDate();
      for (let delta = -1; delta <= 1; delta++) {
        const year = now.getFullYear();
        const month = now.getMonth() + delta;
        // 当月最后一天，处理 31 号在 2 月等情况
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const targetDate = Math.min(originalDate, daysInMonth);
        candidates.push(new Date(year, month, targetDate, h, m, s, ms));
      }
    }

    return candidates;
  }

  private isTriggered(scheduleId: string, dateKey: string): boolean {
    return this.triggeredRecords.get(scheduleId)?.has(dateKey) ?? false;
  }

  private markTriggered(scheduleId: string, dateKey: string): void {
    let set = this.triggeredRecords.get(scheduleId);
    if (!set) {
      set = new Set<string>();
      this.triggeredRecords.set(scheduleId, set);
    }
    set.add(dateKey);
  }

  private formatDateKey(d: Date): string {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 格式化为 HH:mm 用于通知正文 */
  private formatTime(isoTime: string): string {
    const d = new Date(isoTime);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }
}

export const scheduleService = ScheduleService.getInstance();
