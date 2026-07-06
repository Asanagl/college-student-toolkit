// 考试解析器内部类型：与 shared/ParsedExam 一致，独立定义避免循环依赖
// 字段全部可选，便于不同解析器按能力填充（部分教务系统不暴露座位/备注）
export interface ParsedExam {
  courseName?: string;
  /** YYYY-MM-DD */
  date?: string;
  /** HH:mm */
  startTime?: string;
  /** HH:mm */
  endTime?: string;
  location?: string;
  seat?: string;
  notes?: string;
}

/** 考试解析器抽象接口 */
export interface ExamParser {
  /** 解析器名称，用于日志与调试 */
  name: string;
  /** 检测 HTML 是否匹配本解析器（基于特征选择器或标题） */
  detect(html: string): boolean;
  /** 解析 HTML 为考试列表 */
  parse(html: string): ParsedExam[];
}
