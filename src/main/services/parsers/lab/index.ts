// 实验解析器入口：遍历所有实验解析器，用 detect 选择匹配的，无匹配则尝试通用 table 解析。
import { GenericLabParser } from './GenericLabParser';
import { ZhengfangLabParser } from './ZhengfangLabParser';
import type { ParsedLab } from './types';

import { LabParserBase } from './LabParserBase';
export type { ParsedLab, LabParser } from './types';
export { LabParserBase };

const LAB_PARSERS: LabParserBase[] = [
  new ZhengfangLabParser(),
];

/**
 * 用所有注册的实验解析器解析 HTML，返回实验列表。
 * 优先用 detect 命中的专用解析器，全部未命中时回退到 GenericLabParser。
 */
export function parseDomForLabs(html: string): ParsedLab[] {
  if (!html) return [];
  for (const parser of LAB_PARSERS) {
    try {
      if (parser.detect(html)) {
        const result = parser.parse(html);
        if (result.length > 0) return result;
      }
    } catch (err) {
      console.error(`[lab-parsers] ${parser.name} 解析失败: ${(err as Error).message}`);
    }
  }
  try {
    const generic = new GenericLabParser();
    if (generic.detect(html)) return generic.parse(html);
  } catch (err) {
    console.error(`[lab-parsers] 通用解析失败: ${(err as Error).message}`);
  }
  return [];
}
