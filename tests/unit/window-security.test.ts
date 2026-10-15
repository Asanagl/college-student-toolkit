import { describe, expect, it } from "vitest";
import { isTrustedApplicationUrl } from "../../src/main/services/WindowService";

describe("主窗口导航边界", () => {
  const entry = "C:\\app\\dist\\index.html";

  it("只接受应用入口 file URL", () => {
    expect(
      isTrustedApplicationUrl("file:///C:/app/dist/index.html", entry),
    ).toBe(true);
    expect(
      isTrustedApplicationUrl("file:///C:/app/dist/other.html", entry),
    ).toBe(false);
  });

  it("接受显式配置的开发 origin，不接受其他远程来源", () => {
    expect(
      isTrustedApplicationUrl(
        "http://127.0.0.1:5173/schedule",
        entry,
        "http://127.0.0.1:5173",
      ),
    ).toBe(true);
    expect(
      isTrustedApplicationUrl(
        "https://attacker.example/schedule",
        entry,
        "http://127.0.0.1:5173",
      ),
    ).toBe(false);
  });

  it("拒绝自定义协议、凭据 URL 和错误的开发 origin", () => {
    expect(isTrustedApplicationUrl("javascript:alert(1)", entry)).toBe(false);
    expect(
      isTrustedApplicationUrl(
        "http://user:pass@127.0.0.1:5173/",
        entry,
        "http://127.0.0.1:5173",
      ),
    ).toBe(false);
    expect(
      isTrustedApplicationUrl(
        "http://127.0.0.1:5174/",
        entry,
        "http://127.0.0.1:5173",
      ),
    ).toBe(false);
  });
});
