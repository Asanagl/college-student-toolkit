import { describe, expect, it } from "vitest";
import type { AcmDiffEvent } from "../../src/shared/types";
import { diffEventLifecycle } from "../../src/renderer/pages/AcmDiffPage";

function event(overrides: Partial<AcmDiffEvent> = {}): AcmDiffEvent {
  return {
    taskId: "task-1",
    side: "comparison",
    stage: "compare",
    status: "completed",
    result: { status: "match" },
    ...overrides,
  };
}

describe("ACM 对拍页面状态 helper", () => {
  it("终止未确认时保持 busy，迟到清理确认才释放", () => {
    expect(
      diffEventLifecycle(
        event({
          result: {
            status: "candidate-timeout",
            cleanupBlocked: true,
            terminationError: "termination failed",
          },
        }),
      ),
    ).toBe("pending-cleanup");
    expect(diffEventLifecycle(event({ cleanupConfirmed: true }))).toBe(
      "finished",
    );
  });

  it("把正常 compare 结果视为可释放的终结事件", () => {
    expect(diffEventLifecycle(event())).toBe("finished");
    expect(
      diffEventLifecycle(
        event({ side: "candidate", stage: "candidate-run", result: undefined }),
      ),
    ).toBe("none");
  });
});
