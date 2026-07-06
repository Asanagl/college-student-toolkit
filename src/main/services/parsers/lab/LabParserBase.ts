// 实验解析器基类：提供日期/时间/教师等通用解析工具，具体解析逻辑由子类实现。
import type { ParsedLab } from './types';

export abstract class LabParserBase {
  abstract get name(): string;
  abstract detect(html: string): boolean;
  abstract parse(html: string): ParsedLab[];

  /**
   * 解析日期字符串为 YYYY-MM-DD。
   * 支持形式：
   *   "2026-01-05" → "2026-01-05"
   *   "2026/01/05" → "2026-01-05"
   *   "2026年1月5日" → "2026-01-05"
   *   "2026.1.5" → "2026-01-05"
   */
  protected parseDate(text: string): string | null {
    if (!text) return null;
    const cleaned = text.trim().replace(/\s/g, '');
    const cnMatch = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(cleaned);
    if (cnMatch) {
      return this.formatDate(cnMatch[1], cnMatch[2], cnMatch[3]);
    }
    const sepMatch = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(cleaned);
    if (sepMatch) {
      return this.formatDate(sepMatch[1], sepMatch[2], sepMatch[3]);
    }
    return null;
  }

  /** 将年月日数字补零后拼接为 YYYY-MM-DD */
  private formatDate(y: string, m: string, d: string): string {
    const mm = m.padStart(2, '0');
    const dd = d.padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  /**
   * 解析时间段字符串为 [startTime, endTime]。
   * 支持形式：
   *   "09:00-11:00" / "09:00~11:00" / "09:00—11:00"
   *   "9:00-11:00"
   */
  protected parseTimeRange(text: string): [string, string] | null {
    if (!text) return null;
    const cleaned = text.replace(/\s/g, '');
    const match = /(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})/.exec(cleaned);
    if (!match) return null;
    return [this.normalizeHHmm(match[1]), this.normalizeHHmm(match[2])];
  }

  /** 将 "9:00" 规范化为 "09:00" */
  protected normalizeHHmm(time: string): string {
    const parts = time.split(':');
    if (parts.length !== 2) return time;
    return `${parts[0].padStart(2, '0')}:${parts[1]}`;
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
