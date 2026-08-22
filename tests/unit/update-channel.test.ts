import { describe, expect, it } from "vitest";
import { resolveUpdateChannel } from "../../src/main/services/UpdateChannel";

describe("resolveUpdateChannel", () => {
  it("uses the development channel before packaging", () => {
    expect(resolveUpdateChannel(false, false)).toBe("development");
  });

  it("assigns packaged Store apps to Microsoft Store updates", () => {
    expect(resolveUpdateChannel(true, true)).toBe("microsoft-store");
  });

  it("keeps packaged non-Store builds on the GitHub fallback channel", () => {
    expect(resolveUpdateChannel(true, false)).toBe("github");
  });
});
