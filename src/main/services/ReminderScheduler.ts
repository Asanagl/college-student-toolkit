// 统一提醒调度器：四类业务共用一个可重算、可持久化去重的时钟。
// 扫描游标和失败重试状态让系统休眠或时钟跳变后仍能补发提醒。
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
import { writeTextFileAtomically } from "./AtomicFile";

const TICK_WINDOW_MS = 60_000;
const SCAN_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;
const MAX_OCCURRENCES_PER_ITEM = 1000;
type TimeoutHandle = ReturnType<typeof setTimeout>;

interface ReminderState {
  sent: Record<string, string>;
  retry: Record<string, string>;
  lastScan?: string;
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

function isWithinWindow(target: Date, from: Date, to: Date): boolean {
  const timestamp = target.getTime();
  return timestamp >= from.getTime() && timestamp <= to.getTime();
}

export class ReminderScheduler {
  private static instance: ReminderScheduler | null = null;
  private initialized = false;
  private timer: TimeoutHandle | null = null;
  private state: ReminderState = { sent: {}, retry: {} };
  private recomputeRunning: Promise<void> | null = null;
  private recomputeRequested = false;
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
    await this.recompute();
  }

  async recompute(): Promise<void> {
    if (!this.initialized) return;
    this.recomputeRequested = true;
    if (this.recomputeRunning) return this.recomputeRunning;
    const run = (async () => {
      while (this.initialized && this.recomputeRequested) {
        this.recomputeRequested = false;
        if (this.timer) this.clearScheduleTimer(this.timer);
        this.timer = null;
        await this.tick();
      }
      if (this.initialized) this.scheduleNext();
    })();
    this.recomputeRunning = run;
    try {
      await run;
    } finally {
      if (this.recomputeRunning === run) this.recomputeRunning = null;
      if (this.initialized && this.recomputeRequested && !this.recomputeRunning)
        void this.recompute();
    }
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.recomputeRequested = false;
    if (this.timer) this.clearScheduleTimer(this.timer);
    this.timer = null;
    await this.recomputeRunning?.catch(() => undefined);
    this.writeState();
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const previousScan = this.readLastScan();
    const scanFrom =
      previousScan && previousScan.getTime() <= now.getTime()
        ? previousScan
        : new Date(now.getTime() - TICK_WINDOW_MS);
    this.pruneState(now);
    await this.notificationSink.flushDndSummary(now);
    let hasFailure = false;
    for (const event of this.collectEvents(now, scanFrom))
      if (!(await this.deliver(event))) hasFailure = true;
    if (!hasFailure) this.state.lastScan = now.toISOString();
    this.writeState();
  }

  private collectEvents(now: Date, scanFrom: Date): ReminderEvent[] {
    const events = [
      ...this.scheduleEvents(this.dataSource.schedules.list(), scanFrom, now),
      ...this.examEvents(this.dataSource.exams.list()),
      ...this.labEvents(this.dataSource.labs.list()),
      ...this.courseEvents(this.dataSource.courses.list(), scanFrom, now),
    ];
    return events.filter(
      (event) =>
        isWithinWindow(event.at, scanFrom, now) ||
        Boolean(this.state.retry[event.key]),
    );
  }

  private scheduleEvents(
    items: Schedule[],
    scanFrom: Date,
    now: Date,
  ): ReminderEvent[] {
    return items.flatMap((item) => {
      const start = new Date(item.startTime);
      if (Number.isNaN(start.getTime())) return [];
      const occurrenceFrom = new Date(
        scanFrom.getTime() - Math.max(0, item.reminderOffset) * 60_000,
      );
      const occurrenceTo = new Date(
        now.getTime() + Math.max(0, item.reminderOffset) * 60_000,
      );
      return this.occurrencesBetween(
        start,
        item.repeatRule,
        occurrenceFrom,
        occurrenceTo,
      ).map((occurrence) => {
        const at = computeTriggerTime(occurrence, item.reminderOffset);
        return {
          key: this.key("schedule", item.id, occurrence, item.reminderOffset),
          at,
          payload: {
            title: "日程提醒",
            body: `${item.title} - ${occurrence.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            source: "schedule",
            refId: item.id,
          },
        };
      });
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

  private courseEvents(
    items: Course[],
    scanFrom: Date,
    now: Date,
  ): ReminderEvent[] {
    const preferences = this.timetableSource.getPreferences().data;
    if (!preferences?.semesterStart) return [];
    const semesterStart = new Date(`${preferences.semesterStart}T00:00:00`);
    if (Number.isNaN(semesterStart.getTime())) return [];
    const periods = this.dataSource.periodConfig.getAll();
    const maxOffset = Math.max(
      0,
      ...periods.map((period) => Math.max(0, period.reminderOffset)),
    );
    const firstDay = startOfDay(
      new Date(scanFrom.getTime() - maxOffset * 60_000),
    );
    const lastDay = startOfDay(now);
    const events: ReminderEvent[] = [];
    for (
      const day = new Date(firstDay);
      dayNumber(day) <= dayNumber(lastDay);
      day.setDate(day.getDate() + 1)
    ) {
      if (dayNumber(day) < dayNumber(semesterStart)) continue;
      const week =
        Math.floor((dayNumber(day) - dayNumber(semesterStart)) / (7 * DAY_MS)) +
        1;
      const weekday = day.getDay() || 7;
      for (const item of items) {
        if (
          week < item.startWeek ||
          week > item.endWeek ||
          item.weekday !== weekday
        )
          continue;
        const period = periods.find(
          (value) => value.index === item.startPeriod,
        );
        if (!period) continue;
        const classStart = parseLocalDateTime(dateKey(day), period.startTime);
        if (!classStart) continue;
        const at = computeTriggerTime(classStart, period.reminderOffset);
        events.push({
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
        });
      }
    }
    return events;
  }

  private async deliver(event: ReminderEvent): Promise<boolean> {
    if (this.state.sent[event.key]) return true;
    // 先预占去重键，避免多个异步发送路径在 await 期间重复通知。
    this.state.sent[event.key] = this.now().toISOString();
    this.writeState();
    const result = await this.notificationSink.send(event.payload);
    if (result.ok) {
      delete this.state.retry[event.key];
      return true;
    }
    delete this.state.sent[event.key];
    this.state.retry[event.key] = this.now().toISOString();
    return false;
  }

  private occurrencesBetween(
    start: Date,
    rule: Schedule["repeatRule"],
    from: Date,
    to: Date,
  ): Date[] {
    if (to.getTime() < start.getTime() || from.getTime() > to.getTime())
      return [];
    if (rule === "none")
      return start.getTime() >= from.getTime() &&
        start.getTime() <= to.getTime()
        ? [start]
        : [];
    const occurrences: Date[] = [];
    if (rule === "daily" || rule === "weekly") {
      const stepDays = rule === "daily" ? 1 : 7;
      const stepMs = stepDays * DAY_MS;
      const estimated = Math.max(
        0,
        Math.floor((from.getTime() - start.getTime()) / stepMs) - 1,
      );
      const cursor = new Date(start);
      cursor.setDate(start.getDate() + estimated * stepDays);
      for (
        let index = 0;
        index < MAX_OCCURRENCES_PER_ITEM && cursor.getTime() <= to.getTime();
        index += 1
      ) {
        if (cursor.getTime() >= from.getTime())
          occurrences.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + stepDays);
      }
      return occurrences;
    }
    const monthDistance =
      (from.getFullYear() - start.getFullYear()) * 12 +
      from.getMonth() -
      start.getMonth();
    for (
      let offset = Math.max(0, monthDistance - 1), index = 0;
      index < MAX_OCCURRENCES_PER_ITEM;
      offset += 1, index += 1
    ) {
      const occurrence = addMonthsPreservingDay(start, offset);
      if (occurrence.getTime() > to.getTime()) break;
      if (occurrence.getTime() >= from.getTime()) occurrences.push(occurrence);
    }
    return occurrences;
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
      const retry =
        value.retry && typeof value.retry === "object" ? value.retry : {};
      return {
        sent: Object.fromEntries(
          Object.entries(sent).filter(
            ([, timestamp]) => typeof timestamp === "string",
          ),
        ),
        retry: Object.fromEntries(
          Object.entries(retry).filter(
            ([, timestamp]) => typeof timestamp === "string",
          ),
        ),
        lastScan:
          typeof value.lastScan === "string" &&
          Number.isFinite(Date.parse(value.lastScan))
            ? value.lastScan
            : undefined,
      };
    } catch {
      return { sent: {}, retry: {} };
    }
  }

  private readLastScan(): Date | null {
    if (!this.state.lastScan) return null;
    const timestamp = Date.parse(this.state.lastScan);
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  }

  private writeState(): void {
    if (!this.statePath) return;
    writeTextFileAtomically(
      this.statePath,
      JSON.stringify(this.state, null, 2),
    );
  }

  private pruneState(now: Date): void {
    const cutoff = now.getTime() - RETENTION_MS;
    for (const [key, timestamp] of Object.entries(this.state.sent)) {
      const value = Date.parse(timestamp);
      if (!Number.isFinite(value) || value < cutoff)
        delete this.state.sent[key];
    }
    for (const [key, timestamp] of Object.entries(this.state.retry)) {
      const value = Date.parse(timestamp);
      if (!Number.isFinite(value) || value < cutoff)
        delete this.state.retry[key];
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
