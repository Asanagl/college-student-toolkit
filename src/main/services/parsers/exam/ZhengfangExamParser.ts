// 正方教务系统考试页面解析器
// 特征：#Table1 或 data table，含"考试"/"课程名"表头列
// 表头常见列：课程名 / 考试日期 / 考试时间 / 考试地点 / 座位号 / 备注
// 单元格内可能含 <br> 分隔的多行信息
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { ExamParserBase } from './ExamParserBase';
import type { ParsedExam } from './types';

// 表头关键词到 ParsedExam 字段的映射，用于按列名定位
const HEADER_PATTERNS: Array<{ field: keyof ParsedExam; keywords: string[] }> = [
  { field: 'courseName', keywords: ['课程名', '课程', '考试科目', '科目'] },
  { field: 'date', keywords: ['考试日期', '日期', '考试时间'] },
  { field: 'startTime', keywords: ['考试时间', '时间'] },
  { field: 'location', keywords: ['考试地点', '地点', '考场'] },
  { field: 'seat', keywords: ['座位号', '座位', '座号'] },
  { field: 'notes', keywords: ['备注', '说明'] },
];

export class ZhengfangExamParser extends ExamParserBase {
  get name(): string {
    return 'zhengfang-exam';
  }

  detect(html: string): boolean {
    const $ = cheerio.load(html);
    // 正方特征：#Table1 或含"考试安排"/"考试"标题的表格
    if ($('#Table1').length > 0 && /考试|科目|考场/.test($('body').text() || '')) {
      return true;
    }
    const title = $('title').text() || '';
    if (/正方|教务|考试安排|考试/.test(title)) {
      return $('table').length > 0 && /考试|科目|考场/.test($('body').text() || '');
    }
    return false;
  }

  parse(html: string): ParsedExam[] {
    const $ = cheerio.load(html);
    const results: ParsedExam[] = [];
    // 优先正方 #Table1，否则取第一个含"考试"/"课程"表头的 table
    let table = $('#Table1').first();
    if (table.length === 0) {
      table = $('table').filter((_, el) => /考试|课程名|科目/.test($(el).text() || '')).first();
    }
    if (table.length === 0) return results;

    const headerMap = this.buildHeaderMap($, table);
    const rows = table.find('tr').toArray();
    for (const row of rows) {
      const cells = $(row).find('td').toArray();
      if (cells.length === 0) continue;
      // 跳过表头行（含 th 或第一个单元格是"课程名"等）
      if ($(row).find('th').length > 0) continue;
      const exam = this.parseRow($, cells, headerMap);
      if (exam && exam.courseName) results.push(exam);
    }
    return results;
  }

  /**
   * 根据表头单元格文本构建"列索引 → 字段名"映射
   * 多个字段命中同一列时（如"考试时间"既含日期又含时间），由 parseRow 内部进一步拆分
   */
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

  /** 解析一行数据为 ParsedExam */
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
    // 若表头未识别，回退到启发式：按列内容推测
    if (!exam.courseName && cells.length > 0) {
      this.heuristicFill(exam, cells, $);
    }
    return exam.courseName ? exam : null;
  }

  /** 将单元格文本赋值到对应字段，时间列尝试拆分为 start/end */
  private assignField(exam: ParsedExam, field: keyof ParsedExam, text: string): void {
    if (field === 'date') {
      const date = this.parseDate(text);
      if (date) exam.date = date;
      // "考试时间"列可能同时含日期与时间，尝试提取时间
      const timeRange = this.parseTimeRange(text);
      if (timeRange) {
        exam.startTime = timeRange[0];
        exam.endTime = timeRange[1];
      }
    } else if (field === 'startTime') {
      // "考试时间"列可能为 "2026-01-05 09:00-11:00" 形式
      const date = this.parseDate(text);
      if (date) exam.date = date;
      const timeRange = this.parseTimeRange(text);
      if (timeRange) {
        exam.startTime = timeRange[0];
        exam.endTime = timeRange[1];
      }
    } else if (field === 'seat') {
      const seat = this.parseSeat(text) ?? text;
      exam.seat = seat;
    } else if (field === 'courseName') {
      exam.courseName = text;
    } else if (field === 'location') {
      exam.location = text;
    } else if (field === 'notes') {
      exam.notes = text;
    }
  }

  /** 表头识别失败时的启发式填充：按列内容推测字段 */
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
      if (!exam.seat) {
        const seat = this.parseSeat(text);
        if (seat) {
          exam.seat = seat;
          continue;
        }
      }
      if (!exam.location && /楼|室|号|栋|层/.test(text) && !exam.courseName) {
        exam.location = text;
      }
    }
  }
}
