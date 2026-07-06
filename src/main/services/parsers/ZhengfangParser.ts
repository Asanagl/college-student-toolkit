// 正方教务系统解析器
// 特征：#Table1 表格，单元格内 .TDContent，单元格内可能含多门课程（用 <br> 分隔）
// 每门课程信息按行：课程名 / 教师 / 周次 / 节次，常见格式：
//   "高等数学<br>张三<br>1-16周<br>第1-2节<br>教学楼A101"
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { ParserBase } from './ParserBase';
import type { ParsedCourse } from './types';

// 预设色板，按课程名哈希分配稳定颜色
const COLOR_PALETTE = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9C27B0', '#00BCD4', '#FF9800', '#795548'];

function pickColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}

export class ZhengfangParser extends ParserBase {
  get name(): string {
    return 'zhengfang';
  }

  detect(html: string): boolean {
    const $ = cheerio.load(html);
    if ($('#Table1').length > 0) return true;
    if (/正方|教务|课表/.test($('title').text() || '')) {
      return $('#Table1, table[bordercolor]').length > 0;
    }
    return false;
  }

  parse(html: string): ParsedCourse[] {
    const $ = cheerio.load(html);
    const results: ParsedCourse[] = [];
    const table = $('#Table1').first();
    if (table.length === 0) return results;

    const rows = table.find('tr').toArray();
    let currentPeriod = 0;
    for (const row of rows) {
      const cells = $(row).find('td, th').toArray();
      let colIndex = 0;
      for (const cell of cells) {
        const $cell = $(cell);
        const text = this.cleanText($cell.text());
        if (this.isPeriodLabel(text)) {
          const periods = this.parsePeriods(text);
          if (periods) {
            currentPeriod = periods[0];
            colIndex++;
            continue;
          }
        }
        colIndex++;
        // 列索引对应星期：colIndex=2 → 周一
        const weekday = colIndex - 1;
        if (weekday < 1 || weekday > 7) continue;
        const segments = this.splitCellSegments($, $cell);
        for (const seg of segments) {
          const course = this.parseSegment(seg, weekday, currentPeriod);
          if (course && course.name) results.push(course);
        }
      }
      currentPeriod++;
    }
    return results;
  }

  private isPeriodLabel(text: string): boolean {
    return /^第[一二三四五六七八九十\d]+节/.test(text) || /^第?\d+$/.test(text);
  }

  /** 拆分单元格内多门课程：优先按 .TDContent 拆，回退到 <br><br> 拆分 */
  private splitCellSegments(
    $: CheerioAPI,
    $cell: ReturnType<CheerioAPI>
  ): string[] {
    const tdContents = $cell.find('.TDContent').toArray();
    if (tdContents.length > 0) {
      return tdContents.map((c) => this.cleanText($(c).text()));
    }
    const cellHtml = $cell.html();
    if (!cellHtml) return [];
    return cellHtml
      .split(/<br\s*\/?>\s*<br\s*\/?>/i)
      .map((s) => this.cleanText(this.stripTags(s)))
      .filter((s) => s.length > 0);
  }

  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, ' ');
  }

  /** 解析单门课程段，按行匹配字段 */
  private parseSegment(seg: string, weekday: number, fallbackPeriod: number): ParsedCourse | null {
    if (!seg) return null;
    const lines = seg
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
      // 教师通常为 2-10 字汉字/字母且不含数字
      if (!course.teacher && /^[\u4e00-\u9fa5A-Za-z·]{2,10}$/.test(line)) {
        course.teacher = line;
        continue;
      }
      // 地点通常含楼/室/楼层数字
      if (!course.location && /[\u4e00-\u9fa5].*\d|楼|室|号|栋|层/.test(line)) {
        course.location = line;
      }
    }
    if (!course.startPeriod) course.startPeriod = fallbackPeriod;
    if (!course.endPeriod) course.endPeriod = course.startPeriod;
    return course;
  }
}
