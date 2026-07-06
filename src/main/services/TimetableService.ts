// 课程表服务：管理课前提醒调度。
// CRUD 由 main.ts 中直接调用 DataService.courses 仓库完成（IPC 层），
// 本服务负责启动每分钟提醒调度器，按当前周次与节次配置计算触发时机并调用 NotificationService。
// 实现阶段：Phase 3
import Store from 'electron-store';
import type { Course, NotificationPayload, PeriodConfig } from '../../shared/types';
import { DataService } from './DataService';
import { NotificationService } from './NotificationService';

/** 调度器检查间隔：每分钟一次 */
const TICK_INTERVAL_MS = 60_000;
/** 触发时间窗口：与理想触发时间相差 ±1 分钟内视为应当触发 */
const TRIGGER_WINDOW_MS = 60_000;
/** 默认学期开始日期，可由用户在设置中覆盖；未设置时退化为按周数取模推断 */
const DEFAULT_SEMESTER_START = '2025-09-01';

interface TimetableStoreSchema {
  semesterStart: string; // YYYY-MM-DD
}

function todayKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 将 HH:mm 转为当天 0 点起的分钟数 */
function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
}

export class TimetableService {
  private static instance: TimetableService | null = null;
  private initialized = false;
  private timer: NodeJS.Timeout | null = null;
  private store: Store<TimetableStoreSchema> | null = null;
  /**
   * 已触发记录：courseId -> 触发日期集合（YYYY-MM-DD）
   * 用内存 Map 防止同一节课在同一天被重复提醒；应用重启后重置。
   */
  private triggeredRecords: Map<string, Set<string>> = new Map();

  private constructor() {}

  static getInstance(): TimetableService {
    if (!TimetableService.instance) {
      TimetableService.instance = new TimetableService();
    }
    return TimetableService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    // 用 electron-store 持久化学期开始日期；默认值兜底
    this.store = new Store<TimetableStoreSchema>({
      name: 'timetable',
      defaults: { semesterStart: DEFAULT_SEMESTER_START },
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // 启动后立即检查一次，避免第一分钟内遗漏即将开始的课程
    void this.tick();
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.triggeredRecords.clear();
    this.initialized = false;
  }

  /** 每分钟执行：遍历所有课程，检查是否需要触发课前提醒 */
  private async tick(): Promise<void> {
    try {
      const courses = DataService.getInstance().courses.list();
      const periods = DataService.getInstance().periodConfig.getAll();
      const now = new Date();
      const currentWeek = this.computeCurrentWeek(now);
      for (const course of courses) {
        await this.checkAndNotify(course, periods, now, currentWeek);
      }
    } catch (err) {
      // 调度器异常不中断后续 tick，仅记录日志便于排查
      console.error(`[TimetableService] tick 异常: ${(err as Error).message}`);
    }
  }

  /**
   * 检查单门课程是否需要触发提醒。
   * 触发条件：
   *   1. 当前周次落在课程 [startWeek, endWeek] 内
   *   2. 今天是课程 weekday 对应的星期
   *   3. 当前时间落在 "节次开始时间 - reminderOffset" 的 ±1 分钟窗口内
   *   4. 本节课今天尚未触发过
   */
  private async checkAndNotify(
    course: Course,
    periods: PeriodConfig[],
    now: Date,
    currentWeek: number
  ): Promise<void> {
    // 周次过滤：当前周不在课程周次范围内则跳过
    if (currentWeek < course.startWeek || currentWeek > course.endWeek) return;
    // 星期过滤：JS getDay() 周日=0，周一=1...周六=6；Course.weekday 周一=1...周日=7
    const jsWeekday = now.getDay() === 0 ? 7 : now.getDay();
    if (jsWeekday !== course.weekday) return;

    const period = periods.find((p) => p.index === course.startPeriod);
    if (!period) return;

    // 计算理想触发时间 = 节次开始时间 - reminderOffset（分钟）
    const startMinutes = hhmmToMinutes(period.startTime);
    const triggerMinutes = startMinutes - period.reminderOffset;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const diffMs = Math.abs((nowMinutes - triggerMinutes) * 60_000);
    if (diffMs > TRIGGER_WINDOW_MS) return;

    // 去重：同一课程同一天只触发一次
    const key = todayKey(now);
    if (this.isTriggered(course.id, key)) return;
    this.markTriggered(course.id, key);

    const payload: NotificationPayload = {
      title: '课程提醒',
      body: `${course.name} ${course.location ?? ''} 第${course.startPeriod}节 ${period.startTime}`,
      source: 'timetable',
      refId: course.id,
    };
    await NotificationService.getInstance().send(payload);
  }

  /**
   * 计算当前周次：基于学期开始日期。
   * 若 semesterStart 未设置或解析失败，回退到 1。
   * 周次从 1 开始：semesterStart 那一周为第 1 周。
   */
  private computeCurrentWeek(now: Date): number {
    if (!this.store) return 1;
    const startStr = this.store.get('semesterStart', DEFAULT_SEMESTER_START);
    const start = new Date(startStr);
    if (Number.isNaN(start.getTime())) return 1;
    const diffMs = now.getTime() - start.getTime();
    if (diffMs < 0) return 1;
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    // 周一为一周开始：将 start 调整到其所在周的周一，再计算周差
    const startWeekday = start.getDay() === 0 ? 7 : start.getDay();
    const alignedStartDay = diffDays + (startWeekday - 1);
    return Math.floor(alignedStartDay / 7) + 1;
  }

  private isTriggered(courseId: string, dateKey: string): boolean {
    return this.triggeredRecords.get(courseId)?.has(dateKey) ?? false;
  }

  private markTriggered(courseId: string, dateKey: string): void {
    let set = this.triggeredRecords.get(courseId);
    if (!set) {
      set = new Set<string>();
      this.triggeredRecords.set(courseId, set);
    }
    set.add(dateKey);
  }
}

export const timetableService = TimetableService.getInstance();
