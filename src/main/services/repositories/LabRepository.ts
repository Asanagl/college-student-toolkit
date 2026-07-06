// 实验仓库：对应 labs 表
// reminder_offsets 以 JSON 字符串存储
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Lab } from '../../../shared/types';
import { BaseEntityRepository } from './BaseRepository';

interface LabRow {
  id: string;
  name: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string | null;
  instructor: string | null;
  notes: string | null;
  reminder_offsets: string;
  created_at: string;
  updated_at: string;
}

export class LabRepository extends BaseEntityRepository<Lab> {
  constructor(db: Database.Database) {
    super(db);
  }

  protected get tableName(): string {
    return 'labs';
  }

  protected mapRow(row: Record<string, unknown>): Lab {
    const r = row as unknown as LabRow;
    return {
      id: r.id,
      name: r.name,
      date: r.date,
      startTime: r.start_time,
      endTime: r.end_time,
      location: r.location ?? undefined,
      instructor: r.instructor ?? undefined,
      notes: r.notes ?? undefined,
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

  add(item: Omit<Lab, 'id' | 'createdAt' | 'updatedAt'>): Lab {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO labs
          (id, name, date, start_time, end_time, location, instructor, notes, reminder_offsets, created_at, updated_at)
         VALUES
          (@id, @name, @date, @start_time, @end_time, @location, @instructor, @notes, @reminder_offsets, @created_at, @updated_at)`
      )
      .run({
        id,
        name: item.name,
        date: item.date,
        start_time: item.startTime,
        end_time: item.endTime,
        location: item.location ?? null,
        instructor: item.instructor ?? null,
        notes: item.notes ?? null,
        reminder_offsets: JSON.stringify(item.reminderOffsets),
        created_at: now,
        updated_at: now,
      });
    return this.getById(id) as Lab;
  }

  update(id: string, patch: Partial<Lab>): Lab | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.name !== undefined) {
      sets.push('name = @name');
      params.name = patch.name;
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
    if (patch.instructor !== undefined) {
      sets.push('instructor = @instructor');
      params.instructor = patch.instructor;
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
    this.db.prepare(`UPDATE labs SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getById(id);
  }
}
