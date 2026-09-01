import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type {
  AcmDiffEvent,
  AcmDiffProgramOutput,
  AcmDiffResult,
  AcmDiffResultStatus,
  AcmDiffSide,
  AcmDiffStage,
  AcmDiffStartRequest,
  IpcResult,
  RunnerLimits,
} from "../../shared/types";
import { AcmRunnerHelper, acmRunnerHelper } from "./AcmRunnerHelper";
import {
  DEFAULT_RUNNER_LIMITS,
  ACM_MAX_SOURCE_BYTES,
  type AcmRunnerCompiler,
} from "./AcmRunnerService";
import { acmCompilerService } from "./AcmCompilerService";
import { compareAcmTokens } from "./AcmTokenComparator";

const requestSchema = z.object({
  reference: z.string(),
  candidate: z.string(),
  stdin: z.string(),
});
const DEFAULT_TEMP_ROOT = path.join(
  os.tmpdir(),
  "college-student-toolkit-acm-diff",
);
const TEMP_PREFIX = "college-toolkit-diff-";
const OWNER_MARKER = ".college-toolkit-diff-owner.json";
const CLEANUP_RETRIES = 3;
const MAX_CLEANUP_RETRIES = 8;
const CLEANUP_RETRY_DELAY_MS = 250;
const STALE_TEMP_TTL_MS = 24 * 60 * 60 * 1000;

function isResourceWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EFBIG" || code === "EDQUOT";
}

class DiffResourceLimitError extends Error {
  readonly errorCode = "ACM_RUNNER_OUTPUT_LIMIT" as const;

  constructor(message: string) {
    super(message);
    this.name = "DiffResourceLimitError";
  }
}

type Side = Exclude<AcmDiffSide, "comparison">;
type Phase = "compile" | "run";
type DiffTextWriter = (
  filePath: string,
  data: string,
  options: { encoding: "utf8"; flag: "wx" },
) => void | Promise<void>;
type PhaseStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "output-limit";

interface PhaseOutcome {
  status: PhaseStatus;
  errorCode?: AcmDiffEvent["errorCode"];
}

interface SideTask {
  dir: string;
  executable: string;
  runStarted: boolean;
  stdout: string;
  stderr: string;
}

interface DiffTask {
  id: string;
  request: AcmDiffStartRequest;
  stopRequested: boolean;
  child: ChildProcess | null;
  termination: Promise<void> | null;
  side: Side | null;
  sides: Record<Side, SideTask | null>;
  cleanupWarnings: string[];
  done: Promise<void> | null;
  runtimePath: string | null;
  phase: ActivePhase | null;
}

interface ActivePhase {
  side: Side;
  phase: Phase;
  executable: string;
  runtime: PhaseRuntime;
}

interface PhaseRuntime {
  child: ChildProcess | null;
  settled: boolean;
  forcedStatus: PhaseStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
  tempTimer: ReturnType<typeof setInterval> | null;
  counts: { stdout: number; stderr: number };
  decoders: { stdout: StringDecoder; stderr: StringDecoder };
  decodersFlushed: boolean;
  resolve: (outcome: PhaseOutcome) => void;
}

export interface AcmDifferServiceOptions {
  compiler?: AcmRunnerCompiler;
  helper?: AcmRunnerHelper;
  platform?: NodeJS.Platform;
  tempRoot?: string;
  limits?: Partial<RunnerLimits>;
  cleanupRetries?: number;
  staleTempTtlMs?: number;
  removePath?: (target: string) => void;
  writeFile?: DiffTextWriter;
}

function errorResult<T>(
  errorCode: IpcResult<T>["errorCode"],
  error: string,
): IpcResult<T> {
  return { ok: false, errorCode, error };
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stage(side: Side, phase: Phase): AcmDiffStage {
  return `${side}-${phase}` as AcmDiffStage;
}

function eventStatus(status: PhaseStatus): AcmDiffEvent["status"] {
  return status;
}

function resultForPhase(
  side: Side,
  phase: Phase,
  outcome: PhaseOutcome,
): AcmDiffResultStatus {
  if (outcome.status === "cancelled") return "cancelled";
  if (side === "reference") return "reference-failed";
  if (outcome.status === "output-limit") return "candidate-output-limit";
  if (phase === "compile") return "candidate-compile-failed";
  if (outcome.status === "timeout") return "candidate-timeout";
  return outcome.status === "failed" ? "candidate-runtime-failed" : "cancelled";
}

function isComplete(outcome: PhaseOutcome): boolean {
  return outcome.status === "completed";
}

/**
 * Runs the reference and candidate in a strict serial pipeline. The service
 * deliberately owns no editor/history state; callers can discard all inputs
 * by dropping the page and stopping this one active task.
 */
export class AcmDifferService {
  private readonly compiler: AcmRunnerCompiler;
  private readonly helper: AcmRunnerHelper;
  private readonly platform: NodeJS.Platform;
  private readonly tempRoot: string;
  private readonly limits: RunnerLimits;
  private readonly cleanupRetries: number;
  private readonly staleTempTtlMs: number;
  private readonly removePath: (target: string) => void;
  private readonly writeFile: DiffTextWriter;
  private readonly listeners = new Set<(event: AcmDiffEvent) => void>();
  private readonly pendingCleanupRetries = new Map<string, Promise<void>>();
  private active: DiffTask | null = null;
  private initialized = false;
  private disposing = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: AcmDifferServiceOptions = {}) {
    this.compiler = options.compiler ?? acmCompilerService;
    this.helper = options.helper ?? acmRunnerHelper;
    this.platform = options.platform ?? process.platform;
    this.tempRoot = path.resolve(options.tempRoot ?? DEFAULT_TEMP_ROOT);
    this.limits = { ...DEFAULT_RUNNER_LIMITS, ...options.limits };
    this.cleanupRetries = Math.min(
      MAX_CLEANUP_RETRIES,
      Math.max(0, Math.floor(options.cleanupRetries ?? CLEANUP_RETRIES)),
    );
    this.staleTempTtlMs = Math.max(
      1,
      options.staleTempTtlMs ?? STALE_TEMP_TTL_MS,
    );
    this.removePath =
      options.removePath ??
      ((target) =>
        fs.rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 1,
          retryDelay: 50,
        }));
    this.writeFile =
      options.writeFile ??
      ((target, data, writeOptions) =>
        fs.promises.writeFile(target, data, writeOptions));
  }

  async init(): Promise<void> {
    if (this.disposing) throw new Error("ACM 对拍服务正在退出");
    fs.mkdirSync(this.tempRoot, { recursive: true });
    if (this.isReparsePoint(this.tempRoot))
      throw new Error("ACM 对拍临时根目录不能是 reparse point");
    if (!fs.lstatSync(this.tempRoot).isDirectory())
      throw new Error("ACM 对拍临时根目录无效");
    this.cleanupStaleTempDirectories();
    this.initialized = true;
  }

  onEvent(callback: (event: AcmDiffEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async start(
    request: AcmDiffStartRequest,
  ): Promise<IpcResult<{ taskId: string }>> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success)
      return errorResult("VALIDATION_FAILED", "对拍请求无效");
    if (bytes(parsed.data.reference) > ACM_MAX_SOURCE_BYTES)
      return errorResult("ACM_FILE_TOO_LARGE", "标准程序源码超过 2 MiB 限制");
    if (bytes(parsed.data.stdin) > this.limits.stdinBytes)
      return errorResult("VALIDATION_FAILED", "标准输入超过 256 KiB 限制");
    if (this.platform !== "win32")
      return errorResult("ACM_UNSUPPORTED", "ACM 对拍仅支持 Windows");
    if (this.disposing)
      return errorResult("ACM_PLUGIN_INVALID", "ACM 对拍服务正在退出");
    if (!this.initialized)
      return errorResult("ACM_PLUGIN_INVALID", "ACM 对拍服务尚未初始化");
    if (this.active)
      return errorResult("ACM_RUNNER_BUSY", "已有对拍任务正在执行");
    const task: DiffTask = {
      id: randomUUID(),
      request: parsed.data,
      stopRequested: false,
      child: null,
      termination: null,
      side: null,
      sides: { reference: null, candidate: null },
      cleanupWarnings: [],
      done: null,
      runtimePath: null,
      phase: null,
    };
    this.active = task;
    try {
      const compilerPath = await this.resolveCompiler();
      task.runtimePath = path.dirname(compilerPath);
      if (task.stopRequested) {
        await this.cleanupTask(task);
        this.finishResult(task, {
          status: "cancelled",
          errorCode: "ACM_RUNNER_CANCELLED",
        });
        this.active = null;
        return { ok: true, data: { taskId: task.id } };
      }
      task.done = new Promise((resolve) =>
        setImmediate(
          () => void this.execute(task, compilerPath).then(resolve, resolve),
        ),
      );
      return { ok: true, data: { taskId: task.id } };
    } catch (error) {
      this.active = null;
      if (task.stopRequested) {
        this.finishResult(task, {
          status: "cancelled",
          errorCode: "ACM_RUNNER_CANCELLED",
        });
        return { ok: true, data: { taskId: task.id } };
      }
      return errorResult(
        "ACM_COMPILER_MISSING",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async stop(): Promise<IpcResult<boolean>> {
    const task = this.active;
    if (!task) return { ok: true, data: false };
    task.stopRequested = true;
    let terminationError: unknown;
    if (task.child) {
      try {
        await this.terminate(task, task.child);
      } catch (error) {
        terminationError = error;
        await this.finishAfterTerminationFailure(task);
      }
    }
    if (task.done) await task.done;
    if (terminationError)
      return errorResult(
        "ACM_RUNNER_FAILED",
        terminationError instanceof Error
          ? terminationError.message
          : String(terminationError),
      );
    return { ok: true, data: true };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    try {
      await this.stop();
    } finally {
      await Promise.allSettled([...this.pendingCleanupRetries.values()]);
      this.initialized = false;
      this.listeners.clear();
    }
  }

  private async execute(task: DiffTask, compilerPath: string): Promise<void> {
    let finalResult: AcmDiffResult = {
      status: task.stopRequested ? "cancelled" : "reference-failed",
      errorCode: "ACM_RUNNER_FAILED",
    };
    let currentSide: Side = "reference";
    try {
      const referenceDir = await this.stageTaskSide(task, "reference");
      const referenceCompile = await this.runPhase(
        task,
        "reference",
        "compile",
        compilerPath,
        referenceDir.executable,
      );
      if (!isComplete(referenceCompile)) {
        finalResult = {
          status: resultForPhase("reference", "compile", referenceCompile),
          errorCode: referenceCompile.errorCode,
        };
        return;
      }
      const referenceRun = await this.runPhase(
        task,
        "reference",
        "run",
        referenceDir.executable,
        referenceDir.executable,
      );
      await this.cleanupExecutable(task, "reference");
      if (!isComplete(referenceRun)) {
        finalResult = {
          status: resultForPhase("reference", "run", referenceRun),
          errorCode: referenceRun.errorCode,
        };
        return;
      }
      currentSide = "candidate";
      const candidateDir = await this.stageTaskSide(task, "candidate");
      const candidateCompile = await this.runPhase(
        task,
        "candidate",
        "compile",
        compilerPath,
        candidateDir.executable,
      );
      if (!isComplete(candidateCompile)) {
        finalResult = {
          status: resultForPhase("candidate", "compile", candidateCompile),
          errorCode: candidateCompile.errorCode,
        };
        return;
      }
      const candidateRun = await this.runPhase(
        task,
        "candidate",
        "run",
        candidateDir.executable,
        candidateDir.executable,
      );
      await this.cleanupExecutable(task, "candidate");
      if (!isComplete(candidateRun)) {
        finalResult = {
          status: resultForPhase("candidate", "run", candidateRun),
          errorCode: candidateRun.errorCode,
        };
        return;
      }
      const compared = compareAcmTokens(
        task.sides.reference?.stdout ?? "",
        task.sides.candidate?.stdout ?? "",
      );
      const result: AcmDiffResult =
        compared.status === "match"
          ? { status: "match" }
          : { status: "mismatch", difference: compared.difference };
      finalResult = result;
    } catch (error) {
      const errorCode =
        error instanceof DiffResourceLimitError
          ? error.errorCode
          : "ACM_RUNNER_FAILED";
      const candidateResourceLimit =
        currentSide === "candidate" && errorCode === "ACM_RUNNER_OUTPUT_LIMIT";
      const status: AcmDiffResultStatus = task.stopRequested
        ? "cancelled"
        : candidateResourceLimit
          ? "candidate-output-limit"
          : currentSide === "candidate"
            ? "candidate-compile-failed"
            : "reference-failed";
      finalResult = {
        status,
        errorCode,
      };
    } finally {
      task.request = { ...task.request, reference: "", candidate: "" };
      await this.cleanupTask(task);
      this.finishResult(task, finalResult);
      if (this.active === task) this.active = null;
    }
  }

  private async stageTaskSide(task: DiffTask, side: Side): Promise<SideTask> {
    const source =
      side === "reference" ? task.request.reference : task.request.candidate;
    const prepared = await this.prepareSide(task, side, source);
    task.request =
      side === "reference"
        ? { ...task.request, reference: "" }
        : { ...task.request, candidate: "" };
    return prepared;
  }

  private async prepareSide(
    task: DiffTask,
    side: Side,
    source: string,
  ): Promise<SideTask> {
    task.side = side;
    let dir: string;
    try {
      dir = fs.mkdtempSync(path.join(this.tempRoot, TEMP_PREFIX));
    } catch (error) {
      if (isResourceWriteError(error))
        throw new DiffResourceLimitError("无法创建对拍临时目录");
      throw error;
    }
    const executable = path.join(dir, "program.exe");
    task.sides[side] = {
      dir,
      executable,
      runStarted: false,
      stdout: "",
      stderr: "",
    };
    const marker = JSON.stringify({
      formatVersion: 1,
      owner: "college-student-toolkit-acm-diff",
      kind: "temp-directory",
      createdAt: Date.now(),
    });
    try {
      await this.writeFile(path.join(dir, OWNER_MARKER), marker, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isResourceWriteError(error))
        throw new DiffResourceLimitError("无法写入对拍临时目录标记");
      throw error;
    }
    const sourceBytes = bytes(source);
    if (this.directoryBytes(dir) + sourceBytes > this.limits.tempBytes)
      throw new DiffResourceLimitError("源码超过对拍临时目录限制");
    try {
      await this.writeFile(path.join(dir, "main.cpp"), source, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isResourceWriteError(error))
        throw new DiffResourceLimitError("源码写入超过对拍临时目录限制");
      throw error;
    }
    if (this.tempExceeded(dir))
      throw new DiffResourceLimitError("源码超过对拍临时目录限制");
    return task.sides[side] as SideTask;
  }

  private runPhase(
    task: DiffTask,
    side: Side,
    phase: Phase,
    command: string,
    executable: string,
  ): Promise<PhaseOutcome> {
    const timeout =
      phase === "compile"
        ? this.limits.compileTimeoutMs
        : this.limits.runTimeoutMs;
    this.emit({
      taskId: task.id,
      side,
      stage: stage(side, phase),
      status: "started",
    });
    if (task.stopRequested) {
      this.emit({
        taskId: task.id,
        side,
        stage: stage(side, phase),
        status: "cancelled",
        errorCode: "ACM_RUNNER_CANCELLED",
      });
      return Promise.resolve({
        status: "cancelled",
        errorCode: "ACM_RUNNER_CANCELLED",
      });
    }
    return new Promise((resolve) => {
      const runtime = this.createRuntime(resolve);
      task.phase = { side, phase, executable, runtime };
      try {
        runtime.child = this.spawnPhase(task, side, phase, command, executable);
        task.child = runtime.child;
        if (phase === "run" && task.sides[side])
          task.sides[side]!.runStarted = true;
      } catch {
        void this.finishPhase(
          task,
          side,
          phase,
          runtime,
          "failed",
          "ACM_RUNNER_FAILED",
        );
        return;
      }
      runtime.timer = setTimeout(
        () => this.timeoutPhase(task, side, phase, runtime),
        timeout,
      );
      this.bindPhaseEvents(task, side, phase, executable, runtime);
      if (phase === "run" && runtime.child.stdin)
        runtime.child.stdin.end(Buffer.from(task.request.stdin, "utf8"));
      this.monitorPhaseTemp(task, side, phase, runtime);
      if (task.stopRequested) {
        runtime.forcedStatus = "cancelled";
        void this.finishPhase(
          task,
          side,
          phase,
          runtime,
          "cancelled",
          "ACM_RUNNER_CANCELLED",
        );
      }
    });
  }

  private async resolveCompiler(): Promise<string> {
    const cached = this.compiler.getCached?.();
    if (cached?.available && cached.path) return cached.path;
    const result = await this.compiler.probe();
    if (!result.ok || !result.data?.available || !result.data.path)
      throw new Error(result.error ?? result.data?.reason ?? "没有可用编译器");
    return result.data.path;
  }

  private createRuntime(
    resolve: (outcome: PhaseOutcome) => void,
  ): PhaseRuntime {
    return {
      child: null,
      settled: false,
      forcedStatus: null,
      timer: null,
      tempTimer: null,
      counts: { stdout: 0, stderr: 0 },
      decoders: {
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
      },
      decodersFlushed: false,
      resolve,
    };
  }

  private spawnPhase(
    task: DiffTask,
    side: Side,
    phase: Phase,
    command: string,
    executable: string,
  ): ChildProcess {
    const args =
      phase === "compile"
        ? [
            ...this.compiler.getCompilerFlags(),
            path.join(task.sides[side]?.dir ?? "", "main.cpp"),
            "-o",
            executable,
          ]
        : [];
    return this.helper.spawn(
      command,
      args,
      task.sides[side]?.dir ?? this.tempRoot,
      phase === "compile"
        ? ["ignore", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
      task.runtimePath ?? path.dirname(command),
    );
  }

  private async finishPhase(
    task: DiffTask,
    side: Side,
    phase: Phase,
    runtime: PhaseRuntime,
    status: PhaseStatus,
    errorCode?: AcmDiffEvent["errorCode"],
  ): Promise<void> {
    if (runtime.settled) return;
    runtime.settled = true;
    this.flushPhaseOutput(task, side, phase, runtime);
    if (runtime.timer) clearTimeout(runtime.timer);
    if (runtime.tempTimer) clearInterval(runtime.tempTimer);
    if (status !== "completed" && runtime.child)
      await this.terminate(task, runtime.child).catch(() => undefined);
    if (task.phase?.runtime === runtime) task.phase = null;
    runtime.resolve({ status, errorCode });
    this.emit({
      taskId: task.id,
      side,
      stage: stage(side, phase),
      status: eventStatus(status),
      errorCode,
    });
  }

  private timeoutPhase(
    task: DiffTask,
    side: Side,
    phase: Phase,
    runtime: PhaseRuntime,
  ): void {
    runtime.forcedStatus = "timeout";
    void this.finishPhase(
      task,
      side,
      phase,
      runtime,
      "timeout",
      "ACM_RUNNER_TIMEOUT",
    );
  }

  private async finishAfterTerminationFailure(task: DiffTask): Promise<void> {
    const phase = task.phase;
    if (!phase || phase.runtime.settled) return;
    phase.runtime.child = null;
    task.child = null;
    await this.finishPhase(
      task,
      phase.side,
      phase.phase,
      phase.runtime,
      "cancelled",
      "ACM_RUNNER_CANCELLED",
    );
  }

  private monitorPhaseTemp(
    task: DiffTask,
    side: Side,
    phase: Phase,
    runtime: PhaseRuntime,
  ): void {
    runtime.tempTimer = setInterval(() => {
      const directory = task.sides[side]?.dir;
      if (
        runtime.settled ||
        !directory ||
        !runtime.child ||
        !this.tempExceeded(directory)
      )
        return;
      runtime.forcedStatus = "output-limit";
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        "output-limit",
        "ACM_RUNNER_OUTPUT_LIMIT",
      );
    }, 100);
  }

  private bindPhaseEvents(
    task: DiffTask,
    side: Side,
    phase: Phase,
    executable: string,
    runtime: PhaseRuntime,
  ): void {
    const child = runtime.child as ChildProcess;
    child.stdout?.on("data", (chunk: Buffer | string) =>
      this.consumePhaseOutput(task, side, phase, runtime, "stdout", chunk),
    );
    child.stderr?.on("data", (chunk: Buffer | string) =>
      this.consumePhaseOutput(task, side, phase, runtime, "stderr", chunk),
    );
    const fail = (): void => {
      runtime.forcedStatus = "failed";
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        "failed",
        "ACM_RUNNER_FAILED",
      );
    };
    child.stdout?.once("error", fail);
    child.stderr?.once("error", fail);
    child.stdin?.once("error", () => undefined);
    child.once("error", fail);
    child.once("close", (code) =>
      this.closePhase(task, side, phase, executable, runtime, code),
    );
  }

  private consumePhaseOutput(
    task: DiffTask,
    side: Side,
    phase: Phase,
    runtime: PhaseRuntime,
    stream: "stdout" | "stderr",
    chunk: Buffer | string,
  ): void {
    if (runtime.settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const limit = this.limits[`${stream}Bytes`];
    const accepted = Math.min(
      buffer.byteLength,
      Math.max(0, limit - runtime.counts[stream]),
    );
    runtime.counts[stream] += accepted;
    const text = runtime.decoders[stream].write(buffer.subarray(0, accepted));
    if (phase === "run" && task.sides[side]) {
      if (stream === "stdout") task.sides[side]!.stdout += text;
      else task.sides[side]!.stderr += text;
    }
    if (accepted < buffer.byteLength) {
      runtime.forcedStatus = "output-limit";
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        "output-limit",
        "ACM_RUNNER_OUTPUT_LIMIT",
      );
      return;
    }
  }

  private flushPhaseOutput(
    task: DiffTask,
    side: Side,
    phase: Phase,
    runtime: PhaseRuntime,
  ): void {
    if (runtime.decodersFlushed) return;
    runtime.decodersFlushed = true;
    const stdoutTail = runtime.decoders.stdout.end();
    const stderrTail = runtime.decoders.stderr.end();
    if (phase !== "run" || !task.sides[side]) return;
    task.sides[side]!.stdout += stdoutTail;
    task.sides[side]!.stderr += stderrTail;
  }

  private closePhase(
    task: DiffTask,
    side: Side,
    phase: Phase,
    executable: string,
    runtime: PhaseRuntime,
    code: number | null,
  ): void {
    task.child = null;
    if (task.stopRequested && !runtime.forcedStatus) {
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        "cancelled",
        "ACM_RUNNER_CANCELLED",
      );
      return;
    }
    if (runtime.forcedStatus) {
      const code =
        runtime.forcedStatus === "failed"
          ? "ACM_RUNNER_FAILED"
          : runtime.forcedStatus === "timeout"
            ? "ACM_RUNNER_TIMEOUT"
            : "ACM_RUNNER_OUTPUT_LIMIT";
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        runtime.forcedStatus,
        code,
      );
      return;
    }
    if (code !== 0) {
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        "failed",
        "ACM_RUNNER_FAILED",
      );
      return;
    }
    if (this.tempExceeded(task.sides[side]?.dir ?? "")) {
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        "output-limit",
        "ACM_RUNNER_OUTPUT_LIMIT",
      );
      return;
    }
    if (phase === "compile" && !this.executableReady(executable)) {
      void this.finishPhase(
        task,
        side,
        phase,
        runtime,
        "failed",
        "ACM_RUNNER_FAILED",
      );
      return;
    }
    void this.finishPhase(task, side, phase, runtime, "completed");
  }

  private finishResult(task: DiffTask, result: AcmDiffResult): void {
    const referenceOutput = this.outputForSide(task, "reference");
    const candidateOutput = this.outputForSide(task, "candidate");
    const withOutputs: AcmDiffResult = {
      ...result,
      ...(referenceOutput ? { referenceOutput } : {}),
      ...(candidateOutput ? { candidateOutput } : {}),
    };
    const enriched: AcmDiffResult = task.cleanupWarnings.length
      ? { ...withOutputs, cleanupWarnings: [...task.cleanupWarnings] }
      : withOutputs;
    this.emit({
      taskId: task.id,
      side: "comparison",
      stage: "compare",
      status: result.status === "cancelled" ? "cancelled" : "completed",
      result: enriched,
      cleanupWarning: enriched.cleanupWarnings?.[0],
    });
  }

  private outputForSide(
    task: DiffTask,
    side: Side,
  ): AcmDiffProgramOutput | undefined {
    const value = task.sides[side];
    if (!value?.runStarted) return undefined;
    return { stdout: value.stdout, stderr: value.stderr };
  }

  private async cleanupExecutable(task: DiffTask, side: Side): Promise<void> {
    const executable = task.sides[side]?.executable;
    if (!executable) return;
    await this.cleanupPath(
      task,
      executable,
      `清理${side === "reference" ? "标准" : "待测"}程序失败`,
    );
  }

  private async cleanupTask(task: DiffTask): Promise<void> {
    for (const side of ["reference", "candidate"] as const) {
      const dir = task.sides[side]?.dir;
      if (dir) await this.cleanupPath(task, dir, "清理对拍临时目录失败");
    }
  }

  private async cleanupPath(
    task: DiffTask,
    target: string,
    label: string,
  ): Promise<void> {
    if (!this.isSafeCleanupTarget(target)) {
      task.cleanupWarnings.push(`${label}：路径不安全，未删除`);
      return;
    }
    try {
      this.removePath(target);
      if (!fs.existsSync(target)) return;
    } catch {
      // The warning is intentionally surfaced with the comparison result; the
      // retries below are best effort because Windows may hold an executable.
    }
    const warning = `${label}：${target}`;
    task.cleanupWarnings.push(warning);
    this.scheduleCleanupRetry(target);
  }

  private scheduleCleanupRetry(target: string): void {
    if (this.cleanupRetries === 0 || this.pendingCleanupRetries.has(target))
      return;
    const retry = this.retryCleanupPath(target);
    this.pendingCleanupRetries.set(target, retry);
    void retry.then(
      () => this.removePendingCleanupRetry(target, retry),
      () => this.removePendingCleanupRetry(target, retry),
    );
  }

  private async retryCleanupPath(target: string): Promise<void> {
    for (let attempt = 1; attempt <= this.cleanupRetries; attempt += 1) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, attempt * CLEANUP_RETRY_DELAY_MS),
      );
      if (!this.isSafeCleanupTarget(target)) return;
      try {
        this.removePath(target);
        if (!fs.existsSync(target)) return;
      } catch {
        // A later retry or next startup may release the file lock.
      }
    }
  }

  private removePendingCleanupRetry(
    target: string,
    retry: Promise<void>,
  ): void {
    if (this.pendingCleanupRetries.get(target) === retry)
      this.pendingCleanupRetries.delete(target);
  }

  private async terminate(task: DiffTask, child: ChildProcess): Promise<void> {
    if (!task.termination)
      task.termination = this.helper.terminate(child).finally(() => {
        task.termination = null;
      });
    await task.termination;
  }

  private emit(event: AcmDiffEvent): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...event });
      } catch {
        /* one listener must not interrupt cleanup */
      }
    }
  }

  private directoryBytes(directory: string): number {
    let total = 0;
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      if (this.isReparsePoint(current))
        throw new Error("临时目录包含 reparse point");
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (this.isReparsePoint(target))
          throw new Error("临时目录包含 reparse point");
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile()) total += fs.statSync(target).size;
        if (total > this.limits.tempBytes) return total;
      }
    }
    return total;
  }

  private isReparsePoint(target: string): boolean {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return true;
      if (this.platform !== "win32") return false;
      const actual = path.resolve(fs.realpathSync.native(target));
      const expected = path.resolve(target);
      return this.platform === "win32"
        ? actual.toLowerCase() !== expected.toLowerCase()
        : actual !== expected;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }

  private isSafeCleanupTarget(target: string): boolean {
    if (!this.isWithinRoot(target) || this.isReparsePoint(target)) return false;
    try {
      const stat = fs.lstatSync(target);
      return !stat.isDirectory() || !this.containsReparsePoint(target);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private containsReparsePoint(directory: string): boolean {
    const pending = [directory];
    try {
      while (pending.length > 0) {
        const current = pending.pop() as string;
        if (this.isReparsePoint(current)) return true;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const target = path.join(current, entry.name);
          if (this.isReparsePoint(target)) return true;
          if (entry.isDirectory()) pending.push(target);
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  private cleanupStaleTempDirectories(): void {
    const root = path.resolve(this.tempRoot);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.name.startsWith(TEMP_PREFIX) || !entry.isDirectory())
          continue;
        const target = path.resolve(root, entry.name);
        if (!this.isWithinRoot(target) || this.isReparsePoint(target)) continue;
        const marker = this.readOwnedMarker(target);
        const age = Date.now() - fs.statSync(target).mtimeMs;
        if (
          age < this.staleTempTtlMs ||
          !marker ||
          !this.isSafeCleanupTarget(target)
        )
          continue;
        fs.rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 50,
        });
      }
    } catch (error) {
      console.warn(`[acm-diff] 清理旧临时目录失败: ${String(error)}`);
    }
  }

  private readOwnedMarker(directory: string): { createdAt: number } | null {
    try {
      const marker = path.join(directory, ".college-toolkit-diff-owner.json");
      if (this.isReparsePoint(marker)) return null;
      const value = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        !(
          value.formatVersion === 1 &&
          value.kind === "temp-directory" &&
          value.owner === "college-student-toolkit-acm-diff" &&
          typeof value.createdAt === "number" &&
          Number.isFinite(value.createdAt)
        )
      )
        return null;
      return { createdAt: value.createdAt };
    } catch {
      return null;
    }
  }

  private isWithinRoot(target: string): boolean {
    const resolvedTarget = path.resolve(target);
    const resolvedRoot = path.resolve(this.tempRoot);
    const root = resolvedRoot + path.sep;
    const comparableTarget =
      this.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
    const comparableRoot =
      this.platform === "win32" ? root.toLowerCase() : root;
    return comparableTarget.startsWith(comparableRoot);
  }

  private executableReady(executable: string): boolean {
    try {
      const stat = fs.lstatSync(executable);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  private tempExceeded(directory: string): boolean {
    try {
      return this.directoryBytes(directory) > this.limits.tempBytes;
    } catch {
      return true;
    }
  }
}
export const acmDifferService = new AcmDifferService();
