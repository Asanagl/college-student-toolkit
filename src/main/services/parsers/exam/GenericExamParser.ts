// 通用考试表格解析器：作为兜底，检测含"考试"/"课程"表头的 table 并按列解析。
// 与 ZhengfangExamParser 共用 ExamParserBase 的日期/时间/座位工具，但不依赖 #Table1 特征。
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { ExamParserBase } from './ExamParserBase';
import type { ParsedExam } from './types';

// 表头关键词到字段的映射
const HEADER_PATTERNS: Array<{ field: keyof ParsedExam; keywords: string[] }> = [
  { field: 'courseName', keywords: ['课程名', '课程', '考试科目', '科目', '名称'] },
  { field: 'date', keywords: ['考试日期', '日期', '考试时间'] },
  { field: 'startTime', keywords: ['考试时间', '时间', '起止'] },
  { field: 'location', keywords: ['考试地点', '地点', '考场', '教室'] },
  { field: 'seat', keywords: ['座位号', '座位', '座号'] },
  { field: 'notes', keywords: ['备注', '说明'] },
];

export class GenericExamParser extends ExamParserBase {
  get name(): string {
    return 'generic-exam';
  }

  detect(html: string): boolean {
    const $ = cheerio.load(html);
    const tables = $('table').toArray();
    // 含"考试"/"科目"表头且列数 >= 3 的 table 视为考试表
    return tables.some((t) => {
      const headerText = $(t).find('tr').first().text() || '';
      return /考试|科目|考场/.test(headerText) && $(t).find('tr').first().find('td, th').length >= 3;
    });
  }

  parse(html: string): ParsedExam[] {
    const $ = cheerio.load(html);
    const results: ParsedExam[] = [];
    // 找含"考试"/"科目"/"课程名"表头的第一个 table
    const tables = $('table').toArray();
    const target = tables.find((t) => {
      const headerText = $(t).find('tr').first().text() || '';
      return /考试|科目|课程名/.test(headerText);
    });
    if (!target) return results;

    const headerMap = this.buildHeaderMap($, $(target));
    const rows = $(target).find('tr').toArray();
    for (const row of rows) {
      const cells = $(row).find('td').toArray();
      if (cells.length === 0) continue;
      if ($(row).find('th').length > 0) continue;
      const exam = this.parseRow($, cells, headerMap);
      if (exam && exam.courseName) results.push(exam);
    }
    return results;
  }

  /** 构建列索引到字段的映射 */
  private buildHeaderMap($: CheerioAPI, table: ReturnType<CheerioAPI>): Map<number, keyof ParsedExam> {
    const headerCells = table.find('tr').first().find('th, td').toArray();
    const map = new Map<number, keyof ParsedExam>();
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
    headerMap: Map<number, keyof ParsedExam>
  ): ParsedExam | null {
    const exam: ParsedExam = {};
    cells.forEach((cell, idx) => {
      const field = headerMap.get(idx);
      if (!field) return;
      const text = this.cleanText($(cell).text());
      if (!text) return;
      this.assignField(exam, field, text);
    });
    // 表头未识别时回退启发式
    if (!exam.courseName) {
      this.heuristicFill(exam, cells, $);
    }
    return exam.courseName ? exam : null;
  }

  /** 赋值字段，时间列尝试拆分日期与时间 */
  private assignField(exam: ParsedExam, field: keyof ParsedExam, text: string): void {
    if (field === 'date') {
      const date = this.parseDate(text);
      if (date) exam.date = date;
      const timeRange = this.parseTimeRange(text);
      if (timeRange) {
        exam.startTime = timeRange[0];
        exam.endTime = timeRange[1];
      }
    } else if (field === 'startTime') {
      const date = this.parseDate(text);
      if (date) exam.date = date;
      const timeRange = this.parseTimeRange(text);
      if (timeRange) {
        exam.startTime = timeRange[0];
        exam.endTime = timeRange[1];
      }
    } else if (field === 'seat') {
      exam.seat = this.parseSeat(text) ?? text;
    } else if (field === 'courseName') {
      exam.courseName = text;
    } else if (field === 'location') {
      exam.location = text;
    } else if (field === 'notes') {
      exam.notes = text;
    }
  }

  /** 启发式填充：按列内容推测字段 */
  private heuristicFill(exam: ParsedExam, cells: AnyNode[], $: CheerioAPI): void {
    for (const cell of cells) {
      const text = this.cleanText($(cell).text());
      if (!text) continue;
      if (!exam.courseName && /^[\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,30}$/.test(text) && !/\d{4}[-年/.]/.test(text)) {
        exam.courseName = text;
        continue;
      }
      if (!exam.date) {
        const date = this.parseDate(text);
        if (date) {
          exam.date = date;
          const timeRange = this.parseTimeRange(text);
          if (timeRange && !exam.startTime) {
            exam.startTime = timeRange[0];
            exam.endTime = timeRange[1];
          }
          continue;
        }
      }
      if (!exam.startTime) {
        const timeRange = this.parseTimeRange(text);
        if (timeRange) {
          exam.startTime = timeRange[0];
          exam.endTime = timeRange[1];
          continue;
        }
      }
      if (!exam.location && /楼|室|号|栋|层|场/.test(text)) {
        exam.location = text;
      }
    }
  }
}
