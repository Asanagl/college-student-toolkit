import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompilerProbeResult,
  IpcResult,
  RunnerEvent,
  RunnerStartRequest,
} from "../../src/shared/types";
import {
  ACM_MAX_SOURCE_BYTES,
  AcmRunnerService,
  DEFAULT_RUNNER_LIMITS,
} from "../../src/main/services/AcmRunnerService";
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
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

interface FakeScenario {
  compileExitCode: number | null;
  compileStderr: string;
  runOutput: string;
  runStderr: string;
  holdRun: boolean;
}

const directories: string[] = [];
let nextPid = 1000;

function request(
  overrides: Partial<RunnerStartRequest> = {},
): RunnerStartRequest {
  return {
    documentId: "doc-1",
    source: "#include <iostream>\nint main() { std::cout << 1; }\n",
    stdin: "input\n",
    mode: "run",
    ...overrides,
  };
}

function compiler(
  probeResult: IpcResult<CompilerProbeResult> = {
    ok: true,
    data: {
      available: true,
      path: "fake-g++.exe",
      version: "fake",
      target: "x86_64-w64-mingw32",
    },
  },
) {
  return {
    probe: async () => probeResult,
    getCompilerFlags: () => ["-std=c++17", "-O2"],
    getCached: () => null,
  };
}

function child(): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.pid = nextPid++;
  value.exitCode = null;
  value.signalCode = null;
  value.stdin = new PassThrough();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.killed = false;
  value.kill = () => {
    if (value.killed) return true;
    value.killed = true;
    value.exitCode = null;
    queueMicrotask(() => value.emit("close", null));
    return true;
  };
  return value;
}

function factoryFor(scenario: FakeScenario): RunnerProcessFactory {
  let current: FakeChild | null = null;
  return {
    spawn: (_command, args, _options) => {
      const process = child();
      current = process;
      const isCompile = args.includes("-std=c++17");
      queueMicrotask(() => {
        if (isCompile) {
          const output = args[args.length - 1];
          fs.writeFileSync(output, "fake executable");
          if (scenario.compileStderr)
            process.stderr.write(scenario.compileStderr);
          process.exitCode = scenario.compileExitCode;
          process.emit("close", scenario.compileExitCode);
          return;
        }
        if (scenario.holdRun) return;
        if (scenario.runOutput) process.stdout.write(scenario.runOutput);
        if (scenario.runStderr) process.stderr.write(scenario.runStderr);
        process.exitCode = 0;
        process.emit("close", 0);
      });
      return process as unknown as ChildProcess;
    },
    execFile: (_file, _args, _options, callback) => {
      const killer = new EventEmitter() as ChildProcess;
      queueMicrotask(() => {
        current?.kill();
        callback(null);
      });
      return killer;
    },
  };
}

async function waitFor(
  events: RunnerEvent[],
  predicate: (event: RunnerEvent) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!events.some(predicate)) {
    if (Date.now() > deadline) throw new Error("等待 runner 事件超时");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function createService(
  scenario: Partial<FakeScenario> = {},
  limits: Partial<typeof DEFAULT_RUNNER_LIMITS> = {},
): AcmRunnerService {
  const tempRoot = createTempRoot();
  return new AcmRunnerService({
    compiler: compiler(),
    helper: new AcmRunnerHelper(
      factoryFor({
        compileExitCode: 0,
        compileStderr: "",
        runOutput: "",
        runStderr: "",
        holdRun: false,
        ...scenario,
      }),
      "win32",
    ),
    platform: "win32",
    tempRoot,
    limits,
  });
}

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-runner-test-"),
  );
  directories.push(tempRoot);
  return tempRoot;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("AcmRunnerService", () => {
  it("rejects unsupported hosts, invalid input and missing compilers", async () => {
    const unsupported = new AcmRunnerService({
      platform: "linux",
      compiler: compiler(),
    });
    expect(await unsupported.start(request())).toMatchObject({
      ok: false,
      errorCode: "ACM_UNSUPPORTED",
    });

    const service = createService();
    expect(
      await service.start(
        request({ source: "x".repeat(ACM_MAX_SOURCE_BYTES + 1) }),
      ),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_TOO_LARGE",
    });
    expect(
      await service.start(
        request({ stdin: "x".repeat(DEFAULT_RUNNER_LIMITS.stdinBytes + 1) }),
      ),
    ).toMatchObject({ ok: false, errorCode: "VALIDATION_FAILED" });

    const unavailable = compiler({
      ok: true,
      data: {
        available: false,
        path: null,
        version: null,
        target: null,
        reason: "missing",
      },
    });
    const unavailableService = new AcmRunnerService({
      compiler: unavailable,
      platform: "win32",
      tempRoot: createTempRoot(),
    });
    expect(await unavailableService.start(request())).toMatchObject({
      ok: false,
      errorCode: "ACM_COMPILER_MISSING",
    });
  });

  it("compiles and runs one document while streaming both output streams", async () => {
    const service = createService({
      compileStderr: "warning\n",
      runOutput: "answer\n",
      runStderr: "trace\n",
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();

    const result = await service.start(request());
    expect(result.ok).toBe(true);
    await waitFor(events, (event) => event.stage === "run-finished");

    expect(events.map((event) => event.stage)).toEqual([
      "compile-started",
      "compile-started",
      "compile-finished",
      "run-started",
      "run-started",
      "run-started",
      "run-finished",
    ]);
    expect(
      events.find((event) => event.stage === "compile-finished"),
    ).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(events.find((event) => event.stream === "stdout")).toMatchObject({
      status: "data",
      text: "answer\n",
    });
    expect(events.find((event) => event.stream === "stderr")).toMatchObject({
      status: "data",
      text: "warning\n",
    });
    expect(events.at(-1)).toMatchObject({
      stage: "run-finished",
      status: "completed",
      exitCode: 0,
    });
    await service.dispose();
  });

  it("reports compile failures and keeps the task serial", async () => {
    const service = createService({
      compileExitCode: 1,
      compileStderr: "error\n",
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    const started = await service.start(request({ mode: "compile" }));
    expect(started.ok).toBe(true);
    expect(await service.start(request())).toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_BUSY",
    });
    await waitFor(events, (event) => event.stage === "compile-finished");
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      errorCode: "ACM_RUNNER_FAILED",
      exitCode: 1,
    });
    await service.dispose();
  });

  it("stops a running process and reports cancellation", async () => {
    const service = createService({ holdRun: true });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    expect((await service.start(request())).ok).toBe(true);
    await waitFor(events, (event) => event.stage === "run-started");
    expect(await service.stop()).toEqual({ ok: true, data: true });
    await waitFor(events, (event) => event.stage === "run-finished");
    expect(events.at(-1)).toMatchObject({
      status: "cancelled",
      errorCode: "ACM_RUNNER_CANCELLED",
    });
    expect(await service.stop()).toEqual({ ok: true, data: false });
    await service.dispose();
  });

  it("terminates a timed-out run and limits output", async () => {
    const timeoutService = createService(
      { holdRun: true },
      { runTimeoutMs: 10 },
    );
    const timeoutEvents: RunnerEvent[] = [];
    timeoutService.onEvent((event) => timeoutEvents.push(event));
    expect((await timeoutService.start(request())).ok).toBe(true);
    await waitFor(timeoutEvents, (event) => event.stage === "run-finished");
    expect(timeoutEvents.at(-1)).toMatchObject({
      status: "timeout",
      errorCode: "ACM_RUNNER_TIMEOUT",
    });
    await timeoutService.dispose();

    const outputService = createService(
      { runOutput: "123456789" },
      { stdoutBytes: 4 },
    );
    const outputEvents: RunnerEvent[] = [];
    outputService.onEvent((event) => outputEvents.push(event));
    expect((await outputService.start(request())).ok).toBe(true);
    await waitFor(outputEvents, (event) => event.stage === "run-finished");
    expect(outputEvents.at(-1)).toMatchObject({
      status: "output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
    });
    await outputService.dispose();
  });
});
