// 考试服务：管理考试提醒调度。
// CRUD 由 main.ts 中直接调用 DataService.exams 仓库完成（IPC 层），
// 本服务负责启动每分钟的提醒调度器，对每场考试的每个 reminderOffset 计算触发时机并调用 NotificationService。
// 实现阶段：Phase 4
import type { Exam, NotificationPayload } from '../../shared/types';
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
 * 计算考试的触发时间（Date）。
 * 触发时间 = 考试日期 + 开始时间 - reminderOffset（分钟）
 * 若日期或时间解析失败返回 null。
 */
function computeTriggerTime(exam: Exam, offsetMinutes: number): Date | null {
  // 拼接 "YYYY-MM-DDTHH:mm:00" 解析为本地时间
  const dt = new Date(`${exam.date}T${exam.startTime}:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return new Date(dt.getTime() - offsetMinutes * 60_000);
}

export class ExamService {
  private static instance: ExamService | null = null;
  private initialized = false;
  private timer: NodeJS.Timeout | null = null;
  /**
   * 已触发记录：examId -> 触发键集合（YYYY-MM-DD-offset）
   * 用内存 Map 防止同一场考试的同一档提醒被重复触发；应用重启后重置。
   */
  private triggeredRecords: Map<string, Set<string>> = new Map();

  private constructor() {}

  static getInstance(): ExamService {
    if (!ExamService.instance) {
      ExamService.instance = new ExamService();
    }
    return ExamService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    // 启动每分钟检查的定时器
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // 立即执行一次，避免启动后第一分钟内遗漏即将触发的提醒
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

  /** 每分钟执行：遍历所有考试，对每个 reminderOffset 检查是否需要触发 */
  private async tick(): Promise<void> {
    try {
      const exams = DataService.getInstance().exams.list();
      const now = new Date();
      for (const exam of exams) {
        await this.checkAndNotify(exam, now);
      }
    } catch (err) {
      // 调度器异常不中断后续 tick，仅记录日志便于排查
      console.error(`[ExamService] tick 异常: ${(err as Error).message}`);
    }
  }

  /**
   * 检查单场考试是否需要触发提醒。
   * 对每个 reminderOffset 计算触发时间，若落在 ±1 分钟窗口内且未触发过则发送通知。
   */
  private async checkAndNotify(exam: Exam, now: Date): Promise<void> {
    if (!exam.reminderOffsets || exam.reminderOffsets.length === 0) return;
    for (const offset of exam.reminderOffsets) {
      const triggerTime = computeTriggerTime(exam, offset);
      if (!triggerTime) continue;
      const diffMs = Math.abs(now.getTime() - triggerTime.getTime());
      if (diffMs > TRIGGER_WINDOW_MS) continue;

      // 去重键：触发日期 + offset，确保每档提醒每天最多触发一次
      const dedupKey = `${formatDateKey(triggerTime)}-${offset}`;
      if (this.isTriggered(exam.id, dedupKey)) continue;
      this.markTriggered(exam.id, dedupKey);

      const seatText = exam.seat ? ` 座位:${exam.seat}` : '';
      const payload: NotificationPayload = {
        title: '考试提醒',
        body: `${exam.courseName} ${exam.date} ${exam.startTime}${exam.location ? ' ' + exam.location : ''}${seatText}`,
        source: 'exam',
        refId: exam.id,
      };
      await NotificationService.getInstance().send(payload);
    }
  }

  private isTriggered(examId: string, key: string): boolean {
    return this.triggeredRecords.get(examId)?.has(key) ?? false;
  }

  private markTriggered(examId: string, key: string): void {
    let set = this.triggeredRecords.get(examId);
    if (!set) {
      set = new Set<string>();
      this.triggeredRecords.set(examId, set);
    }
    set.add(key);
  }
}

export const examService = ExamService.getInstance();
