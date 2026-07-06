// 日程仓库：对应 schedule_items 表
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RepeatRule, Schedule } from '../../../shared/types';
import { BaseEntityRepository } from './BaseRepository';

interface ScheduleRow {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  reminder_offset: number;
  repeat_rule: string;
  created_at: string;
  updated_at: string;
}

export class ScheduleRepository extends BaseEntityRepository<Schedule> {
  constructor(db: Database.Database) {
    super(db);
  }

  protected get tableName(): string {
    return 'schedule_items';
  }

  protected mapRow(row: Record<string, unknown>): Schedule {
    const r = row as unknown as ScheduleRow;
    return {
      id: r.id,
      title: r.title,
      startTime: r.start_time,
      endTime: r.end_time,
      reminderOffset: r.reminder_offset,
      repeatRule: r.repeat_rule as RepeatRule,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  add(item: Omit<Schedule, 'id' | 'createdAt' | 'updatedAt'>): Schedule {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO schedule_items
          (id, title, start_time, end_time, reminder_offset, repeat_rule, created_at, updated_at)
         VALUES
          (@id, @title, @start_time, @end_time, @reminder_offset, @repeat_rule, @created_at, @updated_at)`
      )
      .run({
        id,
        title: item.title,
        start_time: item.startTime,
        end_time: item.endTime,
        reminder_offset: item.reminderOffset,
        repeat_rule: item.repeatRule,
        created_at: now,
        updated_at: now,
      });
    // 主键已确保存在，断言非空以简化调用方类型
    return this.getById(id) as Schedule;
  }

  update(id: string, patch: Partial<Schedule>): Schedule | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.title !== undefined) {
      sets.push('title = @title');
      params.title = patch.title;
    }
    if (patch.startTime !== undefined) {
      sets.push('start_time = @start_time');
      params.start_time = patch.startTime;
    }
    if (patch.endTime !== undefined) {
      sets.push('end_time = @end_time');
      params.end_time = patch.endTime;
    }
    if (patch.reminderOffset !== undefined) {
      sets.push('reminder_offset = @reminder_offset');
      params.reminder_offset = patch.reminderOffset;
    }
    if (patch.repeatRule !== undefined) {
      sets.push('repeat_rule = @repeat_rule');
      params.repeat_rule = patch.repeatRule;
    }
    // 没有字段需要更新时，直接返回当前记录，避免无意义写库
    if (sets.length === 0) {
      return this.getById(id);
    }
    sets.push('updated_at = @updated_at');
    params.updated_at = this.now();
    this.db.prepare(`UPDATE schedule_items SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getById(id);
  }
}
