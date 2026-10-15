// domExtraction 单元测试：iframe 内层文档选择、跨源跳过、深度限制与注入自包含性。
import { afterEach, describe, expect, it } from "vitest";
import {
  pickBestDocumentHtml,
  type DocumentLike,
} from "../../src/main/services/domExtraction";

afterEach(() => {
  document.body.innerHTML = "";
});

const NAV_SHELL = "<div>导航菜单</div>";
const TIMETABLE_BODY =
  "<table><tr><th>星期</th><th>课表</th></tr>" +
  "<tr><td>高等数学</td><td>1-2节</td></tr>".repeat(20) +
  "</table>";

function setRoot(html: string): void {
  document.body.innerHTML = html;
}

/** 在父文档 body 末尾追加一个 iframe 并写入指定 HTML，返回 iframe 元素。 */
function addFrame(parent: Document, html: string): HTMLIFrameElement {
  const frame = parent.createElement("iframe");
  parent.body.appendChild(frame);
  const child = frame.contentDocument;
  if (!child) throw new Error("jsdom 未提供 contentDocument");
  child.open();
  child.write(`<html><head></head><body>${html}</body></html>`);
  child.close();
  return frame;
}

describe("pickBestDocumentHtml", () => {
  it("内层 iframe 含课表时选中 iframe 文档", () => {
    setRoot(NAV_SHELL);
    addFrame(document, TIMETABLE_BODY);
    const html = pickBestDocumentHtml(document as unknown as DocumentLike);
    expect(html).toContain("高等数学");
    expect(html).not.toContain("导航菜单");
  });

  it("iframe 没有更像课表的内容时回退顶层文档", () => {
    setRoot(TIMETABLE_BODY);
    addFrame(document, "<div>空白</div>");
    const html = pickBestDocumentHtml(document as unknown as DocumentLike);
    expect(html).toContain("高等数学");
  });

  it("跨源 iframe 访问抛错时跳过且不中断提取", () => {
    setRoot(TIMETABLE_BODY);
    const frame = addFrame(document, "<div>占位</div>");
    Object.defineProperty(frame, "contentDocument", {
      get() {
        throw new Error(
          "Blocked a frame with origin from accessing a cross-origin frame.",
        );
      },
    });
    expect(() =>
      pickBestDocumentHtml(document as unknown as DocumentLike),
    ).not.toThrow();
    expect(pickBestDocumentHtml(document as unknown as DocumentLike)).toContain(
      "高等数学",
    );
  });

  it("老式 frameset 的 <frame> 同样下钻", () => {
    setRoot(NAV_SHELL);
    const frame = document.createElement("frame");
    document.body.appendChild(frame);
    const child = frame.contentDocument;
    if (!child) throw new Error("jsdom 未提供 frame.contentDocument");
    child.open();
    child.write(`<html><head></head><body>${TIMETABLE_BODY}</body></html>`);
    child.close();
    const html = pickBestDocumentHtml(document as unknown as DocumentLike);
    expect(html).toContain("高等数学");
  });

  it("嵌套两层 iframe 时命中深层课表文档", () => {
    setRoot(NAV_SHELL);
    const f1 = addFrame(document, NAV_SHELL).contentDocument as Document;
    addFrame(f1, TIMETABLE_BODY);
    const html = pickBestDocumentHtml(document as unknown as DocumentLike);
    expect(html).toContain("高等数学");
  });

  it("超过深度限制的更深层文档不再下钻", () => {
    setRoot(NAV_SHELL);
    const f1 = addFrame(document, NAV_SHELL).contentDocument as Document;
    const f2 = addFrame(f1, NAV_SHELL).contentDocument as Document;
    const f3 = addFrame(f2, "<table><tr><td>中等规模</td></tr></table>")
      .contentDocument as Document;
    // 第 4 层文档含最大表格，但超出深度限制，不应被选中
    addFrame(f3, TIMETABLE_BODY);
    const html = pickBestDocumentHtml(document as unknown as DocumentLike);
    expect(html).toContain("中等规模");
    expect(html).not.toContain("高等数学");
  });

  it("空文档不抛异常并返回顶层 outerHTML", () => {
    setRoot("");
    expect(() =>
      pickBestDocumentHtml(document as unknown as DocumentLike),
    ).not.toThrow();
  });

  it("多层嵌套且内层含克隆表格时仍选中真正的课表文档", () => {
    // 正方课表页用脚本克隆 #Table1 做侧边栏（两张同 ID 表格），
    // 全文档 td/th 计数会把克隆算进去，单表最大单元格数才能区分
    const inner = document.implementation.createHTMLDocument("");
    inner.documentElement.innerHTML = `<head></head><body>
      <table id="Table1"><tr><td>第1节</td><td>线性代数 必修 周一第1,2节{第1-16周}</td></tr></table>
      <table id="Table1"><tr><td>第1节</td><td>线性代数 必修 周一第1,2节{第1-16周}</td></tr></table>
    </body>`;
    const wrapper = document.implementation.createHTMLDocument("");
    wrapper.documentElement.innerHTML =
      "<head></head><body><div>导航</div></body>";
    const f1 = wrapper.createElement("iframe");
    wrapper.body.appendChild(f1);
    Object.defineProperty(f1, "contentDocument", { value: inner });
    const shell = document.implementation.createHTMLDocument("");
    shell.documentElement.innerHTML =
      "<head></head><body><div>外壳</div></body>";
    const f2 = shell.createElement("iframe");
    shell.body.appendChild(f2);
    Object.defineProperty(f2, "contentDocument", { value: wrapper });
    const html = pickBestDocumentHtml(shell as unknown as DocumentLike);
    expect(html).toContain("线性代数");
  });

  it("序列化注入后无模块作用域也能独立运行", () => {
    setRoot(NAV_SHELL);
    addFrame(document, TIMETABLE_BODY);
    // 模拟 executeJavaScript：拼接后的代码里不存在 pickBestDocumentHtml 标识符
    const injected = `(${pickBestDocumentHtml.toString()})(document)`;
    const run = new Function(
      "document",
      `return eval(${JSON.stringify(injected)})`,
    );
    const html = run(document) as string;
    expect(html).toContain("高等数学");
  });
});
