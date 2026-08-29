import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "../../src/shared/types";
import {
  appendRunnerEvent,
  isTerminalRunnerEvent,
} from "../../src/renderer/pages/AcmWorkbenchPage";
import {
  confirmAcmNavigation,
  registerAcmNavigationGuard,
} from "../../src/renderer/services/AcmNavigationGuard";

function event(overrides: Partial<RunnerEvent> = {}): RunnerEvent {
  return {
    taskId: "task-1",
    documentId: "doc-1",
    stage: "compile-finished",
    status: "completed",
    ...overrides,
  };
}

describe("ACM Workbench 状态 helper", () => {
  it("只把实际模式的最终阶段视为 completed terminal", () => {
    expect(isTerminalRunnerEvent(event(), "run")).toBe(false);
    expect(isTerminalRunnerEvent(event({ stage: "run-finished" }), "run")).toBe(
      true,
    );
    expect(isTerminalRunnerEvent(event({ status: "cancelled" }), "run")).toBe(
      true,
    );
  });

  it("按 UTF-8 字节和事件数限制终端 ring buffer", () => {
    const large = event({ status: "data", text: "中".repeat(1 * 1024 * 1024) });
    const result = appendRunnerEvent([], large);
    expect(result.truncated).toBe(false);
    expect(
      new TextEncoder().encode(result.events[0]?.text ?? "").byteLength,
    ).toBe(3 * 1024 * 1024);
    const countLimited = appendRunnerEvent(
      Array.from({ length: 500 }, (_, index) =>
        event({ taskId: `task-${index}`, status: "started" }),
      ),
      event({ status: "started" }),
    );
    expect(countLimited.events).toHaveLength(500);
    expect(countLimited.truncated).toBe(true);
  });

  it("navigation guard can cancel or allow a route transition", async () => {
    const unregister = registerAcmNavigationGuard(async () => false);
    expect(await confirmAcmNavigation()).toBe(false);
    unregister();
    expect(await confirmAcmNavigation()).toBe(true);
  });
});
