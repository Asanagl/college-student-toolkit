// 考试解析器入口：遍历所有考试解析器，用 detect 选择匹配的，无匹配则尝试通用 table 解析。
import { GenericExamParser } from './GenericExamParser';
import { ZhengfangExamParser } from './ZhengfangExamParser';
import type { ParsedExam } from './types';

import { ExamParserBase } from './ExamParserBase';
export type { ParsedExam, ExamParser } from './types';
export { ExamParserBase };

const EXAM_PARSERS: ExamParserBase[] = [
  new ZhengfangExamParser(),
];

/**
 * 用所有注册的考试解析器解析 HTML，返回考试列表。
 * 优先用 detect 命中的专用解析器，全部未命中时回退到 GenericExamParser。
 */
export function parseDomForExams(html: string): ParsedExam[] {
  if (!html) return [];
  for (const parser of EXAM_PARSERS) {
    try {
      if (parser.detect(html)) {
        const result = parser.parse(html);
        if (result.length > 0) return result;
      }
    } catch (err) {
      // 单个解析器失败不影响其他解析器尝试
      console.error(`[exam-parsers] ${parser.name} 解析失败: ${(err as Error).message}`);
    }
  }
  // 兜底：通用 table 解析
  try {
    const generic = new GenericExamParser();
    if (generic.detect(html)) return generic.parse(html);
  } catch (err) {
    console.error(`[exam-parsers] 通用解析失败: ${(err as Error).message}`);
  }
  return [];
}
