import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import type {
  AcmDiffEvent,
  AcmDiffStartRequest,
  CompilerProbeResult,
  IpcResult,
  RunnerLimits,
} from "../../src/shared/types";
import {
  AcmDifferService,
  type AcmDifferServiceOptions,
} from "../../src/main/services/AcmDifferService";
import {
  AcmRunnerHelper,
  type RunnerProcessFactory,
} from "../../src/main/services/AcmRunnerHelper";

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): boolean;
}

interface Scenario {
  reference: string;
  candidate: string;
  referenceCompileExit?: number | null;
  candidateCompileStderr?: string;
  referenceRunExit?: number | null;
  referenceRunStderr?: string;
  candidateExit?: number | null;
  candidateRunStderr?: string;
  candidateCompileExit?: number | null;
  holdReference?: boolean;
  holdCandidate?: boolean;
}

const roots: string[] = [];
let pid = 30_000;

function compiler(): {
  probe: () => Promise<IpcResult<CompilerProbeResult>>;
  getCompilerFlags: () => string[];
} {
  return {
    probe: async () => ({
      ok: true,
      data: {
        available: true,
        path: "g++.exe",
        version: "fake",
        target: "x86_64-w64-mingw32",
      },
    }),
    getCompilerFlags: () => ["-std=c++17"],
  };
}

function child(): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.pid = pid++;
  value.exitCode = null;
  value.signalCode = null;
  value.stdin = new PassThrough();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = () => {
    value.exitCode = null;
    queueMicrotask(() => value.emit("close", null));
    return true;
  };
  return value;
}

function factory(scenario: Scenario, commands: string[]): RunnerProcessFactory {
  let compileCount = 0;
  let runCount = 0;
  return {
    spawn: (_command, args, _options) => {
      const process = child();
      const compile = args.includes("-std=c++17");
      commands.push(compile ? `compile-${++compileCount}` : "run");
      queueMicrotask(() => {
        if (compile) {
          fs.writeFileSync(args[args.length - 1], "fake executable");
          const compileStderr =
            compileCount === 1
              ? scenario.referenceRunStderr
              : scenario.candidateCompileStderr;
          if (compileStderr) process.stderr.write(compileStderr);
          const exit =
            compileCount === 1
              ? (scenario.referenceCompileExit ?? 0)
              : (scenario.candidateCompileExit ?? 0);
          process.exitCode = exit;
          process.emit("close", exit);
          return;
        }
        if (
          (scenario.holdReference && runCount === 0) ||
          (scenario.holdCandidate && runCount >= 1)
        )
          return;
        runCount += 1;
        const output = runCount === 1 ? scenario.reference : scenario.candidate;
        const stderr =
          runCount === 1
            ? scenario.referenceRunStderr
            : scenario.candidateRunStderr;
        if (output) process.stdout.write(output);
        if (stderr) process.stderr.write(stderr);
        const exit =
          runCount === 1
            ? (scenario.referenceRunExit ?? 0)
            : (scenario.candidateExit ?? 0);
        process.exitCode = exit;
        process.emit("close", exit);
      });
      return process as unknown as ChildProcess;
    },
    execFile: (_file, _args, _options, callback) => {
      const killer = new EventEmitter() as ChildProcess;
      queueMicrotask(() => callback(null));
      return killer;
    },
  };
}

class TerminationFailureHelper extends AcmRunnerHelper {
  override async terminate(_child: ChildProcess): Promise<void> {
    throw new Error("termination failed");
  }
}

class LateExitTerminationFailureHelper extends AcmRunnerHelper {
  private readonly scheduled = new WeakSet<ChildProcess>();

  constructor(
    factory: RunnerProcessFactory,
    private readonly delayMs = 250,
  ) {
    super(factory, "win32", 50, null);
  }

  override async terminate(child: ChildProcess): Promise<void> {
    if (!this.scheduled.has(child)) {
      this.scheduled.add(child);
      setTimeout(() => {
        const fake = child as FakeChild;
        fake.signalCode = "SIGTERM";
        child.emit("close", null);
      }, this.delayMs);
    }
    throw new Error("termination failed");
  }
}

class DeferredTerminationHelper extends AcmRunnerHelper {
  calls = 0;
  private release: (() => void) | null = null;

  constructor(factory: RunnerProcessFactory) {
    super(factory, "win32", 50, null);
  }

  override terminate(child: ChildProcess): Promise<void> {
    this.calls += 1;
    return new Promise<void>((resolve) => {
      this.release = () => {
        const fake = child as FakeChild;
        fake.signalCode = "SIGTERM";
        child.emit("close", null);
        resolve();
      };
    });
  }

  confirm(): void {
    this.release?.();
  }
}

function request(
  overrides: Partial<AcmDiffStartRequest> = {},
): AcmDiffStartRequest {
  return {
    reference: "ref",
    candidate: "cand",
    stdin: "input\n",
    ...overrides,
  };
}

async function run(
  scenario: Scenario,
  limits: Partial<RunnerLimits> = {},
  requestOverrides: Partial<AcmDiffStartRequest> = {},
  serviceOverrides: Pick<AcmDifferServiceOptions, "writeFile"> = {},
): Promise<{
  events: AcmDiffEvent[];
  commands: string[];
  root: string;
}> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-diff-test-"),
  );
  roots.push(root);
  const commands: string[] = [];
  const service = new AcmDifferService({
    compiler: compiler(),
    helper: new AcmRunnerHelper(factory(scenario, commands), "win32", 50),
    platform: "win32",
    tempRoot: root,
    limits,
    ...serviceOverrides,
  });
  await service.init();
  const events: AcmDiffEvent[] = [];
  service.onEvent((event) => events.push(event));
  const started = await service.start(request(requestOverrides));
  expect(started.ok).toBe(true);
  const deadline = Date.now() + 2_000;
  while (!events.some((event) => event.stage === "compare")) {
    if (Date.now() > deadline) throw new Error("等待对拍完成超时");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await service.dispose();
  return { events, commands, root };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待对拍状态超时");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("AcmDifferService", () => {
  it("allows stop to cancel while compiler probing is pending", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-probe-test-"),
    );
    roots.push(root);
    let resolveProbe!: (result: IpcResult<CompilerProbeResult>) => void;
    const probe = new Promise<IpcResult<CompilerProbeResult>>((resolve) => {
      resolveProbe = resolve;
    });
    const service = new AcmDifferService({
      compiler: {
        probe: () => probe,
        getCompilerFlags: () => ["-std=c++17"],
      },
      helper: new AcmRunnerHelper(
        factory({ reference: "ok", candidate: "ok" }, []),
        "win32",
        50,
      ),
      platform: "win32",
      tempRoot: root,
    });
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();

    const starting = service.start(request());
    await Promise.resolve();
    await expect(service.stop()).resolves.toEqual({ ok: true, data: true });
    resolveProbe({
      ok: true,
      data: {
        available: true,
        path: "g++.exe",
        version: "fake",
        target: "x86_64-w64-mingw32",
      },
    });

    await expect(starting).resolves.toMatchObject({
      ok: true,
      data: { taskId: expect.any(String) },
    });
    expect(events.at(-1)).toMatchObject({
      stage: "compare",
      status: "cancelled",
      result: {
        status: "cancelled",
        errorCode: "ACM_RUNNER_CANCELLED",
      },
    });
    await service.dispose();
  });

  it("compiles both sides before running reference then candidate and reports match", async () => {
    const result = await run({ reference: "1 2\n", candidate: "1 2\n" });
    expect(result.commands).toEqual(["compile-1", "run", "compile-2", "run"]);
    expect(
      result.events
        .filter((event) => event.status === "started")
        .map((event) => event.stage),
    ).toEqual([
      "reference-compile",
      "reference-run",
      "candidate-compile",
      "candidate-run",
    ]);
    expect(result.events.at(-1)?.result).toMatchObject({ status: "match" });
  });

  it("accepts an oversized candidate source while retaining the reference cap", async () => {
    const candidate = "x".repeat(2 * 1024 * 1024 + 1);
    const result = await run(
      { reference: "ok", candidate: "ok" },
      {},
      { candidate },
    );
    expect(result.commands).toEqual(["compile-1", "run", "compile-2", "run"]);
    expect(result.events.at(-1)?.result).toMatchObject({ status: "match" });
  });

  it("rejects candidate staging over the temp budget before compiling it", async () => {
    const result = await run(
      { reference: "ok", candidate: "unused" },
      { tempBytes: 1_024 },
      { candidate: "x".repeat(4_096) },
    );
    expect(result.commands).toEqual(["compile-1", "run"]);
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "candidate-output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
      referenceOutput: { stdout: "ok" },
    });
    expect(fs.readdirSync(result.root)).toEqual([]);
  });

  it("maps candidate staging disk exhaustion to output-limit and cleans up", async () => {
    const result = await run(
      { reference: "ok", candidate: "unused" },
      { tempBytes: 64 * 1024 },
      { candidate: "x".repeat(2_048) },
      {
        writeFile: (filePath, data, options) => {
          if (path.basename(filePath) === "main.cpp" && data.length > 100)
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          fs.writeFileSync(filePath, data, options);
        },
      },
    );
    expect(result.commands).toEqual(["compile-1", "run"]);
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "candidate-output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
    });
    expect(fs.readdirSync(result.root)).toEqual([]);
  });

  it("reports only the first token mismatch context", async () => {
    const result = await run({
      reference: "a b c d expected f",
      candidate: "a b c d actual f",
    });
    expect(result.events.at(-1)?.result).toMatchObject({ status: "mismatch" });
    expect(result.events.at(-1)?.result?.difference?.referenceTokens).toContain(
      "expected",
    );
  });

  it("returns both run outputs, including UTF-8 decoder tails", async () => {
    const result = await run({
      reference: "标准 输出\n",
      candidate: "标准 输出\n",
      referenceRunStderr: "标准诊断",
      candidateRunStderr: "待测诊断",
    });
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "match",
      referenceOutput: { stdout: "标准 输出\n", stderr: "标准诊断" },
      candidateOutput: { stdout: "标准 输出\n", stderr: "待测诊断" },
    });
  });

  it("does not run candidate when reference compilation fails", async () => {
    const result = await run({
      reference: "",
      candidate: "",
      referenceCompileExit: 1,
    });
    expect(result.commands).toEqual(["compile-1"]);
    expect(result.events.at(-1)?.result?.status).toBe("reference-failed");
  });

  it("keeps candidate compile failure separate from reference failure", async () => {
    const result = await run({
      reference: "ok",
      candidate: "bad",
      candidateCompileExit: 1,
    });
    expect(result.commands).toEqual(["compile-1", "run", "compile-2"]);
    expect(result.events.at(-1)?.result?.status).toBe(
      "candidate-compile-failed",
    );
  });

  it("does not start the candidate when the reference exits abnormally", async () => {
    const result = await run({
      reference: "bad",
      candidate: "must-not-run",
      referenceRunExit: 7,
    });
    expect(result.commands).toEqual(["compile-1", "run"]);
    expect(result.events.at(-1)?.result?.status).toBe("reference-failed");
    expect(
      result.events.some((event) => event.stage === "candidate-compile"),
    ).toBe(false);
  });

  it("keeps candidate runtime failure separate from reference failure", async () => {
    const result = await run({
      reference: "ok",
      candidate: "bad",
      candidateExit: 9,
    });
    expect(result.commands).toEqual(["compile-1", "run", "compile-2", "run"]);
    expect(result.events.at(-1)?.result?.status).toBe(
      "candidate-runtime-failed",
    );
  });

  it("stops a candidate run at the run timeout without comparing output", async () => {
    const result = await run(
      { reference: "ok", candidate: "hang", holdCandidate: true },
      { runTimeoutMs: 20 },
    );
    expect(result.events.at(-1)?.result?.status).toBe("candidate-timeout");
    expect(
      result.events.some(
        (event) =>
          event.stage === "compare" && event.result?.status === "match",
      ),
    ).toBe(false);
  });

  it("marks reference timeout as invalid and never compiles candidate", async () => {
    const result = await run(
      { reference: "hang", candidate: "must-not-run", holdReference: true },
      { runTimeoutMs: 20 },
    );
    expect(result.commands).toEqual(["compile-1", "run"]);
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "reference-failed",
      errorCode: "ACM_RUNNER_TIMEOUT",
    });
  });

  it("marks reference output overflow as invalid", async () => {
    const result = await run(
      { reference: "abcdef", candidate: "must-not-run" },
      { stdoutBytes: 3 },
    );
    expect(result.commands).toEqual(["compile-1", "run"]);
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "reference-failed",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
      referenceOutput: { stdout: "abc" },
    });
  });

  it("marks candidate output overflow separately", async () => {
    const result = await run(
      { reference: "ok", candidate: "abcdef" },
      { stdoutBytes: 3 },
    );
    expect(result.commands).toEqual(["compile-1", "run", "compile-2", "run"]);
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "candidate-output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
      referenceOutput: { stdout: "ok" },
      candidateOutput: { stdout: "abc" },
    });
  });

  it("marks candidate stderr overflow separately", async () => {
    const result = await run(
      { reference: "ok", candidate: "ok", candidateRunStderr: "abcdef" },
      { stderrBytes: 3 },
    );
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "candidate-output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
      candidateOutput: { stderr: "abc" },
    });
  });

  it("classifies candidate compile diagnostics overflow separately", async () => {
    const result = await run(
      { reference: "ok", candidate: "bad", candidateCompileStderr: "abcdef" },
      { stderrBytes: 3 },
    );
    expect(result.commands).toEqual(["compile-1", "run", "compile-2"]);
    expect(result.events.at(-1)?.result).toMatchObject({
      status: "candidate-output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
    });
  });

  it("publishes a cancelled result when stopped during a run", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-stop-"),
    );
    roots.push(root);
    const commands: string[] = [];
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new AcmRunnerHelper(
        factory(
          { reference: "hang", candidate: "unused", holdReference: true },
          commands,
        ),
        "linux",
        20,
      ),
      platform: "win32",
      tempRoot: root,
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    const started = await service.start(request());
    expect(started.ok).toBe(true);
    while (
      !events.some(
        (event) =>
          event.stage === "reference-run" && event.status === "started",
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    await service.stop();
    while (!events.some((event) => event.stage === "compare"))
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(events.at(-1)?.result?.status).toBe("cancelled");
    expect(commands).toEqual(["compile-1", "run"]);
    await service.dispose();
  });

  it("finishes the task when process termination reports an error", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-stop-error-"),
    );
    roots.push(root);
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new TerminationFailureHelper(
        factory(
          { reference: "hang", candidate: "unused", holdReference: true },
          [],
        ),
        "win32",
      ),
      platform: "win32",
      tempRoot: root,
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await expect(service.start(request())).resolves.toMatchObject({ ok: true });
    while (
      !events.some(
        (event) =>
          event.stage === "reference-run" && event.status === "started",
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(service.stop()).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_FAILED",
    });
    expect(events.at(-1)?.result).toMatchObject({
      status: "cancelled",
      cleanupBlocked: true,
      terminationError: "termination failed",
    });
    await expect(service.start(request())).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_BUSY",
    });
    await service.dispose();
  });

  it("keeps the task busy when automatic timeout termination fails", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-timeout-error-"),
    );
    roots.push(root);
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new TerminationFailureHelper(
        factory(
          { reference: "hang", candidate: "unused", holdReference: true },
          [],
        ),
        "win32",
      ),
      platform: "win32",
      tempRoot: root,
      limits: { runTimeoutMs: 5 },
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await expect(service.start(request())).resolves.toMatchObject({ ok: true });
    while (!events.some((event) => event.stage === "compare"))
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(events.at(-1)?.result).toMatchObject({
      status: "reference-failed",
      errorCode: "ACM_RUNNER_TIMEOUT",
      cleanupBlocked: true,
      terminationError: "termination failed",
    });
    await expect(service.start(request())).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_BUSY",
    });
    await service.dispose();
  });

  it("shares an in-flight timeout termination with a concurrent manual stop", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-timeout-stop-race-"),
    );
    roots.push(root);
    const helper = new DeferredTerminationHelper(
      factory(
        { reference: "hang", candidate: "unused", holdReference: true },
        [],
      ),
    );
    const service = new AcmDifferService({
      compiler: compiler(),
      helper,
      platform: "win32",
      tempRoot: root,
      limits: { runTimeoutMs: 5 },
    });
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();
    await expect(service.start(request())).resolves.toMatchObject({ ok: true });
    await waitUntil(() => helper.calls === 1, 2_000);
    const stopping = service.stop();
    await Promise.resolve();
    expect(helper.calls).toBe(1);
    helper.confirm();
    await expect(stopping).resolves.toMatchObject({ ok: true, data: true });
    await waitUntil(() => events.some((event) => event.stage === "compare"));
    await service.dispose();
  });

  it("cleans up after a late exit confirmation and allows the next task", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-late-exit-"),
    );
    roots.push(root);
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new LateExitTerminationFailureHelper(
        factory(
          { reference: "hang", candidate: "unused", holdReference: true },
          [],
        ),
      ),
      platform: "win32",
      tempRoot: root,
      limits: { runTimeoutMs: 5 },
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await expect(service.start(request())).resolves.toMatchObject({ ok: true });
    await waitUntil(() => events.some((event) => event.stage === "compare"));
    expect(events.at(-1)?.result).toMatchObject({
      status: "reference-failed",
      errorCode: "ACM_RUNNER_TIMEOUT",
      cleanupBlocked: true,
      terminationError: "termination failed",
    });
    expect(await service.start(request())).toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_BUSY",
    });
    await waitUntil(() => fs.readdirSync(root).length === 0);
    expect(events).toContainEqual(
      expect.objectContaining({
        cleanupConfirmed: true,
        side: "comparison",
        stage: "compare",
      }),
    );

    expect(await service.start(request())).toMatchObject({
      ok: true,
      data: { taskId: expect.any(String) },
    });
    await waitUntil(
      () => events.filter((event) => event.stage === "compare").length >= 2,
    );
    await service.dispose();
  });

  it("surfaces late cleanup warnings after the comparison result", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-late-cleanup-warning-"),
    );
    roots.push(root);
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new LateExitTerminationFailureHelper(
        factory(
          { reference: "hang", candidate: "unused", holdReference: true },
          [],
        ),
      ),
      platform: "win32",
      tempRoot: root,
      limits: { runTimeoutMs: 5 },
      removePath: () => {
        throw new Error("file is locked");
      },
      cleanupRetries: 0,
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await expect(service.start(request())).resolves.toMatchObject({ ok: true });
    await waitUntil(() =>
      events.some((event) => event.stage === "compare" && event.result),
    );
    const comparison = events.find(
      (event) => event.stage === "compare" && event.result,
    );
    expect(comparison?.result).toMatchObject({
      status: "reference-failed",
      errorCode: "ACM_RUNNER_TIMEOUT",
      cleanupBlocked: true,
      terminationError: "termination failed",
    });
    const earlyWarnings = comparison?.result?.cleanupWarnings ?? [];
    expect(earlyWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("清理标准程序失败")]),
    );
    await waitUntil(() =>
      events.some(
        (event) =>
          event.cleanupConfirmed === true &&
          (event.cleanupWarnings ?? []).some((warning) =>
            warning.includes("清理对拍临时目录失败"),
          ),
      ),
    );
    const confirmed = events.find((event) => event.cleanupConfirmed);
    expect(confirmed).toMatchObject({
      side: "comparison",
      stage: "compare",
      cleanupConfirmed: true,
    });
    expect(confirmed?.cleanupWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("清理对拍临时目录失败")]),
    );
    expect(
      earlyWarnings.some((warning) => warning.includes("清理对拍临时目录失败")),
    ).toBe(false);
    await service.dispose();
  });

  it("keeps cleanup warnings separate from the comparison result", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-cleanup-"),
    );
    roots.push(root);
    const commands: string[] = [];
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new AcmRunnerHelper(
        factory({ reference: "ok", candidate: "ok" }, commands),
        "linux",
      ),
      platform: "win32",
      tempRoot: root,
      removePath: () => {
        throw new Error("file is locked");
      },
      cleanupRetries: 0,
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.start(request());
    while (!events.some((event) => event.stage === "compare"))
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(events.at(-1)?.result).toMatchObject({
      status: "match",
      cleanupWarnings: expect.arrayContaining([
        expect.stringContaining("清理标准程序失败"),
      ]),
    });
    await service.dispose();
  });

  it("waits for scheduled cleanup retries before disposing", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-cleanup-wait-"),
    );
    roots.push(root);
    const commands: string[] = [];
    const firstCleanupTargets = new Set<string>();
    const retriedTargets = new Set<string>();
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new AcmRunnerHelper(
        factory({ reference: "ok", candidate: "ok" }, commands),
        "linux",
      ),
      platform: "win32",
      tempRoot: root,
      removePath: (target) => {
        if (target.endsWith("program.exe")) {
          if (!firstCleanupTargets.has(target)) {
            firstCleanupTargets.add(target);
            throw new Error("file is locked");
          }
          retriedTargets.add(target);
        }
        fs.rmSync(target, { recursive: true, force: true });
      },
    });
    await service.init();
    const comparison = new Promise<void>((resolve) => {
      service.onEvent((event) => {
        if (event.stage === "compare") resolve();
      });
    });
    await service.start(request());
    await comparison;
    const disposing = service.dispose();
    await expect(service.start(request())).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_PLUGIN_INVALID",
    });
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await disposing;
    expect(disposed).toBe(true);
    expect(retriedTargets.size).toBe(2);
  });

  it("caps concurrent cleanup retries and reports overflow as a warning", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-cleanup-cap-"),
    );
    roots.push(root);
    const commands: string[] = [];
    const retriedTargets = new Set<string>();
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new AcmRunnerHelper(
        factory({ reference: "ok", candidate: "ok" }, commands),
        "linux",
      ),
      platform: "win32",
      tempRoot: root,
      maxPendingCleanupRetries: 1,
      removePath: (target) => {
        retriedTargets.add(target);
        throw new Error("file is locked");
      },
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.start(request());
    await waitUntil(() => events.some((event) => event.stage === "compare"));
    expect(service.getPendingCleanupRetryCount()).toBe(1);
    expect(events.at(-1)?.result?.cleanupWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("清理重试队列已满，下次启动将继续清理"),
      ]),
    );
    await service.dispose();
    expect(retriedTargets.size).toBeGreaterThan(0);
  });

  it("keeps an unconfirmed child visible after dispose", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-unconfirmed-child-"),
    );
    roots.push(root);
    const service = new AcmDifferService({
      compiler: compiler(),
      helper: new TerminationFailureHelper(
        factory(
          { reference: "hang", candidate: "unused", holdReference: true },
          [],
        ),
        "win32",
      ),
      platform: "win32",
      tempRoot: root,
      limits: { runTimeoutMs: 5 },
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    await expect(service.start(request())).resolves.toMatchObject({ ok: true });
    await waitUntil(() => events.some((event) => event.stage === "compare"));
    expect(service.hasUnconfirmedChild()).toBe(true);
    await service.dispose();
    expect(service.hasUnconfirmedChild()).toBe(true);
  });

  it("rejects non-Windows execution before creating a task", async () => {
    const service = new AcmDifferService({
      compiler: compiler(),
      platform: "linux",
    });
    await service.init();
    await expect(service.start(request())).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_UNSUPPORTED",
    });
  });

  it("publishes a terminal cancelled result when stopped during compiler probing", async () => {
    let release!: (result: IpcResult<CompilerProbeResult>) => void;
    const compilerProbe = new Promise<IpcResult<CompilerProbeResult>>(
      (resolve) => {
        release = resolve;
      },
    );
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-race-"),
    );
    roots.push(root);
    const service = new AcmDifferService({
      compiler: { probe: () => compilerProbe, getCompilerFlags: () => [] },
      platform: "win32",
      tempRoot: root,
    });
    await service.init();
    const events: AcmDiffEvent[] = [];
    service.onEvent((event) => events.push(event));
    const started = service.start(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.stop();
    release({
      ok: false,
      errorCode: "ACM_COMPILER_MISSING",
      error: "cancelled",
    });
    await started;
    expect(events.at(-1)?.result?.status).toBe("cancelled");
    await service.dispose();
  });

  it("cleans only owned stale directories during init", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-stale-"),
    );
    roots.push(root);
    const stale = path.join(root, "college-toolkit-diff-old");
    fs.mkdirSync(stale);
    fs.writeFileSync(
      path.join(stale, ".college-toolkit-diff-owner.json"),
      JSON.stringify({
        formatVersion: 1,
        kind: "temp-directory",
        owner: "college-student-toolkit-acm-diff",
        createdAt: Date.now(),
      }),
    );
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    const unrelated = path.join(root, "college-toolkit-diff-foreign");
    fs.mkdirSync(unrelated);
    const service = new AcmDifferService({
      compiler: compiler(),
      platform: "win32",
      tempRoot: root,
      staleTempTtlMs: 1000,
    });
    await service.init();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("keeps stale directories that contain a reparse point", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-diff-stale-reparse-"),
    );
    roots.push(root);
    const stale = path.join(root, "college-toolkit-diff-reparse");
    fs.mkdirSync(stale);
    fs.writeFileSync(
      path.join(stale, ".college-toolkit-diff-owner.json"),
      JSON.stringify({
        formatVersion: 1,
        kind: "temp-directory",
        owner: "college-student-toolkit-acm-diff",
        createdAt: Date.now(),
      }),
    );
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    const service = new AcmDifferService({
      compiler: compiler(),
      platform: "win32",
      tempRoot: root,
      staleTempTtlMs: 1000,
    });
    const internals = service as unknown as {
      containsReparsePoint: (directory: string) => boolean;
    };
    const original = internals.containsReparsePoint;
    internals.containsReparsePoint = () => true;
    try {
      await service.init();
    } finally {
      internals.containsReparsePoint = original;
      await service.dispose();
    }
    expect(fs.existsSync(stale)).toBe(true);
  });

  it("checks tempBytes when a process closes before the monitor tick", async () => {
    const result = await run(
      { reference: "ok", candidate: "ok" },
      { tempBytes: 1 },
    );
    expect(result.events.at(-1)?.result?.status).toBe("reference-failed");
    expect(result.events.at(-1)?.result?.errorCode).toBe(
      "ACM_RUNNER_OUTPUT_LIMIT",
    );
  });
});
