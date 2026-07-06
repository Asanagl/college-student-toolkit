// 正方教务系统实验页面解析器
// 特征：#Table1 或 data table，含"实验"/"实验名称"表头列
// 表头常见列：实验名 / 实验日期 / 实验时间 / 实验地点 / 指导教师 / 备注
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { LabParserBase } from './LabParserBase';
import type { ParsedLab } from './types';

// 表头关键词到字段的映射
const HEADER_PATTERNS: Array<{ field: keyof ParsedLab; keywords: string[] }> = [
  { field: 'name', keywords: ['实验名', '实验名称', '名称', '项目'] },
  { field: 'date', keywords: ['实验日期', '日期', '实验时间', '安排时间'] },
  { field: 'startTime', keywords: ['实验时间', '时间', '起止'] },
  { field: 'location', keywords: ['实验地点', '地点', '实验室', '教室'] },
  { field: 'instructor', keywords: ['指导教师', '教师', '老师'] },
  { field: 'notes', keywords: ['备注', '说明', '注意'] },
];

export class ZhengfangLabParser extends LabParserBase {
  get name(): string {
    return 'zhengfang-lab';
  }

  detect(html: string): boolean {
    const $ = cheerio.load(html);
    // 正方特征：#Table1 且页面含"实验"关键词
    if ($('#Table1').length > 0 && /实验/.test($('body').text() || '')) {
      return true;
    }
    const title = $('title').text() || '';
    if (/正方|教务|实验安排|实验/.test(title)) {
      return $('table').length > 0 && /实验/.test($('body').text() || '');
    }
    return false;
  }

  parse(html: string): ParsedLab[] {
    const $ = cheerio.load(html);
    const results: ParsedLab[] = [];
    let table = $('#Table1').first();
    if (table.length === 0) {
      table = $('table').filter((_, el) => /实验名|实验安排|实验日期/.test($(el).text() || '')).first();
    }
    if (table.length === 0) return results;

    const headerMap = this.buildHeaderMap($, table);
    const rows = table.find('tr').toArray();
    for (const row of rows) {
      const cells = $(row).find('td').toArray();
      if (cells.length === 0) continue;
      if ($(row).find('th').length > 0) continue;
      const lab = this.parseRow($, cells, headerMap);
      if (lab && lab.name) results.push(lab);
    }
    return results;
  }

  /** 构建列索引到字段的映射 */
  private buildHeaderMap($: CheerioAPI, table: ReturnType<CheerioAPI>): Map<number, keyof ParsedLab> {
    const headerCells = table.find('tr').first().find('th, td').toArray();
    const map = new Map<number, keyof ParsedLab>();
    headerCells.forEach((cell, idx) => {
      const text = this.cleanText($(cell).text());
      for (const { field, keywords } of HEADER_PATTERNS) {
        if (keywords.some((kw) => text.includes(kw))) {
          map.set(idx, field);
          break;
        }
      }
    });
    return map;
  }

  /** 解析一行数据 */
  private parseRow(
    $: CheerioAPI,
    cells: AnyNode[],
    headerMap: Map<number, keyof ParsedLab>
  ): ParsedLab | null {
    const lab: ParsedLab = {};
    cells.forEach((cell, idx) => {
      const field = headerMap.get(idx);
      if (!field) return;
      const text = this.cleanText($(cell).text());
      if (!text) return;
      this.assignField(lab, field, text);
    });
    if (!lab.name) {
      this.heuristicFill(lab, cells, $);
    }
    return lab.name ? lab : null;
  }

  /** 赋值字段，时间列尝试拆分日期与时间 */
  private assignField(lab: ParsedLab, field: keyof ParsedLab, text: string): void {
    if (field === 'date') {
      const date = this.parseDate(text);
      if (date) lab.date = date;
      const timeRange = this.parseTimeRange(text);
      if (timeRange) {
        lab.startTime = timeRange[0];
        lab.endTime = timeRange[1];
      }
    } else if (field === 'startTime') {
      const date = this.parseDate(text);
      if (date) lab.date = date;
      const timeRange = this.parseTimeRange(text);
      if (timeRange) {
        lab.startTime = timeRange[0];
        lab.endTime = timeRange[1];
      }
    } else if (field === 'name') {
      lab.name = text;
    } else if (field === 'location') {
      lab.location = text;
    } else if (field === 'instructor') {
      lab.instructor = text;
    } else if (field === 'notes') {
      lab.notes = text;
    }
  }

  /** 启发式填充 */
  private heuristicFill(lab: ParsedLab, cells: AnyNode[], $: CheerioAPI): void {
    for (const cell of cells) {
      const text = this.cleanText($(cell).text());
      if (!text) continue;
      if (!lab.name && /^[\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,40}$/.test(text) && !/\d{4}[-年/.]/.test(text)) {
        lab.name = text;
        continue;
      }
      if (!lab.date) {
        const date = this.parseDate(text);
        if (date) {
          lab.date = date;
          const timeRange = this.parseTimeRange(text);
          if (timeRange && !lab.startTime) {
            lab.startTime = timeRange[0];
            lab.endTime = timeRange[1];
          }
          continue;
        }
      }
      if (!lab.startTime) {
        const timeRange = this.parseTimeRange(text);
        if (timeRange) {
          lab.startTime = timeRange[0];
          lab.endTime = timeRange[1];
          continue;
        }
      }
      if (!lab.instructor && /^[\u4e00-\u9fa5A-Za-z·]{2,10}$/.test(text) && !lab.name) {
        lab.instructor = text;
        continue;
      }
      if (!lab.location && /楼|室|号|栋|层|场|实验室/.test(text)) {
        lab.location = text;
      }
    }
  }
}
