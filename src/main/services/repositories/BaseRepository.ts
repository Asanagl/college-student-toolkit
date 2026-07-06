// 实体仓库基类：为带 id 主键的表提供通用的 list/getById/remove 实现
// add 与 update 因各表列差异由子类实现，避免基类做过度的抽象
import type Database from 'better-sqlite3';
import type { BaseEntity } from '../../../shared/types';

export abstract class BaseEntityRepository<T extends BaseEntity> {
  protected readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  protected abstract get tableName(): string;

  /** 将数据库行（snake_case）映射为实体对象（camelCase） */
  protected abstract mapRow(row: Record<string, unknown>): T;

  list(): T[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.tableName}`).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  getById(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  remove(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** 当前时间的 ISO 8601 字符串，用于 created_at / updated_at */
  protected now(): string {
    return new Date().toISOString();
  }
}
