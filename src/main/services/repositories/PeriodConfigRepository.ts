// 节次配置仓库：对应 period_config 表
// 注意：主键是 period_index 而非 id，且无 created_at/updated_at，因此不继承 BaseEntityRepository
import type Database from 'better-sqlite3';
import type { PeriodConfig } from '../../../shared/types';

interface PeriodConfigRow {
  period_index: number;
  start_time: string;
  end_time: string;
  break_after: number;
  is_lab: number;
  reminder_offset: number;
}

export class PeriodConfigRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private mapRow(row: Record<string, unknown>): PeriodConfig {
    const r = row as unknown as PeriodConfigRow;
    return {
      index: r.period_index,
      startTime: r.start_time,
      endTime: r.end_time,
      breakAfter: r.break_after,
      isLab: r.is_lab === 1,
      reminderOffset: r.reminder_offset,
    };
  }

  /** 返回全部节次配置，按 index 升序 */
  getAll(): PeriodConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM period_config ORDER BY period_index ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  getByIndex(index: number): PeriodConfig | null {
    const row = this.db
      .prepare('SELECT * FROM period_config WHERE period_index = ?')
      .get(index) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** 批量保存节次配置：先清空再插入，保证与传入数组完全一致 */
  saveAll(configs: PeriodConfig[]): void {
    const tx = this.db.transaction((items: PeriodConfig[]) => {
      this.db.prepare('DELETE FROM period_config').run();
      const stmt = this.db.prepare(
        `INSERT INTO period_config
          (period_index, start_time, end_time, break_after, is_lab, reminder_offset)
         VALUES
          (@period_index, @start_time, @end_time, @break_after, @is_lab, @reminder_offset)`
      );
      for (const item of items) {
        stmt.run({
          period_index: item.index,
          start_time: item.startTime,
          end_time: item.endTime,
          break_after: item.breakAfter,
          is_lab: item.isLab ? 1 : 0,
          reminder_offset: item.reminderOffset,
        });
      }
    });
    tx(configs);
  }

  /** 插入单条（用于初始化默认数据） */
  insert(item: PeriodConfig): void {
    this.db
      .prepare(
        `INSERT INTO period_config
          (period_index, start_time, end_time, break_after, is_lab, reminder_offset)
         VALUES
          (@period_index, @start_time, @end_time, @break_after, @is_lab, @reminder_offset)`
      )
      .run({
        period_index: item.index,
        start_time: item.startTime,
        end_time: item.endTime,
        break_after: item.breakAfter,
        is_lab: item.isLab ? 1 : 0,
        reminder_offset: item.reminderOffset,
      });
  }
}
