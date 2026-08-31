import { describe, expect, it } from "vitest";
import { AcmLifecycleQueue } from "../../src/main/services/AcmLifecycleQueue";

describe("AcmLifecycleQueue", () => {
  it("waits for a lifecycle operation before starting the next one", async () => {
    const queue = new AcmLifecycleQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
      return "first";
    });
    const second = queue.run(async () => {
      events.push("second-start");
      return "second";
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    release();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("releases the next lifecycle operation when one operation rejects", async () => {
    const queue = new AcmLifecycleQueue();
    const failure = queue.run(async () => {
      throw new Error("stop failed");
    });
    const next = queue.run(() => "next");

    await expect(failure).rejects.toThrow("stop failed");
    await expect(next).resolves.toBe("next");
  });

  it("keeps a disable transition ahead of a queued start", async () => {
    const queue = new AcmLifecycleQueue();
    const events: string[] = [];
    let release!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disabling = queue.run(async () => {
      events.push("stop-active-tasks");
      await stopGate;
      events.push("set-disabled");
    });
    const starting = queue.run(() => {
      events.push("reject-start");
      return "disabled";
    });

    await Promise.resolve();
    expect(events).toEqual(["stop-active-tasks"]);
    release();
    await disabling;
    await expect(starting).resolves.toBe("disabled");
    expect(events).toEqual([
      "stop-active-tasks",
      "set-disabled",
      "reject-start",
    ]);
  });
});
