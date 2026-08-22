// 统一提醒调度器：四类业务共用一个可重算、可持久化去重的时钟。
// 每次扫描只处理当前时间附近的提醒，系统休眠或时钟跳变后下一次扫描会自愈。
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Course,
  Exam,
  IpcResult,
  Lab,
  NotificationPayload,
  PeriodConfig,
  Schedule,
  TimetablePreferences,
} from "../../shared/types";
import { DataService } from "./DataService";
import { NotificationService } from "./NotificationService";
import { TimetableService } from "./TimetableService";

const TICK_WINDOW_MS = 60_000;
const SCAN_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;
type TimeoutHandle = ReturnType<typeof setTimeout>;

interface ReminderState {
  sent: Record<string, string>;
}

interface ReminderEvent {
  key: string;
  at: Date;
  payload: NotificationPayload;
}

export interface ReminderDataSource {
  schedules: { list: () => Schedule[] };
  courses: { list: () => Course[] };
  exams: { list: () => Exam[] };
  labs: { list: () => Lab[] };
  periodConfig: { getAll: () => PeriodConfig[] };
}

export interface ReminderNotificationSink {
  send: (payload: NotificationPayload) => Promise<IpcResult<boolean>>;
  flushDndSummary: (now: Date) => Promise<IpcResult<boolean>>;
}

export interface ReminderTimetableSource {
  getPreferences: () => IpcResult<TimetablePreferences>;
}

export interface ReminderSchedulerDependencies {
  dataService?: ReminderDataSource;
  notificationService?: ReminderNotificationSink;
  timetableService?: ReminderTimetableSource;
  now?: () => Date;
  statePath?: string;
  setTimeout?: (handler: () => void, timeout: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

export function parseLocalDateTime(date: string, time: string): Date | null {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeParts = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateParts || !timeParts) return null;
  const year = Number.parseInt(dateParts[1], 10);
  const month = Number.parseInt(dateParts[2], 10);
  const day = Number.parseInt(dateParts[3], 10);
  const hour = Number.parseInt(timeParts[1], 10);
  const minute = Number.parseInt(timeParts[2], 10);
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day ||
    value.getHours() !== hour ||
    value.getMinutes() !== minute
  )
    return null;
  return Number.isNaN(value.getTime()) ? null : value;
}

export function computeTriggerTime(date: Date, offsetMinutes: number): Date {
  return new Date(date.getTime() - offsetMinutes * 60_000);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonthsPreservingDay(start: Date, offset: number): Date {
  const result = new Date(start);
  const day = start.getDate();
  result.setDate(1);
  result.setMonth(start.getMonth() + offset);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0,
  ).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function dateKey(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isNear(now: Date, target: Date): boolean {
  return Math.abs(now.getTime() - target.getTime()) <= TICK_WINDOW_MS;
}

export class ReminderScheduler {
  private static instance: ReminderScheduler | null = null;
  private initialized = false;
  private timer: TimeoutHandle | null = null;
  private state: ReminderState = { sent: {} };
  private statePath = "";
  private readonly dataSource: ReminderDataSource;
  private readonly notificationSink: ReminderNotificationSink;
  private readonly timetableSource: ReminderTimetableSource;
  private readonly now: () => Date;
  private readonly scheduleTimer: (
    handler: () => void,
    timeout: number,
  ) => TimeoutHandle;
  private readonly clearScheduleTimer: (handle: TimeoutHandle) => void;

  constructor(dependencies: ReminderSchedulerDependencies = {}) {
    this.dataSource = dependencies.dataService ?? DataService.getInstance();
    this.notificationSink =
      dependencies.notificationService ?? NotificationService.getInstance();
    this.timetableSource =
      dependencies.timetableService ?? TimetableService.getInstance();
    this.now = dependencies.now ?? (() => new Date());
    this.statePath = dependencies.statePath ?? "";
    this.scheduleTimer = dependencies.setTimeout ?? setTimeout;
    this.clearScheduleTimer = dependencies.clearTimeout ?? clearTimeout;
  }

  static getInstance(): ReminderScheduler {
    if (!ReminderScheduler.instance)
      ReminderScheduler.instance = new ReminderScheduler();
    return ReminderScheduler.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.statePath ||= path.join(
      app.getPath("userData"),
      "reminder-state.json",
    );
    this.state = this.readState();
    this.initialized = true;
    await this.tick();
    this.scheduleNext();
  }

  async recompute(): Promise<void> {
    if (!this.initialized) return;
    if (this.timer) this.clearScheduleTimer(this.timer);
    this.timer = null;
    await this.tick();
    this.scheduleNext();
  }

  async dispose(): Promise<void> {
    if (this.timer) this.clearScheduleTimer(this.timer);
    this.timer = null;
    this.writeState();
    this.initialized = false;
  }

  private async tick(): Promise<void> {
    const now = this.now();
    this.pruneState(now);
    await this.notificationSink.flushDndSummary(now);
    for (const event of this.collectEvents(now)) await this.deliver(event);
    this.writeState();
  }

  private collectEvents(now: Date): ReminderEvent[] {
    const events = [
      ...this.scheduleEvents(this.dataSource.schedules.list(), now),
      ...this.examEvents(this.dataSource.exams.list()),
      ...this.labEvents(this.dataSource.labs.list()),
      ...this.courseEvents(this.dataSource.courses.list(), now),
    ];
    return events.filter((event) => isNear(now, event.at));
  }

  private scheduleEvents(items: Schedule[], now: Date): ReminderEvent[] {
    return items.flatMap((item) => {
      const start = new Date(item.startTime);
      if (Number.isNaN(start.getTime())) return [];
      const occurrence = this.nearestOccurrence(start, item.repeatRule, now);
      if (!occurrence) return [];
      const at = computeTriggerTime(occurrence, item.reminderOffset);
      return [
        {
          key: this.key("schedule", item.id, occurrence, item.reminderOffset),
          at,
          payload: {
            title: "日程提醒",
            body: `${item.title} - ${occurrence.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            source: "schedule",
            refId: item.id,
          },
        },
      ];
    });
  }

  private examEvents(items: Exam[]): ReminderEvent[] {
    return items.flatMap((item) =>
      this.fixedEvents(
        "exam",
        item.id,
        item.courseName,
        item.date,
        item.startTime,
        item.reminderOffsets,
        item.location,
      ),
    );
  }

  private labEvents(items: Lab[]): ReminderEvent[] {
    return items.flatMap((item) =>
      this.fixedEvents(
        "lab",
        item.id,
        item.name,
        item.date,
        item.startTime,
        item.reminderOffsets,
        item.location,
      ),
    );
  }

  private fixedEvents(
    source: "exam" | "lab",
    id: string,
    name: string,
    date: string,
    time: string,
    offsets: number[],
    location?: string,
  ): ReminderEvent[] {
    const start = parseLocalDateTime(date, time);
    if (!start) return [];
    return offsets.map((offset) => {
      const at = computeTriggerTime(start, offset);
      return {
        key: this.key(source, id, start, offset),
        at,
        payload: {
          title: source === "exam" ? "考试提醒" : "实验提醒",
          body: `${name} ${date} ${time}${location ? ` ${location}` : ""}`,
          source,
          refId: id,
        },
      };
    });
  }

  private courseEvents(items: Course[], now: Date): ReminderEvent[] {
    const preferences = this.timetableSource.getPreferences().data;
    if (!preferences?.semesterStart) return [];
    const semesterStart = new Date(`${preferences.semesterStart}T00:00:00`);
    if (Number.isNaN(semesterStart.getTime())) return [];
    const today = startOfDay(now);
    if (dayNumber(today) < dayNumber(semesterStart)) return [];
    const week =
      Math.floor((dayNumber(today) - dayNumber(semesterStart)) / (7 * DAY_MS)) +
      1;
    const weekday = now.getDay() || 7;
    const periods = this.dataSource.periodConfig.getAll();
    return items.flatMap((item) => {
      if (
        week < item.startWeek ||
        week > item.endWeek ||
        item.weekday !== weekday
      )
        return [];
      const period = periods.find((value) => value.index === item.startPeriod);
      if (!period) return [];
      const classStart = parseLocalDateTime(dateKey(today), period.startTime);
      if (!classStart) return [];
      const at = computeTriggerTime(classStart, period.reminderOffset);
      return [
        {
          key: this.key(
            "timetable",
            item.id,
            classStart,
            period.reminderOffset,
          ),
          at,
          payload: {
            title: "课程提醒",
            body: `${item.name}${item.location ? ` ${item.location}` : ""} 第${item.startPeriod}节`,
            source: "timetable",
            refId: item.id,
          },
        },
      ];
    });
  }

  private async deliver(event: ReminderEvent): Promise<void> {
    if (this.state.sent[event.key]) return;
    const result = await this.notificationSink.send(event.payload);
    if (result.ok) this.state.sent[event.key] = this.now().toISOString();
  }

  private nearestOccurrence(
    start: Date,
    rule: Schedule["repeatRule"],
    now: Date,
  ): Date | null {
    if (rule === "none") return start;
    const candidates: Date[] = [];
    if (rule === "daily" || rule === "weekly") {
      const interval = rule === "daily" ? DAY_MS : 7 * DAY_MS;
      const distance = Math.floor(
        (dayNumber(now) - dayNumber(start)) / interval,
      );
      for (let delta = -1; delta <= 1; delta += 1) {
        const occurrence = new Date(start);
        const count = Math.max(0, distance + delta);
        occurrence.setDate(
          start.getDate() + count * (rule === "daily" ? 1 : 7),
        );
        candidates.push(occurrence);
      }
    }
    if (rule === "monthly") {
      const distance =
        (now.getFullYear() - start.getFullYear()) * 12 +
        now.getMonth() -
        start.getMonth();
      for (let delta = -1; delta <= 1; delta += 1)
        candidates.push(
          addMonthsPreservingDay(start, Math.max(0, distance + delta)),
        );
    }
    return (
      candidates
        .filter((candidate) => candidate.getTime() >= start.getTime())
        .sort(
          (a, b) =>
            Math.abs(a.getTime() - now.getTime()) -
            Math.abs(b.getTime() - now.getTime()),
        )[0] ?? null
    );
  }

  private key(
    source: string,
    id: string,
    occurrence: Date,
    offset: number,
  ): string {
    return `${source}:${id}:${occurrence.toISOString()}:${offset}`;
  }

  private readState(): ReminderState {
    try {
      const value = JSON.parse(
        fs.readFileSync(this.statePath, "utf8"),
      ) as Partial<ReminderState>;
      const sent =
        value.sent && typeof value.sent === "object" ? value.sent : {};
      return {
        sent: Object.fromEntries(
          Object.entries(sent).filter(
            ([, timestamp]) => typeof timestamp === "string",
          ),
        ),
      };
    } catch {
      return { sent: {} };
    }
  }

  private writeState(): void {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(temp, this.statePath);
  }

  private pruneState(now: Date): void {
    const cutoff = now.getTime() - RETENTION_MS;
    for (const [key, timestamp] of Object.entries(this.state.sent)) {
      const value = Date.parse(timestamp);
      if (!Number.isFinite(value) || value < cutoff)
        delete this.state.sent[key];
    }
  }

  private scheduleNext(): void {
    if (!this.initialized) return;
    this.timer = this.scheduleTimer(() => {
      void this.recompute();
    }, SCAN_INTERVAL_MS);
  }
}

export const reminderScheduler = ReminderScheduler.getInstance();
