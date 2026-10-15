// 远程页面 DOM 提取的文档选择。
// 背景：正方等教务系统把课表渲染在 iframe 内层（如 name="zhuti"），顶层文档只有
// 导航外壳，只取顶层 outerHTML 会导致解析器零命中（真实系统实测复现）。
// pickBestDocumentHtml 会被 toString() 后注入远程页面执行，因此必须完全自包含：
// 不得引用模块作用域的常量、类型工具或任何依赖，否则远程执行时 ReferenceError。

/** 结构化最小 DOM 类型：主进程 tsconfig 无 DOM lib，且注入端只需要这些成员。 */
export interface DocumentLike {
  documentElement: { outerHTML: string } | null;
  body?: { innerText?: unknown; textContent?: unknown } | null;
  querySelectorAll(selectors: string): ArrayLike<unknown>;
}

interface FrameElementLike {
  contentDocument: DocumentLike | null;
}

/**
 * 在顶层文档与同源 iframe 文档中选择"最像课表页"的文档，返回其 outerHTML。
 * 选择规则：单表单元格数最多 + 课表特征关键词加分；严格大于才替换，
 * 因此平分或无 iframe 时保持顶层文档（与改造前行为一致）。
 */
export function pickBestDocumentHtml(rootDocument: DocumentLike): string {
  const MAX_DEPTH = 3;
  const KEYWORDS = ["课表", "课程", "星期", "节次", "考试"];

  function bodyText(doc: DocumentLike): string {
    const body = doc.body;
    if (!body) return "";
    const raw =
      typeof body.innerText === "string"
        ? body.innerText
        : typeof body.textContent === "string"
          ? body.textContent
          : "";
    return (raw as string).slice(0, 4000);
  }

  // 评分以"单表最大单元格数"而非全文档 td/th 总数：
  // 课表页用脚本克隆一份课表做侧边栏（两张同 ID 表格），全文档计数会把克隆副本
  // 算进去，导致外层包装页分数虚高、误选到非课表文档（真实多层嵌套实测复现）。
  function score(doc: DocumentLike): number {
    let bestCell = 0;
    const tables = doc.querySelectorAll("table");
    for (let i = 0; i < tables.length; i++) {
      const tds = (
        tables[i] as { querySelectorAll(sel: string): ArrayLike<unknown> }
      ).querySelectorAll("td,th");
      if (tds.length > bestCell) bestCell = tds.length;
    }
    let s = bestCell;
    const text = bodyText(doc);
    for (let i = 0; i < KEYWORDS.length; i++) {
      if (text.indexOf(KEYWORDS[i]) !== -1) s += 50;
    }
    return s;
  }

  let best: DocumentLike = rootDocument;
  let bestScore = score(rootDocument);

  function visit(doc: DocumentLike, depth: number): void {
    if (depth >= MAX_DEPTH) return;
    // 老式教务系统可能用 frameset 的 <frame> 而非 <iframe>，两者同样暴露 contentDocument
    const frames = doc.querySelectorAll("iframe,frame");
    for (let i = 0; i < frames.length; i++) {
      let child: DocumentLike | null = null;
      try {
        child = (frames[i] as FrameElementLike).contentDocument;
      } catch {
        // 跨源 iframe 受同源策略保护，访问即抛错，直接跳过
        child = null;
      }
      if (!child || !child.documentElement) continue;
      const s = score(child);
      if (s > bestScore) {
        bestScore = s;
        best = child;
      }
      visit(child, depth + 1);
    }
  }

  visit(rootDocument, 0);
  return best.documentElement ? best.documentElement.outerHTML : "";
}
