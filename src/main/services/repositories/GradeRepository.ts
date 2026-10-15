// 成绩仓库：对应 grades 表
// is_degree_course 以 0/1 存储，读写时与 boolean 互转
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  evaluateGpaFormula,
  type GpaGradeValues,
} from '../../../shared/gpa';
import type {
  Grade,
  GradeDashboard,
  GradePageQuery,
  GradePageResult,
  GpaFormula,
} from '../../../shared/types';
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

interface GradeSummaryRow extends GpaGradeValues {
  semester: string;
  is_degree_course: number;
}

interface SemesterCountRow {
  semester: string;
  count: number;
}

interface DashboardAggregateRow extends SemesterCountRow {
  total_credit: number;
  weighted_points: number;
  degree_count: number;
  degree_credit: number;
  degree_weighted_points: number;
}

const DEFAULT_GPA_FORMULA = "SUM(credit * gradePoint) / SUM(credit)";

function semesterParts(value: string): [number, number, number] {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : [0, 0, 0];
}

function compareSemesters(left: string, right: string): number {
  const a = semesterParts(left);
  const b = semesterParts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
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

  listPage(query: GradePageQuery): GradePageResult {
    const filter = this.buildFilter(query);
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM grades ${filter.where}`)
      .get(filter.params) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM grades ${filter.where}
         ORDER BY course_name COLLATE NOCASE ASC, id ASC
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        ...filter.params,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      }) as Record<string, unknown>[];
    return {
      items: rows.map((row) => this.mapRow(row)),
      page: query.page,
      pageSize: query.pageSize,
      total: countRow.count,
    };
  }

  getDashboard(formula: GpaFormula): GradeDashboard {
    if (formula.formula.trim() === DEFAULT_GPA_FORMULA)
      return this.getWeightedDashboard(formula);
    const semesters = this.listSemesterCounts();
    const rows = this.listSummaryRows();
    const ordered = [...semesters].sort((a, b) =>
      compareSemesters(b.semester, a.semester),
    );
    const latestSemester = ordered[0]?.semester ?? null;
    const latest = rows.filter((row) => row.semester === latestSemester);
    const degree = rows.filter((row) => row.is_degree_course === 1);
    return {
      formula,
      semesters: ordered,
      totalCount: rows.length,
      degreeCount: degree.length,
      latestSemester,
      semesterGpa: this.safeGpa(formula, latest),
      overallGpa: this.safeGpa(formula, rows),
      degreeGpa: this.safeGpa(formula, degree),
      totalCredit: rows.reduce((total, row) => total + row.credit, 0),
    };
  }

  private getWeightedDashboard(formula: GpaFormula): GradeDashboard {
    const rows = this.db
      .prepare(
        `SELECT semester, COUNT(*) AS count,
                SUM(credit) AS total_credit,
                SUM(credit * grade_point) AS weighted_points,
                SUM(CASE WHEN is_degree_course = 1 THEN 1 ELSE 0 END) AS degree_count,
                SUM(CASE WHEN is_degree_course = 1 THEN credit ELSE 0 END) AS degree_credit,
                SUM(CASE WHEN is_degree_course = 1 THEN credit * grade_point ELSE 0 END)
                  AS degree_weighted_points
         FROM grades
         GROUP BY semester`,
      )
      .all() as DashboardAggregateRow[];
    const ordered = [...rows].sort((a, b) =>
      compareSemesters(b.semester, a.semester),
    );
    const total = this.sumAggregate(rows);
    const degreeCount = rows.reduce((sum, row) => sum + row.degree_count, 0);
    const latest = ordered[0];
    return {
      formula,
      semesters: ordered.map(({ semester, count }) => ({ semester, count })),
      totalCount: total.count,
      degreeCount,
      latestSemester: latest?.semester ?? null,
      semesterGpa: latest
        ? this.safeRatio(latest.weighted_points, latest.total_credit)
        : 0,
      overallGpa: this.safeRatio(total.weighted, total.credit),
      degreeGpa: this.safeRatio(total.degreeWeighted, total.degreeCredit),
      totalCredit: total.credit,
    };
  }

  private sumAggregate(rows: readonly DashboardAggregateRow[]): {
    count: number;
    credit: number;
    weighted: number;
    degreeCredit: number;
    degreeWeighted: number;
  } {
    return rows.reduce(
      (total, row) => ({
        count: total.count + row.count,
        credit: total.credit + row.total_credit,
        weighted: total.weighted + row.weighted_points,
        degreeCredit: total.degreeCredit + row.degree_credit,
        degreeWeighted: total.degreeWeighted + row.degree_weighted_points,
      }),
      { count: 0, credit: 0, weighted: 0, degreeCredit: 0, degreeWeighted: 0 },
    );
  }

  private safeRatio(numerator: number, denominator: number): number {
    if (denominator === 0) return 0;
    return Math.round((numerator / denominator) * 100) / 100;
  }

  private buildFilter(query: GradePageQuery): {
    where: string;
    params: Record<string, string | number>;
  } {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
    if (query.semester) {
      conditions.push('semester = @semester');
      params.semester = query.semester;
    }
    if (query.degreeOnly) conditions.push('is_degree_course = 1');
    return {
      where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  private listSemesterCounts(): SemesterCountRow[] {
    return this.db
      .prepare(
        'SELECT semester, COUNT(*) AS count FROM grades GROUP BY semester',
      )
      .all() as SemesterCountRow[];
  }

  private listSummaryRows(): GradeSummaryRow[] {
    return this.db
      .prepare(
        `SELECT semester, credit, grade_point AS gradePoint, score,
                is_degree_course
         FROM grades`,
      )
      .all() as GradeSummaryRow[];
  }

  private safeGpa(formula: GpaFormula, rows: readonly GpaGradeValues[]): number {
    try {
      return evaluateGpaFormula(formula.formula, rows);
    } catch {
      return 0;
    }
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
