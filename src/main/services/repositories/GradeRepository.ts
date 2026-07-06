// 成绩仓库：对应 grades 表
// is_degree_course 以 0/1 存储，读写时与 boolean 互转
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Grade } from '../../../shared/types';
import { BaseEntityRepository } from './BaseRepository';

interface GradeRow {
  id: string;
  course_name: string;
  semester: string;
  credit: number;
  grade_point: number;
  score: number | null;
  is_degree_course: number;
  created_at: string;
  updated_at: string;
}

export class GradeRepository extends BaseEntityRepository<Grade> {
  constructor(db: Database.Database) {
    super(db);
  }

  protected get tableName(): string {
    return 'grades';
  }

  protected mapRow(row: Record<string, unknown>): Grade {
    const r = row as unknown as GradeRow;
    return {
      id: r.id,
      courseName: r.course_name,
      semester: r.semester,
      credit: r.credit,
      gradePoint: r.grade_point,
      score: r.score ?? undefined,
      isDegreeCourse: r.is_degree_course === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  add(item: Omit<Grade, 'id' | 'createdAt' | 'updatedAt'>): Grade {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO grades
          (id, course_name, semester, credit, grade_point, score, is_degree_course, created_at, updated_at)
         VALUES
          (@id, @course_name, @semester, @credit, @grade_point, @score, @is_degree_course, @created_at, @updated_at)`
      )
      .run({
        id,
        course_name: item.courseName,
        semester: item.semester,
        credit: item.credit,
        grade_point: item.gradePoint,
        score: item.score ?? null,
        is_degree_course: item.isDegreeCourse ? 1 : 0,
        created_at: now,
        updated_at: now,
      });
    return this.getById(id) as Grade;
  }

  update(id: string, patch: Partial<Grade>): Grade | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.courseName !== undefined) {
      sets.push('course_name = @course_name');
      params.course_name = patch.courseName;
    }
    if (patch.semester !== undefined) {
      sets.push('semester = @semester');
      params.semester = patch.semester;
    }
    if (patch.credit !== undefined) {
      sets.push('credit = @credit');
      params.credit = patch.credit;
    }
    if (patch.gradePoint !== undefined) {
      sets.push('grade_point = @grade_point');
      params.grade_point = patch.gradePoint;
    }
    if (patch.score !== undefined) {
      sets.push('score = @score');
      params.score = patch.score;
    }
    if (patch.isDegreeCourse !== undefined) {
      sets.push('is_degree_course = @is_degree_course');
      params.is_degree_course = patch.isDegreeCourse ? 1 : 0;
    }
    if (sets.length === 0) {
      return this.getById(id);
    }
    sets.push('updated_at = @updated_at');
    params.updated_at = this.now();
    this.db.prepare(`UPDATE grades SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getById(id);
  }
}
