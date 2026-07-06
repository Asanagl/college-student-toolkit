// 考试解析器基类：提供日期/时间/座位等通用解析工具，具体解析逻辑由子类实现。
// 抽象方法 detect/parse 由各教务系统考试页解析器覆盖。
import type { ParsedExam } from './types';

export abstract class ExamParserBase {
  abstract get name(): string;
  abstract detect(html: string): boolean;
  abstract parse(html: string): ParsedExam[];

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
    // 年月日形式
    const cnMatch = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(cleaned);
    if (cnMatch) {
      return this.formatDate(cnMatch[1], cnMatch[2], cnMatch[3]);
    }
    // 分隔符形式：- / .
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

  /**
   * 解析座位号：从文本中提取"座位号:xxx"/"座位：xxx"/"座号xxx"等模式。
   */
  protected parseSeat(text: string): string | null {
    if (!text) return null;
    const match = /(?:座位号|座位|座号)[:：]?\s*([A-Za-z0-9\-]{1,10})/.exec(text);
    if (match) return match[1];
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
