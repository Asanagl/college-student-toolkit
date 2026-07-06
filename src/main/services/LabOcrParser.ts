// 实验 OCR 解析器：将 OCR 识别的纯文本解析为 ParsedLab 列表。
// 策略：按行分割，每行尝试匹配实验名/日期/时间/地点/教师。
import type { ParsedLab } from './parsers/lab/types';

/**
 * 解析 OCR 文本为实验列表。
 * 支持单行包含完整信息与多行块两种常见排版。
 */
export function parseOcrToLabs(text: string): ParsedLab[] {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const results: ParsedLab[] = [];
  let current: ParsedLab | null = null;

  for (const line of lines) {
    const lab = parseLabLine(line);
    if (lab && lab.name) {
      if (current) results.push(current);
      current = lab;
    } else if (current) {
      mergeLabInfo(current, line);
    }
  }
  if (current && current.name) results.push(current);
  return results;
}

/** 解析单行为实验信息 */
function parseLabLine(line: string): ParsedLab | null {
  if (line.length < 2) return null;
  const lab: ParsedLab = {};
  // 实验名：行首非数字的中英文片段
  const nameMatch = /^[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()·\-]{1,40}/.exec(line);
  if (nameMatch) {
    lab.name = nameMatch[0].trim();
  }
  // 日期
  const dateMatch = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(line);
  if (dateMatch) {
    lab.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
  }
  // 时间段
  const timeMatch = /(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})/.exec(line);
  if (timeMatch) {
    lab.startTime = timeMatch[1].padStart(5, '0');
    lab.endTime = timeMatch[2].padStart(5, '0');
  }
  // 教师：含"教师:"/"老师:"前缀
  const teacherMatch = /(?:指导教师|教师|老师)[:：]?\s*([\u4e00-\u9fa5A-Za-z·]{2,10})/.exec(line);
  if (teacherMatch) {
    lab.instructor = teacherMatch[1];
  }
  // 地点
  const locMatch = /[\u4e00-\u9fa5A-Za-z0-9]{2,}(?:楼|室|号|栋|层|场|实验室)[\u4e00-\u9fa5A-Za-z0-9]*/.exec(line);
  if (locMatch) {
    lab.location = locMatch[0];
  }
  return lab.name ? lab : null;
}

/** 将补充信息合并到已有实验对象 */
function mergeLabInfo(lab: ParsedLab, line: string): void {
  if (!lab.date) {
    const dateMatch = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(line);
    if (dateMatch) {
      lab.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    }
  }
  if (!lab.startTime) {
    const timeMatch = /(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})/.exec(line);
    if (timeMatch) {
      lab.startTime = timeMatch[1].padStart(5, '0');
      lab.endTime = timeMatch[2].padStart(5, '0');
    }
  }
  if (!lab.instructor) {
    const teacherMatch = /(?:指导教师|教师|老师)[:：]?\s*([\u4e00-\u9fa5A-Za-z·]{2,10})/.exec(line);
    if (teacherMatch) lab.instructor = teacherMatch[1];
  }
  if (!lab.location) {
    const locMatch = /[\u4e00-\u9fa5A-Za-z0-9]{2,}(?:楼|室|号|栋|层|场|实验室)[\u4e00-\u9fa5A-Za-z0-9]*/.exec(line);
    if (locMatch) lab.location = locMatch[0];
  }
}
