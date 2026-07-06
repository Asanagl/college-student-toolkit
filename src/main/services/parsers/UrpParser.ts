// URP 教务系统解析器
// 特征：table.rowClasses 或 #userTable，每个课程块为 <td> 内文本按行分隔
// URP 系统常见单元格格式：
//   "高等数学\n张三\n1-16周\n1-2节\n教学楼A101"
import * as cheerio from 'cheerio';
import { ParserBase } from './ParserBase';
import type { ParsedCourse } from './types';

const COLOR_PALETTE = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9C27B0', '#00BCD4', '#FF9800', '#795548'];

function pickColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}

export class UrpParser extends ParserBase {
  get name(): string {
    return 'urp';
  }

  detect(html: string): boolean {
    const $ = cheerio.load(html);
    // URP 特征：rowClasses 类或 userTable id
    if ($('table.rowClasses, #userTable, .gridtable').length > 0) return true;
    const title = $('title').text() || '';
    return /URP|综合教务/.test(title) && $('table').length > 0;
  }

  parse(html: string): ParsedCourse[] {
    const $ = cheerio.load(html);
    const results: ParsedCourse[] = [];
    const table = $('table.rowClasses, #userTable, .gridtable').first();
    if (table.length === 0) return results;

    const rows = table.find('tr').toArray();
    let currentPeriod = 0;
    for (const row of rows) {
      const cells = $(row).find('td, th').toArray();
      let colIndex = 0;
      for (const cell of cells) {
        const $cell = $(cell);
        const text = this.cleanText($cell.text());
        // 节次标签
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
        if (!text) continue;
        // URP 单元格通常按换行或 <br> 分隔多门课程
        const cellHtml = $cell.html() ?? '';
        const blocks = cellHtml.split(/<br\s*\/?>\s*<br\s*\/?>/i);
        for (const block of blocks) {
          const clean = this.cleanText(block.replace(/<[^>]+>/g, ' '));
          if (!clean) continue;
          const course = this.parseBlock(clean, weekday, currentPeriod);
          if (course && course.name) results.push(course);
        }
      }
      currentPeriod++;
    }
    return results;
  }

  private parseBlock(text: string, weekday: number, fallbackPeriod: number): ParsedCourse | null {
    const lines = text
      .split(/\n|，|,| {2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    const course: ParsedCourse = { weekday, color: pickColor(lines[0]) };
    course.name = lines[0];
    let periodsSet = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const weeks = this.parseWeeks(line);
      if (weeks && course.startWeek === undefined) {
        course.startWeek = weeks[0];
        course.endWeek = weeks[1];
        continue;
      }
      const periods = this.parsePeriods(line);
      if (periods && !periodsSet) {
        course.startPeriod = periods[0];
        course.endPeriod = periods[1];
        periodsSet = true;
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
    if (!course.startPeriod) course.startPeriod = fallbackPeriod;
    if (!course.endPeriod) course.endPeriod = course.startPeriod;
    return course;
  }
}
