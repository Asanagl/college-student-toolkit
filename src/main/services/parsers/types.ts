// 解析器内部类型：与 shared/ParsedCourse 一致，独立定义避免循环依赖
// 字段全部可选，便于不同解析器按能力填充（部分教务系统不暴露教师/地点）
export interface ParsedCourse {
  name?: string;
  teacher?: string;
  location?: string;
  startWeek?: number;
  endWeek?: number;
  weekday?: number; // 1-7
  startPeriod?: number;
  endPeriod?: number;
  color?: string;
}

/** 课表下方"未安排上课时间"的课程：无法进入周课表，跳过导入但需提示用户 */
export interface SkippedUnscheduledCourse {
  name: string;
  teacher?: string;
}

/** 解析结果：课程列表 + 因无时间安排被跳过的课程（供导入流程提示手动补录） */
export interface ParseResult {
  courses: ParsedCourse[];
  skippedUnscheduled: SkippedUnscheduledCourse[];
}

/** 教务系统解析器抽象接口 */
export interface Parser {
  /** 解析器名称，用于日志与调试 */
  name: string;
  /** 检测 HTML 是否匹配本解析器（基于特征选择器或标题） */
  detect(html: string): boolean;
  /** 解析 HTML 为课程列表 */
  parse(html: string): ParsedCourse[];
}
