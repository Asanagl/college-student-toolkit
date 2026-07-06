// 考试 OCR 解析器：将 OCR 识别的纯文本解析为 ParsedExam 列表。
// 策略：按行分割，每行尝试匹配课程名/日期/时间/地点/座位。
// OCR 噪声大，仅提取能匹配的字段，其余留空。
import type { ParsedExam } from './parsers/exam/types';

/**
 * 解析 OCR 文本为考试列表。
 * 支持单行包含完整信息（"高等数学 2026-01-05 09:00-11:00 教学楼A101 座位:5"）
 * 与多行块（课程名一行、详细信息下一行）两种常见排版。
 */
export function parseOcrToExams(text: string): ParsedExam[] {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const results: ParsedExam[] = [];
  let current: ParsedExam | null = null;

  for (const line of lines) {
    const exam = parseExamLine(line);
    if (exam && exam.courseName) {
      // 新考试行：提交前一条并开始新块
      if (current) results.push(current);
      current = exam;
    } else if (current) {
      // 补充信息行：合并到当前考试
      mergeExamInfo(current, line);
    }
  }
  if (current && current.courseName) results.push(current);
  return results;
}

/** 解析单行为考试信息，无课程名则返回 null */
function parseExamLine(line: string): ParsedExam | null {
  if (line.length < 2) return null;
  const exam: ParsedExam = {};
  // 课程名：行首非数字的中英文片段
  const nameMatch = /^[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()·\-]{1,30}/.exec(line);
  if (nameMatch) {
    exam.courseName = nameMatch[0].trim();
  }
  // 日期
  const dateMatch = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(line);
  if (dateMatch) {
    exam.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
  }
  // 时间段
  const timeMatch = /(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})/.exec(line);
  if (timeMatch) {
    exam.startTime = timeMatch[1].padStart(5, '0');
    exam.endTime = timeMatch[2].padStart(5, '0');
  }
  // 座位
  const seatMatch = /(?:座位号|座位|座号)[:：]?\s*([A-Za-z0-9\-]{1,10})/.exec(line);
  if (seatMatch) {
    exam.seat = seatMatch[1];
  }
  // 地点：含楼/室/号等关键字
  const locMatch = /[\u4e00-\u9fa5A-Za-z0-9]{2,}(?:楼|室|号|栋|层|场)[\u4e00-\u9fa5A-Za-z0-9]*/.exec(line);
  if (locMatch) {
    exam.location = locMatch[0];
  }
  return exam.courseName ? exam : null;
}

/** 将补充信息合并到已有考试对象 */
function mergeExamInfo(exam: ParsedExam, line: string): void {
  if (!exam.date) {
    const dateMatch = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(line);
    if (dateMatch) {
      exam.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    }
  }
  if (!exam.startTime) {
    const timeMatch = /(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})/.exec(line);
    if (timeMatch) {
      exam.startTime = timeMatch[1].padStart(5, '0');
      exam.endTime = timeMatch[2].padStart(5, '0');
    }
  }
  if (!exam.seat) {
    const seatMatch = /(?:座位号|座位|座号)[:：]?\s*([A-Za-z0-9\-]{1,10})/.exec(line);
    if (seatMatch) exam.seat = seatMatch[1];
  }
  if (!exam.location) {
    const locMatch = /[\u4e00-\u9fa5A-Za-z0-9]{2,}(?:楼|室|号|栋|层|场)[\u4e00-\u9fa5A-Za-z0-9]*/.exec(line);
    if (locMatch) exam.location = locMatch[0];
  }
}
