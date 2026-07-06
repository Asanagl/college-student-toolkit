// 解析器入口：遍历所有解析器，用 detect 选择匹配的，无匹配则尝试通用 table 解析。
// 通用 table 解析把第一个含 7 列以上且含中文的 table 视为课表，按行列启发式提取。
import * as cheerio from 'cheerio';
import { ParserBase } from './ParserBase';
import { QingguoParser } from './QingguoParser';
import { UrpParser } from './UrpParser';
import { ZhengfangParser } from './ZhengfangParser';
import type { ParsedCourse } from './types';

export type { ParsedCourse, Parser } from './types';
export { ParserBase } from './ParserBase';

const PARSERS: ParserBase[] = [
  new ZhengfangParser(),
  new UrpParser(),
  new QingguoParser(),
];

/** 通用表格解析器：检测到含 7 列的 table 即尝试解析，作为兜底 */
class GenericTableParser extends ParserBase {
  get name(): string {
    return 'generic';
  }

  detect(html: string): boolean {
    const $ = cheerio.load(html);
    const tables = $('table').toArray();
    return tables.some((t) => {
      const cols = $(t).find('tr').first().find('td, th').length;
      return cols >= 7;
    });
  }

  parse(html: string): ParsedCourse[] {
    const $ = cheerio.load(html);
    const results: ParsedCourse[] = [];
    // 找列数 >= 7 的第一个 table 作为课表
    const tables = $('table').toArray();
    const target = tables.find((t) => $(t).find('tr').first().find('td, th').length >= 7);
    if (!target) return results;

    const rows = $(target).find('tr').toArray();
    let currentPeriod = 0;
    for (const row of rows) {
      const cells = $(row).find('td, th').toArray();
      let colIndex = 0;
      for (const cell of cells) {
        const $cell = $(cell);
        const text = this.cleanText($cell.text());
        if (/^第?\d+$/.test(text) || /^第[一二三四五六七八九十\d]+节/.test(text)) {
          const periods = this.parsePeriods(text);
          if (periods) {
            currentPeriod = periods[0];
            colIndex++;
            continue;
          }
        }
        colIndex++;
        const weekday = colIndex - 1;
        if (weekday < 1 || weekday > 7) continue;
        if (!text || text.length < 2) continue;
        // 启发式：单元格内第一段为课程名
        const lines = text
          .split(/\n|，|,| {2,}/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (lines.length === 0) continue;
        const course: ParsedCourse = {
          name: lines[0],
          weekday,
          startPeriod: currentPeriod,
          endPeriod: currentPeriod,
        };
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          const weeks = this.parseWeeks(line);
          if (weeks && course.startWeek === undefined) {
            course.startWeek = weeks[0];
            course.endWeek = weeks[1];
            continue;
          }
          const periods = this.parsePeriods(line);
          if (periods && course.startPeriod === currentPeriod) {
            course.startPeriod = periods[0];
            course.endPeriod = periods[1];
            continue;
          }
          if (!course.teacher && /^[\u4e00-\u9fa5A-Za-z·]{2,10}$/.test(line)) {
            course.teacher = line;
            continue;
          }
          if (!course.location && /[\u4e00-\u9fa5].*\d|楼|室|号|栋|层/.test(line)) {
            course.location = line;
          }
        }
        results.push(course);
      }
      currentPeriod++;
    }
    return results;
  }
}

/**
 * 用所有注册的解析器解析 HTML，返回课程列表。
 * 优先用 detect 命中的专用解析器，全部未命中时回退到 GenericTableParser。
 */
export function parseDomWithAllParsers(html: string): ParsedCourse[] {
  if (!html) return [];
  for (const parser of PARSERS) {
    try {
      if (parser.detect(html)) {
        const result = parser.parse(html);
        if (result.length > 0) return result;
      }
    } catch (err) {
      // 单个解析器失败不影响其他解析器尝试
      console.error(`[parsers] ${parser.name} 解析失败: ${(err as Error).message}`);
    }
  }
  // 兜底：通用 table 解析
  try {
    const generic = new GenericTableParser();
    if (generic.detect(html)) return generic.parse(html);
  } catch (err) {
    console.error(`[parsers] 通用解析失败: ${(err as Error).message}`);
  }
  return [];
}
