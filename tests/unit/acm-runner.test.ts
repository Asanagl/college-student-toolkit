import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  createAcmProcessEnvironment,
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
  runFileBytes?: number;
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
    spawn: (_command, args, options) => {
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
        if (scenario.runFileBytes) {
          fs.writeFileSync(
            path.join(options.cwd as string, "run-output.bin"),
            Buffer.alloc(scenario.runFileBytes),
          );
        }
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

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待 runner 状态超时");
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
        runFileBytes: undefined,
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function readMarkerPids(marker: string): number[] {
  try {
    return fs
      .readFileSync(marker, "utf8")
      .split(/\r?\n/)
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 3);
  } catch {
    return [];
  }
}

async function waitForMarkerPids(
  marker: string,
  timeoutMs = 10_000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = readMarkerPids(marker);
    if (pids.length >= 2) return pids.slice(0, 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待 taskkill fallback 目标 PID 超时");
}

async function waitForPidsToExit(
  pids: number[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`taskkill fallback 后仍有进程存活：${pids.join(", ")}`);
}

function cleanupPid(pid: number): void {
  if (!processExists(pid)) return;
  const root = process.env.SystemRoot?.trim() || "C:\\Windows";
  try {
    execFileSync(
      path.join(root, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
  } catch {
    // The test already captured the assertion failure; cleanup is best effort.
  }
}

function fallbackTreeCommand(marker: string): string {
  return [
    "$ErrorActionPreference='Stop';",
    "$child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\ping.exe') -ArgumentList @('127.0.0.1','-t') -PassThru;",
    `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value @($PID,$child.Id);`,
    "Start-Sleep -Seconds 60",
  ].join(" ");
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
    await unavailableService.init();
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
    await service.init();
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
    await service.init();
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

  it("allows stop to cancel while compiler probing is pending", async () => {
    const root = createTempRoot();
    let resolveProbe!: (result: IpcResult<CompilerProbeResult>) => void;
    const probe = new Promise<IpcResult<CompilerProbeResult>>((resolve) => {
      resolveProbe = resolve;
    });
    const service = new AcmRunnerService({
      compiler: {
        probe: () => probe,
        getCompilerFlags: () => ["-std=c++17"],
        getCached: () => null,
      },
      helper: new AcmRunnerHelper(
        factoryFor({
          compileExitCode: 0,
          compileStderr: "",
          runOutput: "",
          runStderr: "",
          holdRun: false,
        }),
        "win32",
      ),
      platform: "win32",
      tempRoot: root,
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();

    const starting = service.start(request());
    await Promise.resolve();
    await expect(service.stop()).resolves.toEqual({ ok: true, data: true });
    resolveProbe({
      ok: true,
      data: {
        available: true,
        path: "fake-g++.exe",
        version: "fake",
        target: "x86_64-w64-mingw32",
      },
    });

    await expect(starting).resolves.toMatchObject({
      ok: true,
      data: { taskId: expect.any(String) },
    });
    expect(events.at(-1)).toMatchObject({
      stage: "compile-finished",
      status: "cancelled",
      errorCode: "ACM_RUNNER_CANCELLED",
    });
    await service.dispose();
  });

  it("terminates a timed-out run and limits output", async () => {
    const timeoutService = createService(
      { holdRun: true },
      { runTimeoutMs: 10 },
    );
    const timeoutEvents: RunnerEvent[] = [];
    timeoutService.onEvent((event) => timeoutEvents.push(event));
    await timeoutService.init();
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
    await outputService.init();
    expect((await outputService.start(request())).ok).toBe(true);
    await waitFor(outputEvents, (event) => event.stage === "run-finished");
    expect(outputEvents.at(-1)).toMatchObject({
      status: "output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
    });
    await outputService.dispose();

    const tempService = createService(
      { runFileBytes: 1024 },
      { tempBytes: 512 },
    );
    const tempEvents: RunnerEvent[] = [];
    tempService.onEvent((event) => tempEvents.push(event));
    await tempService.init();
    expect((await tempService.start(request())).ok).toBe(true);
    await waitFor(tempEvents, (event) => event.stage === "run-finished");
    expect(tempEvents.at(-1)).toMatchObject({
      status: "output-limit",
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
    });
    await tempService.dispose();
  });

  it("surfaces timeout termination failure and keeps the task busy", async () => {
    const service = new AcmRunnerService({
      compiler: compiler(),
      helper: new TerminationFailureHelper(
        factoryFor({
          compileExitCode: 0,
          compileStderr: "",
          runOutput: "",
          runStderr: "",
          holdRun: true,
        }),
        "win32",
      ),
      platform: "win32",
      tempRoot: createTempRoot(),
      limits: { runTimeoutMs: 5 },
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();
    expect((await service.start(request())).ok).toBe(true);
    await waitFor(events, (event) => event.stage === "run-finished");
    expect(events.at(-1)).toMatchObject({
      status: "timeout",
      errorCode: "ACM_RUNNER_TIMEOUT",
      terminationError: "termination failed",
      cleanupBlocked: true,
    });
    expect(await service.start(request())).toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_BUSY",
    });
    expect(service.hasUnconfirmedChild()).toBe(true);
    await service.dispose();
    expect(service.hasUnconfirmedChild()).toBe(true);
  });

  it("shares an in-flight timeout termination with a concurrent manual stop", async () => {
    const helper = new DeferredTerminationHelper(
      factoryFor({
        compileExitCode: 0,
        compileStderr: "",
        runOutput: "",
        runStderr: "",
        holdRun: true,
      }),
    );
    const service = new AcmRunnerService({
      compiler: compiler(),
      helper,
      platform: "win32",
      tempRoot: createTempRoot(),
      limits: { runTimeoutMs: 5 },
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();
    expect((await service.start(request())).ok).toBe(true);
    await waitUntil(() => helper.calls === 1, 2_000);
    const stopping = service.stop();
    await Promise.resolve();
    expect(helper.calls).toBe(1);
    helper.confirm();
    await expect(stopping).resolves.toMatchObject({ ok: true, data: true });
    await waitFor(events, (event) => event.stage === "run-finished");
    await service.dispose();
  });

  it("cleans up after a late exit confirmation and allows the next task", async () => {
    const tempRoot = createTempRoot();
    const service = new AcmRunnerService({
      compiler: compiler(),
      helper: new LateExitTerminationFailureHelper(
        factoryFor({
          compileExitCode: 0,
          compileStderr: "",
          runOutput: "",
          runStderr: "",
          holdRun: true,
        }),
      ),
      platform: "win32",
      tempRoot,
      limits: { runTimeoutMs: 5 },
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();
    expect((await service.start(request())).ok).toBe(true);
    await waitFor(events, (event) => event.stage === "run-finished");
    expect(await service.start(request())).toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_BUSY",
    });
    await waitUntil(() => fs.readdirSync(tempRoot).length === 0);
    expect(events).toContainEqual(
      expect.objectContaining({
        cleanupConfirmed: true,
        stage: "run-finished",
      }),
    );

    expect(await service.start(request({ mode: "compile" }))).toMatchObject({
      ok: true,
      data: { taskId: expect.any(String) },
    });
    await waitFor(
      events,
      (event) =>
        event.stage === "compile-finished" && event.status === "completed",
    );
    await service.dispose();
  });

  it("returns the execution result before retrying a transient cleanup failure", async () => {
    const tempRoot = createTempRoot();
    let removeAttempts = 0;
    const service = new AcmRunnerService({
      compiler: compiler(),
      helper: new AcmRunnerHelper(
        factoryFor({
          compileExitCode: 0,
          compileStderr: "",
          runOutput: "answer\n",
          runStderr: "",
          holdRun: false,
        }),
        "win32",
      ),
      platform: "win32",
      tempRoot,
      removePath: (target) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("temporary lock");
        fs.rmSync(target, { recursive: true, force: true });
      },
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();
    expect((await service.start(request())).ok).toBe(true);
    await waitFor(
      events,
      (event) => event.stage === "run-finished" && event.status === "completed",
    );
    const resultIndex = events.findIndex(
      (event) => event.stage === "run-finished" && event.status === "completed",
    );
    await waitFor(
      events,
      (event) => event.cleanupWarning?.includes("临时目录清理失败") === true,
    );
    const warningIndex = events.findIndex(
      (event) => event.cleanupWarning?.includes("临时目录清理失败") === true,
    );
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeGreaterThan(resultIndex);
    await waitUntil(() => fs.readdirSync(tempRoot).length === 0, 2_000);
    expect(removeAttempts).toBeGreaterThanOrEqual(2);
    await waitFor(events, (event) => event.cleanupConfirmed === true);
    await service.dispose();
  });

  it("reports exhausted cleanup retries without changing the execution result", async () => {
    const tempRoot = createTempRoot();
    const service = new AcmRunnerService({
      compiler: compiler(),
      helper: new AcmRunnerHelper(
        factoryFor({
          compileExitCode: 0,
          compileStderr: "",
          runOutput: "answer\n",
          runStderr: "",
          holdRun: false,
        }),
        "win32",
      ),
      platform: "win32",
      tempRoot,
      cleanupRetries: 1,
      removePath: () => {
        throw new Error("temporary lock");
      },
    });
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.init();
    await expect(service.start(request())).resolves.toMatchObject({ ok: true });
    await waitFor(
      events,
      (event) => event.stage === "run-finished" && event.status === "completed",
    );
    expect(events.at(-1)).toMatchObject({
      stage: "run-finished",
      status: "completed",
    });
    await waitFor(
      events,
      (event) => event.cleanupWarning?.includes("清理重试已耗尽") === true,
    );
    expect(service.getPendingCleanupRetryCount()).toBe(0);
    expect(fs.readdirSync(tempRoot)).not.toHaveLength(0);
    await service.dispose();
  });

  it("keeps reparse-point cleanup conservative without leaving the runner busy", async () => {
    const service = createService({}, {});
    const internals = service as unknown as {
      containsReparsePoint: (directory: string) => boolean;
    };
    const original = internals.containsReparsePoint;
    internals.containsReparsePoint = () => true;
    const events: RunnerEvent[] = [];
    service.onEvent((event) => events.push(event));
    try {
      await service.init();
      await expect(service.start(request())).resolves.toMatchObject({
        ok: true,
      });
      await waitFor(
        events,
        (event) => event.cleanupWarning?.includes("未清理资源") === true,
      );
      internals.containsReparsePoint = original;
      expect(service.getPendingCleanupRetryCount()).toBe(0);
      await expect(
        service.start(request({ mode: "compile" })),
      ).resolves.toMatchObject({
        ok: true,
        data: { taskId: expect.any(String) },
      });
      await waitFor(
        events,
        (event) =>
          event.stage === "compile-finished" && event.status === "completed",
      );
    } finally {
      internals.containsReparsePoint = original;
      await service.dispose();
    }
  });
});

describe("AcmRunnerHelper", () => {
  it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
    "terminates a real process tree with the taskkill fallback",
    async () => {
      const directory = createTempRoot();
      const marker = path.join(directory, "fallback-pids.txt");
      const powershell = path.join(
        process.env.SystemRoot?.trim() || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const helper = new AcmRunnerHelper(undefined, "win32", 3_000, null);
      let childProcess: ChildProcess | null = null;
      let pids: number[] = [];
      try {
        childProcess = helper.spawn(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            fallbackTreeCommand(marker),
          ],
          directory,
          ["ignore", "pipe", "pipe"],
        );
        pids = await waitForMarkerPids(marker);
        expect(
          pids.every(processExists),
          `fallback marker PIDs: ${JSON.stringify(pids.map((pid) => ({ pid, alive: processExists(pid) })))}`,
        ).toBe(true);
        await helper.terminate(childProcess);
        await waitForPidsToExit(pids);
        expect(
          childProcess.exitCode !== null || childProcess.signalCode !== null,
        ).toBe(true);
      } finally {
        if (
          childProcess &&
          childProcess.exitCode === null &&
          childProcess.signalCode === null
        )
          await helper.terminate(childProcess).catch(() => undefined);
        pids.forEach(cleanupPid);
      }
    },
  );

  it("uses the native Job Object wrapper when it is available", () => {
    const helperPath = path.join(createTempRoot(), "acm-job-runner.exe");
    fs.writeFileSync(helperPath, "test");
    const calls: Array<{ command: string; args: string[] }> = [];
    const factory: RunnerProcessFactory = {
      spawn: (command, args) => {
        calls.push({ command, args });
        return child() as unknown as ChildProcess;
      },
      execFile: (_file, _args, _options, callback) => {
        const process = new EventEmitter() as ChildProcess;
        callback(null);
        return process;
      },
    };
    const helper = new AcmRunnerHelper(factory, "win32", 3_000, helperPath);
    helper.spawn(
      "C:\\temp\\g++.exe",
      ["-std=c++17", "source.cpp"],
      "C:\\temp",
      ["ignore", "pipe", "pipe"],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: helperPath,
      args: ["C:\\temp\\g++.exe", "-std=c++17", "source.cpp"],
    });
  });

  it("falls back to the target process when the native helper is missing", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const factory: RunnerProcessFactory = {
      spawn: (command, args) => {
        calls.push({ command, args });
        return child() as unknown as ChildProcess;
      },
      execFile: (_file, _args, _options, callback) => {
        const process = new EventEmitter() as ChildProcess;
        callback(null);
        return process;
      },
    };
    const helper = new AcmRunnerHelper(factory, "win32", 3_000, null);
    helper.spawn(
      "C:\\temp\\g++.exe",
      ["-std=c++17", "source.cpp"],
      "C:\\temp",
      ["ignore", "pipe", "pipe"],
    );
    expect(calls).toEqual([
      expect.objectContaining({
        command: "C:\\temp\\g++.exe",
        args: ["-std=c++17", "source.cpp"],
      }),
    ]);
  });

  it("does not use a Windows helper on unsupported platforms", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const factory: RunnerProcessFactory = {
      spawn: (command, args) => {
        calls.push({ command, args });
        return child() as unknown as ChildProcess;
      },
      execFile: (_file, _args, _options, callback) => {
        const process = new EventEmitter() as ChildProcess;
        callback(null);
        return process;
      },
    };
    const helper = new AcmRunnerHelper(
      factory,
      "linux",
      3_000,
      "/tmp/acm-job-runner.exe",
    );
    helper.spawn("/tmp/g++", ["source.cpp"], "/tmp", [
      "ignore",
      "pipe",
      "pipe",
    ]);
    expect(calls).toEqual([
      expect.objectContaining({ command: "/tmp/g++", args: ["source.cpp"] }),
    ]);
  });

  it("rejects termination when the child never confirms exit", async () => {
    const process = child();
    process.kill = () => false;
    const factory: RunnerProcessFactory = {
      spawn: () => process as unknown as ChildProcess,
      execFile: (_file, _args, _options, callback) => {
        const killer = new EventEmitter() as ChildProcess;
        queueMicrotask(() => callback(null));
        return killer;
      },
    };
    const helper = new AcmRunnerHelper(factory, "win32", 5);
    await expect(
      helper.terminate(process as unknown as ChildProcess),
    ).rejects.toThrow("未确认退出");
  });

  it("keeps the runtime toolchain directory in the controlled PATH", () => {
    const environment = createAcmProcessEnvironment(
      "C:\\task\\program.exe",
      "C:\\toolchain\\bin",
      "C:\\task",
    );
    expect(environment.PATH).toContain("C:\\toolchain\\bin");
    expect(environment.PATH).toContain("System32");
    expect(environment.TEMP).toBe("C:\\task");
    expect(environment.TMP).toBe("C:\\task");
  });

  it("force-kills the child when taskkill exits with an error", async () => {
    const process = child();
    const factory: RunnerProcessFactory = {
      spawn: () => process as unknown as ChildProcess,
      execFile: (_file, _args, _options, callback) => {
        const killer = new EventEmitter() as ChildProcess;
        queueMicrotask(() => callback(new Error("taskkill failed")));
        return killer;
      },
    };
    const helper = new AcmRunnerHelper(factory, "win32");
    await helper.terminate(process as unknown as ChildProcess);
    expect(process.killed).toBe(true);
  });

  it("cleans stale runner directories during initialization", async () => {
    const tempRoot = createTempRoot();
    const now = Date.now();
    const staleTtlMs = 60_000;
    const stale = path.join(tempRoot, "college-toolkit-runner-stale");
    fs.mkdirSync(stale);
    fs.writeFileSync(
      path.join(stale, ".college-toolkit-runner-owner.json"),
      JSON.stringify({
        formatVersion: 1,
        owner: "college-student-toolkit-acm",
        instanceId: "old-instance",
        pid: 1,
        createdAt: now - staleTtlMs - 1,
      }),
    );
    const unowned = path.join(tempRoot, "college-toolkit-runner-unowned");
    fs.mkdirSync(unowned);
    const fresh = path.join(tempRoot, "college-toolkit-runner-fresh");
    fs.mkdirSync(fresh);
    fs.writeFileSync(
      path.join(fresh, ".college-toolkit-runner-owner.json"),
      JSON.stringify({
        formatVersion: 1,
        owner: "college-student-toolkit-acm",
        instanceId: "fresh-instance",
        pid: process.pid,
        createdAt: now,
      }),
    );
    const service = new AcmRunnerService({
      platform: "win32",
      compiler: compiler(),
      tempRoot,
      staleTempTtlMs: staleTtlMs,
    });
    await service.init();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(unowned)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    await service.dispose();
  });

  it("rejects start and stop before initialization", async () => {
    const service = createService();
    expect(await service.start(request())).toMatchObject({
      ok: false,
      errorCode: "ACM_PLUGIN_INVALID",
    });
    expect(await service.stop()).toMatchObject({
      ok: false,
      errorCode: "ACM_PLUGIN_INVALID",
    });
  });

  it("cleans the task directory when its owner marker cannot be written", async () => {
    const tempRoot = createTempRoot();
    const service = new AcmRunnerService({
      compiler: compiler(),
      helper: new AcmRunnerHelper(
        factoryFor({
          compileExitCode: 0,
          compileStderr: "",
          runOutput: "",
          runStderr: "",
          holdRun: false,
        }),
        "win32",
      ),
      platform: "win32",
      tempRoot,
      writeFile: (filePath, data, options) => {
        if (path.basename(filePath) === ".college-toolkit-runner-owner.json")
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        fs.writeFileSync(filePath, data, options);
      },
    });
    await service.init();

    await expect(service.start(request())).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
    });
    expect(fs.readdirSync(tempRoot)).toEqual([]);
    await service.dispose();
  });
});
