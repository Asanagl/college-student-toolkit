// 课程仓库：对应 courses 表
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Course } from '../../../shared/types';
import { BaseEntityRepository } from './BaseRepository';

interface CourseRow {
  id: string;
  name: string;
  teacher: string | null;
  location: string | null;
  start_week: number;
  end_week: number;
  weekday: number;
  start_period: number;
  end_period: number;
  color: string;
  created_at: string;
  updated_at: string;
}

export class CourseRepository extends BaseEntityRepository<Course> {
  constructor(db: Database.Database) {
    super(db);
  }

  protected get tableName(): string {
    return 'courses';
  }

  protected mapRow(row: Record<string, unknown>): Course {
    const r = row as unknown as CourseRow;
    return {
      id: r.id,
      name: r.name,
      teacher: r.teacher ?? undefined,
      location: r.location ?? undefined,
      startWeek: r.start_week,
      endWeek: r.end_week,
      weekday: r.weekday as Course['weekday'],
      startPeriod: r.start_period,
      endPeriod: r.end_period,
      color: r.color,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  add(item: Omit<Course, 'id' | 'createdAt' | 'updatedAt'>): Course {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO courses
          (id, name, teacher, location, start_week, end_week, weekday, start_period, end_period, color, created_at, updated_at)
         VALUES
          (@id, @name, @teacher, @location, @start_week, @end_week, @weekday, @start_period, @end_period, @color, @created_at, @updated_at)`
      )
      .run({
        id,
        name: item.name,
        teacher: item.teacher ?? null,
        location: item.location ?? null,
        start_week: item.startWeek,
        end_week: item.endWeek,
        weekday: item.weekday,
        start_period: item.startPeriod,
        end_period: item.endPeriod,
        color: item.color,
        created_at: now,
        updated_at: now,
      });
    return this.getById(id) as Course;
  }

  update(id: string, patch: Partial<Course>): Course | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.name !== undefined) {
      sets.push('name = @name');
      params.name = patch.name;
    }
    if (patch.teacher !== undefined) {
      sets.push('teacher = @teacher');
      params.teacher = patch.teacher;
    }
    if (patch.location !== undefined) {
      sets.push('location = @location');
      params.location = patch.location;
    }
    if (patch.startWeek !== undefined) {
      sets.push('start_week = @start_week');
      params.start_week = patch.startWeek;
    }
    if (patch.endWeek !== undefined) {
      sets.push('end_week = @end_week');
      params.end_week = patch.endWeek;
    }
    if (patch.weekday !== undefined) {
      sets.push('weekday = @weekday');
      params.weekday = patch.weekday;
    }
    if (patch.startPeriod !== undefined) {
      sets.push('start_period = @start_period');
      params.start_period = patch.startPeriod;
    }
    if (patch.endPeriod !== undefined) {
      sets.push('end_period = @end_period');
      params.end_period = patch.endPeriod;
    }
    if (patch.color !== undefined) {
      sets.push('color = @color');
      params.color = patch.color;
    }
    if (sets.length === 0) {
      return this.getById(id);
    }
    sets.push('updated_at = @updated_at');
    params.updated_at = this.now();
    this.db.prepare(`UPDATE courses SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getById(id);
  }
}
