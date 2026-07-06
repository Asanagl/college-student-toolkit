// GPA 公式仓库：对应 gpa_formula 表
// is_default 以 0/1 存储，保存默认公式时会先把其他公式置为非默认
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { GpaFormula } from '../../../shared/types';
import { BaseEntityRepository } from './BaseRepository';

interface GpaFormulaRow {
  id: string;
  name: string;
  formula: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export class GpaFormulaRepository extends BaseEntityRepository<GpaFormula> {
  constructor(db: Database.Database) {
    super(db);
  }

  protected get tableName(): string {
    return 'gpa_formula';
  }

  protected mapRow(row: Record<string, unknown>): GpaFormula {
    const r = row as unknown as GpaFormulaRow;
    return {
      id: r.id,
      name: r.name,
      formula: r.formula,
      isDefault: r.is_default === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** 保存公式：若标记为默认，则先把其他公式的 is_default 清零，保证全局唯一默认 */
  save(item: Omit<GpaFormula, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): GpaFormula {
    const now = this.now();
    // 用事务包裹"清默认 + 插入/更新"，避免中途失败导致多个默认并存
    const tx = this.db.transaction((data: typeof item) => {
      if (data.isDefault) {
        this.db.prepare('UPDATE gpa_formula SET is_default = 0').run();
      }
      if (data.id) {
        const existing = this.getById(data.id);
        if (existing) {
          this.db
            .prepare(
              `UPDATE gpa_formula
               SET name = @name, formula = @formula, is_default = @is_default, updated_at = @updated_at
               WHERE id = @id`
            )
            .run({
              id: data.id,
              name: data.name,
              formula: data.formula,
              is_default: data.isDefault ? 1 : 0,
              updated_at: now,
            });
          return;
        }
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO gpa_formula
            (id, name, formula, is_default, created_at, updated_at)
           VALUES
            (@id, @name, @formula, @is_default, @created_at, @updated_at)`
        )
        .run({
          id,
          name: data.name,
          formula: data.formula,
          is_default: data.isDefault ? 1 : 0,
          created_at: now,
          updated_at: now,
        });
    });
    tx(item);
    // 入库后用 name+formula 反查过于脆弱，统一约定：save 总是返回按 id 查询的结果
    return this.getById(item.id ?? '') ?? this.findLatest();
  }

  /** 取最近一条公式（用于 save 时未显式给 id 的回退查询） */
  private findLatest(): GpaFormula {
    const row = this.db
      .prepare('SELECT * FROM gpa_formula ORDER BY updated_at DESC LIMIT 1')
      .get() as Record<string, unknown>;
    return this.mapRow(row);
  }
}
