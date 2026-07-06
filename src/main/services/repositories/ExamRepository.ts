// 考试仓库：对应 exams 表
// reminder_offsets 以 JSON 字符串存储，读写时进行序列化/反序列化
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Exam } from '../../../shared/types';
import { BaseEntityRepository } from './BaseRepository';

interface ExamRow {
  id: string;
  course_name: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string | null;
  seat: string | null;
  notes: string | null;
  reminder_offsets: string;
  created_at: string;
  updated_at: string;
}

export class ExamRepository extends BaseEntityRepository<Exam> {
  constructor(db: Database.Database) {
    super(db);
  }

  protected get tableName(): string {
    return 'exams';
  }

  protected mapRow(row: Record<string, unknown>): Exam {
    const r = row as unknown as ExamRow;
    return {
      id: r.id,
      courseName: r.course_name,
      date: r.date,
      startTime: r.start_time,
      endTime: r.end_time,
      location: r.location ?? undefined,
      seat: r.seat ?? undefined,
      notes: r.notes ?? undefined,
      // 反序列化提醒偏移数组；容错处理异常 JSON
      reminderOffsets: this.parseOffsets(r.reminder_offsets),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private parseOffsets(raw: string): number[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as number[]) : [];
    } catch {
      return [];
    }
  }

  add(item: Omit<Exam, 'id' | 'createdAt' | 'updatedAt'>): Exam {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO exams
          (id, course_name, date, start_time, end_time, location, seat, notes, reminder_offsets, created_at, updated_at)
         VALUES
          (@id, @course_name, @date, @start_time, @end_time, @location, @seat, @notes, @reminder_offsets, @created_at, @updated_at)`
      )
      .run({
        id,
        course_name: item.courseName,
        date: item.date,
        start_time: item.startTime,
        end_time: item.endTime,
        location: item.location ?? null,
        seat: item.seat ?? null,
        notes: item.notes ?? null,
        reminder_offsets: JSON.stringify(item.reminderOffsets),
        created_at: now,
        updated_at: now,
      });
    return this.getById(id) as Exam;
  }

  update(id: string, patch: Partial<Exam>): Exam | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.courseName !== undefined) {
      sets.push('course_name = @course_name');
      params.course_name = patch.courseName;
    }
    if (patch.date !== undefined) {
      sets.push('date = @date');
      params.date = patch.date;
    }
    if (patch.startTime !== undefined) {
      sets.push('start_time = @start_time');
      params.start_time = patch.startTime;
    }
    if (patch.endTime !== undefined) {
      sets.push('end_time = @end_time');
      params.end_time = patch.endTime;
    }
    if (patch.location !== undefined) {
      sets.push('location = @location');
      params.location = patch.location;
    }
    if (patch.seat !== undefined) {
      sets.push('seat = @seat');
      params.seat = patch.seat;
    }
    if (patch.notes !== undefined) {
      sets.push('notes = @notes');
      params.notes = patch.notes;
    }
    if (patch.reminderOffsets !== undefined) {
      sets.push('reminder_offsets = @reminder_offsets');
      params.reminder_offsets = JSON.stringify(patch.reminderOffsets);
    }
    if (sets.length === 0) {
      return this.getById(id);
    }
    sets.push('updated_at = @updated_at');
    params.updated_at = this.now();
    this.db.prepare(`UPDATE exams SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getById(id);
  }
}
