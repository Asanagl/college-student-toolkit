// 解析器基类：提供周次/节次字符串解析等通用工具，具体解析逻辑由子类实现。
// 抽象方法 detect/parse 由各教务系统解析器覆盖。
import type { ParsedCourse } from './types';

export abstract class ParserBase {
  abstract get name(): string;
  abstract detect(html: string): boolean;
  abstract parse(html: string): ParsedCourse[];

  /**
   * 解析周次字符串为 [startWeek, endWeek]。
   * 支持形式：
   *   "1-16周" → [1, 16]
   *   "1,3,5周" → [1, 5]（取最小与最大作为范围）
   *   "1-16" → [1, 16]
   *   "全周" / "" → [1, 16] 默认整学期
   */
  protected parseWeeks(text: string): [number, number] | null {
    if (!text) return null;
    const cleaned = text.replace(/\s/g, '');
    // 范围形式：1-16 / 1~16
    const rangeMatch = /(\d+)\s*[-~]\s*(\d+)/.exec(cleaned);
    if (rangeMatch) {
      const a = Number.parseInt(rangeMatch[1], 10);
      const b = Number.parseInt(rangeMatch[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return [Math.min(a, b), Math.max(a, b)];
      }
    }
    // 离散形式：1,3,5,7
    const parts = cleaned
      .replace(/[周]/g, '')
      .split(/[,，、]/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (parts.length > 0) {
      return [Math.min(...parts), Math.max(...parts)];
    }
    return null;
  }

  /**
   * 解析节次字符串为 [startPeriod, endPeriod]。
   * 支持形式：
   *   "1-2节" → [1, 2]
   *   "第1-2节" → [1, 2]
   *   "1节" → [1, 1]
   */
  protected parsePeriods(text: string): [number, number] | null {
    if (!text) return null;
    const cleaned = text.replace(/\s/g, '').replace(/第/g, '').replace(/节/g, '');
    const rangeMatch = /(\d+)\s*[-~]\s*(\d+)/.exec(cleaned);
    if (rangeMatch) {
      const a = Number.parseInt(rangeMatch[1], 10);
      const b = Number.parseInt(rangeMatch[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return [Math.min(a, b), Math.max(a, b)];
      }
    }
    const m = /(\d+)/.exec(cleaned);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) return [n, n];
    }
    return null;
  }

  /** 解析星期："周一"/"星期一"/"1" → 1，失败返回 null */
  protected parseWeekday(text: string): number | null {
    if (!text) return null;
    const cleaned = text.replace(/\s/g, '');
    const map: Record<string, number> = {
      一: 1, 壹: 1, '1': 1,
      二: 2, 贰: 2, '2': 2,
      三: 3, 叁: 3, '3': 3,
      四: 4, 肆: 4, '4': 4,
      五: 5, 伍: 5, '5': 5,
      六: 6, 陆: 6, '6': 6,
      日: 7, 天: 7, 末: 7, 柒: 7, '7': 7,
    };
    // 优先匹配 "周X" / "星期X"
    const m = /(?:星期|周)([一二三四五六日天末壹贰叁肆伍陆柒1234567])/.exec(cleaned);
    if (m && map[m[1]]) return map[m[1]];
    // 纯数字
    const n = Number.parseInt(cleaned, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 7) return n;
    return null;
  }

  /** 清理单元格文本中的 &nbsp; 与多余空白 */
  protected cleanText(text: string): string {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
