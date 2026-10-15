// 正方教务系统解析器
// 特征：#Table1 表格。两种单元格格式：
//   旧版：<div class="TDContent">高等数学,张老师,1-16周,第1-2节,教学楼A101</div>
//   新版（4.0 课表页）：名称<br>必修<br>周一第1,2节{第1-16周}<br>教师<br>地点，
//   课程格 rowspan=2 跨节次，单格多课用 <br><br> 分隔，周次可带 |单周|双周。
// 新版布局的标签列不恒定（上午/下午/晚上只在首行出现），必须按 rowspan/colspan
// 展开网格定位星期，否则非首行课程的星期会整体错一列（真实样本实测复现）。
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { ParserBase } from './ParserBase';
import type {
  ParsedCourse,
  ParseResult,
  SkippedUnscheduledCourse,
} from './types';

// 预设色板，按课程名哈希分配稳定颜色
const COLOR_PALETTE = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9C27B0', '#00BCD4', '#FF9800', '#795548'];

type WeekParity = 'all' | 'odd' | 'even';

interface RawCourse extends ParsedCourse {
  parity: WeekParity;
}

/** 新版时间行：周一第1,2节{第1-16周}、{第2-14周|双周}、{第5-13周|单周} */
const TIME_LINE_RE =
  /周([一二三四五六日])第([\d,，]+)节\{第(\d+)[-~](\d+)周(?:\|(单周|双周))?\}/;

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
    return this.parseWithMeta(html).courses;
  }

  parseWithMeta(html: string): ParseResult {
    const $ = cheerio.load(html);
    const table = $('#Table1').first();
    const courses = table.length > 0 ? this.parseGrid($, table) : [];
    return {
      courses: this.mergeParity(courses),
      skippedUnscheduled: this.collectSkipped($),
    };
  }

  /** 表头格是否为星期标签（星期一/周一） */
  private isWeekdayHeader(text: string): boolean {
    return /^(星期|周)[一二三四五六日天]$/.test(text);
  }

  /** 行首节次标签：仅匹配 "第1节" / "第10节" 整格文本（阿拉伯数字） */
  private isPeriodRowLabel(text: string): boolean {
    return /^第\d+节$/.test(text) || /^第?\d+$/.test(text);
  }

  /** 时段标签格（上午/下午/晚上/早晨），出现在行首标签列 */
  private isPeriodGroupLabel(text: string): boolean {
    return /^(上午|下午|晚上|早晨|中午)$/.test(text);
  }

  /** 解析列号 → 星期；无星期表头时回退：课程首列 = 课程格最小列号，weekday = col - 首列 + 1 */
  private buildColWeekday(
    colWeekday: Map<number, number>,
    courseCells: { col: number }[],
  ): (col: number) => number | null {
    if (colWeekday.size > 0) {
      return (col) => colWeekday.get(col) ?? null;
    }
    if (courseCells.length === 0) return () => null;
    const first = Math.min(...courseCells.map((c) => c.col));
    return (col) => col - first + 1;
  }

  /**
   * 网格遍历：
   * - 含星期表头的行建立"列号 → 星期"映射（标签列数由表头自然给出，
   *   避免硬编码 1 列或 2 列在正方变体间错列）；
   * - 无星期表头的布局（如实验页面 Table1）回退到"课程区首列 = 课程格最小列号"；
   * - 数据行按 rowspan/colspan 展开网格，行首节次/时段标签识别出节次；
   * - 课程格用列映射取星期，节次由行标签 + 自身 rowspan 决定。
   */
  private parseGrid($: CheerioAPI, table: Cheerio<Element>): RawCourse[] {
    const results: RawCourse[] = [];
    const carry = new Map<number, number>();
    const colWeekday = new Map<number, number>();
    const WEEKDAY_SEQ = ['一', '二', '三', '四', '五', '六', '日'];

    for (const row of table.find('tr').toArray()) {
      const cells = $(row).find('td, th').toArray();
      let col = 0;
      let period: number | null = null;
      const courseCells: { cell: Element; col: number; rowspan: number }[] = [];
      const texts = cells.map((c) => this.cleanText($(c).text()));
      const weekdayHits = texts.filter((t) => this.isWeekdayHeader(t)).length;
      const isHeaderRow = weekdayHits >= 5;

      for (let idx = 0; idx < cells.length; idx++) {
        const cell = cells[idx];
        while ((carry.get(col) ?? 0) > 0) col++;
        const $cell = $(cell);
        const colspan = Number($cell.attr('colspan')) || 1;
        const rowspan = Number($cell.attr('rowspan')) || 1;
        const text = texts[idx];

        if (isHeaderRow) {
          const m = /^(?:星期|周)([一二三四五六日天])$/.exec(text);
          if (m) colWeekday.set(col, WEEKDAY_SEQ.indexOf(m[1]) + 1);
        } else if (period === null && this.isPeriodRowLabel(text)) {
          period = this.parsePeriodNumber(text);
        } else if (this.isPeriodGroupLabel(text)) {
          // 时段标签（上午/下午/晚上），本身不是节次，仅占标签列
        } else if (text) {
          courseCells.push({ cell, col, rowspan });
        }
        if (rowspan > 1) {
          for (let c = col; c < col + colspan; c++) carry.set(c, rowspan - 1);
        }
        col += colspan;
      }

      if (period !== null) {
        const weekdayOf = this.buildColWeekday(colWeekday, courseCells);
        for (const cc of courseCells) {
          const weekday = weekdayOf(cc.col);
          if (weekday === null || weekday < 1 || weekday > 7) continue;
          results.push(
            ...this.parseCell($, $(cc.cell), weekday, period, cc.rowspan),
          );
        }
      }
      for (const [c, left] of carry) {
        if (left <= 1) carry.delete(c);
        else carry.set(c, left - 1);
      }
    }
    return results;
  }

  private parsePeriodNumber(text: string): number | null {
    const m = /(\d+)/.exec(text);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  /** 解析单个课程格：旧版 TDContent 或新版 <br> 分段 */
  private parseCell(
    $: CheerioAPI,
    $cell: Cheerio<Element>,
    weekday: number,
    period: number,
    rowspan: number,
  ): RawCourse[] {
    const tdContents = $cell.find('.TDContent').toArray();
    if (tdContents.length > 0) {
      return tdContents
        .map((el) =>
          this.parseLegacySegment(this.cleanText($(el).text()), weekday, period),
        )
        .filter((c): c is RawCourse => c !== null);
    }
    const cellHtml = $cell.html();
    if (!cellHtml) return [];
    // 稀疏表格回退：单元格只有纯文本课程名（无 <br> 结构）时按名单课程处理
    if (!/<br\s*\/?>/i.test(cellHtml)) {
      const text = this.cleanText($cell.text());
      if (!text) return [];
      return [
        {
          name: text,
          weekday,
          startPeriod: period,
          endPeriod: period + rowspan - 1,
          parity: 'all',
          color: pickColor(text),
        },
      ];
    }
    return cellHtml
      .split(/<br\s*\/?>\s*<br\s*\/?>/i)
      .map((seg) => this.parseModernSegment(seg, weekday, period, rowspan))
      .filter((c): c is RawCourse => c !== null);
  }

  /** 旧版逗号分隔字段：名称,教师,周次,节次,地点 */
  private parseLegacySegment(
    seg: string,
    weekday: number,
    fallbackPeriod: number,
  ): RawCourse | null {
    const base = this.parseLegacyFields(seg, weekday, fallbackPeriod);
    if (!base) return null;
    return { ...base, parity: 'all' };
  }

  private parseLegacyFields(
    seg: string,
    weekday: number,
    fallbackPeriod: number,
  ): ParsedCourse | null {
    if (!seg) return null;
    const lines = this.splitCourseFields(seg);
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
      if (!course.teacher && /^[一-龥A-Za-z·]{2,10}$/.test(line)) {
        course.teacher = line;
        continue;
      }
      if (!course.location && /[一-龥].*\d|楼|室|号|栋|层/.test(line)) {
        course.location = line;
      }
    }
    if (!course.startPeriod) course.startPeriod = fallbackPeriod;
    if (!course.endPeriod) course.endPeriod = course.startPeriod;
    return course;
  }

  /** 新版分段：名称 / 类型 / 周X第a,b节{第m-n周[|单双周]} / 教师 / 地点 */
  private parseModernSegment(
    segHtml: string,
    weekday: number,
    fallbackPeriod: number,
    rowspan: number,
  ): RawCourse | null {
    const lines = segHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((line) => this.cleanText(line))
      .filter(Boolean);
    if (lines.length < 2) return null;
    const timeIndex = lines.findIndex((line) => TIME_LINE_RE.test(line));
    if (timeIndex === -1 || timeIndex === 0) {
      // 找不到时间行：调课标记（如 (调0154)）或格式未知的段。
      // 不能静默丢数据——warn 计数，供诊断时确认是否为误丢的合法课程。
      console.warn(
        `[zhengfang-parser] 跳过无法解析的课程段: ${lines[0].slice(0, 40)}`,
      );
      return null;
    }
    const tm = TIME_LINE_RE.exec(lines[timeIndex]);
    if (!tm) return null;
    const startWeek = Number.parseInt(tm[3], 10);
    const endWeek = Number.parseInt(tm[4], 10);
    // 节次是逗号列表（"1,2"/"9,10"），直接取最小/最大
    const periodNums = tm[2]
      .split(/[,，]/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    // 星期以表格列位置为准（结构性信息），时间行文本仅作字段定位
    const course: RawCourse = {
      name: lines[0],
      weekday,
      startWeek: Math.min(startWeek, endWeek),
      endWeek: Math.max(startWeek, endWeek),
      startPeriod: periodNums.length > 0 ? Math.min(...periodNums) : fallbackPeriod,
      endPeriod:
        periodNums.length > 0
          ? Math.max(...periodNums)
          : fallbackPeriod + rowspan - 1,
      parity: tm[5] === '单周' ? 'odd' : tm[5] === '双周' ? 'even' : 'all',
    };
    // 教师/地点为时间行之后的两个字段；双时段课程的第二段时间行不可当教师
    const rest = lines.slice(timeIndex + 1).filter((l) => !TIME_LINE_RE.test(l));
    if (rest[0]) course.teacher = rest[0];
    if (rest[1]) course.location = rest[1];
    course.color = pickColor(course.name ?? '');
    return course;
  }

  /**
   * 单双周合并：同槽位同名同周次的单周+双周对合并为一条全周课；
   * 孤立单双周保留完整周范围并在名称后标注（不静默写错误数据）。
   */
  private mergeParity(raw: RawCourse[]): ParsedCourse[] {
    const out: ParsedCourse[] = [];
    const used = new Set<number>();
    for (let i = 0; i < raw.length; i++) {
      if (used.has(i)) continue;
      const a = raw[i];
      const j = raw.findIndex(
        (b, k) =>
          k > i &&
          !used.has(k) &&
          this.isComplementaryPair(a, b),
      );
      if (j !== -1) {
        used.add(j);
        out.push(this.mergePair(a, raw[j]));
      } else {
        const course: ParsedCourse = { ...a };
        delete (course as Partial<RawCourse>).parity;
        if (a.parity === 'odd' && course.name) course.name += '（单周）';
        if (a.parity === 'even' && course.name) course.name += '（双周）';
        out.push(course);
      }
    }
    return out;
  }

  private isComplementaryPair(a: RawCourse, b: RawCourse): boolean {
    const parities = new Set([a.parity, b.parity]);
    return (
      parities.has('odd') &&
      parities.has('even') &&
      a.name === b.name &&
      a.teacher === b.teacher &&
      a.weekday === b.weekday &&
      a.startPeriod === b.startPeriod &&
      a.endPeriod === b.endPeriod &&
      a.startWeek === b.startWeek &&
      a.endWeek === b.endWeek
    );
  }

  private mergePair(a: RawCourse, b: RawCourse): ParsedCourse {
    const odd = a.parity === 'odd' ? a : b;
    const even = a.parity === 'even' ? a : b;
    const merged: ParsedCourse = { ...odd };
    delete (merged as Partial<RawCourse>).parity;
    if (odd.location && even.location && odd.location !== even.location) {
      merged.location = `${odd.location}（单周）/${even.location}（双周）`;
    }
    merged.location ??= even.location;
    return merged;
  }

  /** 课表下方"未安排上课时间"与"实践课"表：无时间信息，跳过但需提示 */
  private collectSkipped($: CheerioAPI): SkippedUnscheduledCourse[] {
    const skipped: SkippedUnscheduledCourse[] = [];
    $('#Datagrid2 tr').each((_i, row) => {
      const cells = $(row).find('td').toArray();
      if (cells.length < 4 || $(row).hasClass('datelisthead')) return;
      const name = this.cleanText($(cells[2]).text());
      if (!name) return;
      const teacher = this.cleanText($(cells[3]).text());
      skipped.push({ name, ...(teacher ? { teacher } : {}) });
    });
    $('#DataGrid1 tr').each((_i, row) => {
      const cells = $(row).find('td').toArray();
      if (cells.length < 2 || $(row).hasClass('datelisthead')) return;
      const time = cells.length > 4 ? this.cleanText($(cells[4]).text()) : '';
      if (time) return;
      const name = this.cleanText($(cells[0]).text());
      if (!name) return;
      const teacher = this.cleanText($(cells[1]).text());
      skipped.push({ name, ...(teacher ? { teacher } : {}) });
    });
    return skipped;
  }
}
