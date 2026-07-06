// 成绩服务：管理成绩录入与 GPA 计算（基于 expr-eval 的可配置公式）。
// 实现阶段：Phase 6
import { Parser } from 'expr-eval';
import type { Grade, GpaFormula, IpcResult } from '../../shared/types';
import { dataService } from './DataService';

/** 默认 GPA 公式：学分加权绩点 */
export const DEFAULT_GPA_FORMULA = 'SUM(credit * gradePoint) / SUM(credit)';

/** 所有 GPA 计算结果集合 */
export interface GpaSummary {
  /** 各学期 GPA，键为 semester 字符串 */
  semesterGpas: Record<string, number>;
  /** 总体 GPA（所有课程） */
  overallGpa: number;
  /** 学位课 GPA（仅 isDegreeCourse=true 的课程） */
  degreeCourseGpa: number;
}

export class GradeService {
  private static instance: GradeService | null = null;
  private initialized = false;
  /**
   * 复用单个 Parser 实例：expr-eval 的 Parser 是无状态的（解析后产生独立 Expression），
   * 全局复用可避免重复构造开销。
   */
  private readonly parser: Parser;

  private constructor() {
    this.parser = new Parser();
  }

  static getInstance(): GradeService {
    if (!GradeService.instance) {
      GradeService.instance = new GradeService();
    }
    return GradeService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    // 默认公式由 DataService.seedDefaults 负责播种，此处无需重复
    this.initialized = true;
  }

  /**
   * 计算给定成绩集合的 GPA。
   *
   * 实现思路：
   * 1. 公式中可能含 SUM(inner) 聚合，inner 是以单门课程的 credit/gradePoint/score 为变量的表达式
   * 2. 先把每个 SUM(inner) 展开为「对每条 grade 求 inner 之和」的数值，替换回公式
   * 3. 展开后的公式只剩纯算术（含数值与四则运算符），用 expr-eval 求值
   * 4. 结果保留 2 位小数
   *
   * 空集合返回 0，避免除零错误。
   */
  calculateGpa(grades: Grade[], formula: GpaFormula): number {
    if (grades.length === 0) return 0;
    const expanded = this.expandSumExpressions(formula.formula, grades);
    const expr = this.parser.parse(expanded);
    const raw = expr.evaluate();
    const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return Math.round(num * 100) / 100;
  }

  /**
   * 计算全部 GPA 指标：各学期 GPA、总体 GPA、学位课 GPA。
   * 从 DataService 读取成绩与默认公式；若没有任何公式记录，回退到内置默认公式。
   */
  async calculateAllGpas(): Promise<GpaSummary> {
    const grades = dataService.grades.list();
    const formulas = dataService.formulas.list();
    const formula: GpaFormula =
      formulas.find((f) => f.isDefault) ??
      formulas[0] ?? {
        id: 'default',
        name: '默认公式',
        formula: DEFAULT_GPA_FORMULA,
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

    // 按学期分组，保持插入顺序
    const semesterMap = new Map<string, Grade[]>();
    for (const g of grades) {
      const list = semesterMap.get(g.semester) ?? [];
      list.push(g);
      semesterMap.set(g.semester, list);
    }

    const semesterGpas: Record<string, number> = {};
    for (const [semester, list] of semesterMap) {
      semesterGpas[semester] = this.calculateGpa(list, formula);
    }

    const overallGpa = this.calculateGpa(grades, formula);
    const degreeGrades = grades.filter((g) => g.isDegreeCourse);
    const degreeCourseGpa = this.calculateGpa(degreeGrades, formula);

    return { semesterGpas, overallGpa, degreeCourseGpa };
  }

  /**
   * 将公式中的每个 SUM(inner) 替换为对全体 grades 求 inner 之和的数值。
   * 用括号包裹替换值，避免负数与相邻运算符产生解析歧义（如 3/-2）。
   */
  private expandSumExpressions(formula: string, grades: Grade[]): string {
    let result = formula;
    let searchFrom = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sumStart = result.indexOf('SUM(', searchFrom);
      if (sumStart === -1) break;

      // 找到 SUM( 对应的右括号：用深度计数处理嵌套括号
      let depth = 1;
      let i = sumStart + 4;
      while (i < result.length && depth > 0) {
        const ch = result[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth === 0) break;
        i++;
      }
      if (depth !== 0) {
        throw new Error('GPA 公式 SUM(...) 括号不匹配');
      }

      const innerExpr = result.substring(sumStart + 4, i);
      const sumValue = this.sumOverGrades(innerExpr, grades);
      const replacement = `(${sumValue})`;
      result = result.substring(0, sumStart) + replacement + result.substring(i + 1);
      searchFrom = sumStart + replacement.length;
    }
    return result;
  }

  /**
   * 对每条 grade 求内部表达式的值并汇总。
   * score 可能为空（等级制），此时以 0 代入——用户应在公式中规避对 score 的依赖。
   */
  private sumOverGrades(innerExpr: string, grades: Grade[]): number {
    const expr = this.parser.parse(innerExpr);
    let sum = 0;
    for (const g of grades) {
      const v = expr.evaluate({
        credit: g.credit,
        gradePoint: g.gradePoint,
        score: g.score ?? 0,
      });
      const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
      sum += n;
    }
    return sum;
  }

  // ===== 以下方法为早期占位，主进程 IPC 实际通过 DataService 仓库访问，
  //       保留方法签名以便后续阶段按需接入业务逻辑（如触发通知等）。=====

  async list(): Promise<IpcResult<Grade[]>> {
    return { ok: true, data: [] };
  }

  async add(_item: Omit<Grade, 'id' | 'createdAt' | 'updatedAt'>): Promise<IpcResult<Grade>> {
    throw new Error('GradeService.add 未实现 (Phase 6)');
  }

  async update(_id: string, _patch: Partial<Grade>): Promise<IpcResult<Grade>> {
    throw new Error('GradeService.update 未实现 (Phase 6)');
  }

  async remove(_id: string): Promise<IpcResult<boolean>> {
    throw new Error('GradeService.remove 未实现 (Phase 6)');
  }

  async getFormula(_id: string): Promise<IpcResult<GpaFormula | null>> {
    return { ok: true, data: null };
  }

  async saveFormula(_formula: Omit<GpaFormula, 'updatedAt'>): Promise<IpcResult<GpaFormula>> {
    throw new Error('GradeService.saveFormula 未实现 (Phase 6)');
  }

  async listFormulas(): Promise<IpcResult<GpaFormula[]>> {
    return { ok: true, data: [] };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }
}

export const gradeService = GradeService.getInstance();
