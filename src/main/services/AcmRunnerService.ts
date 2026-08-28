import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type {
  CompilerProbeResult,
  IpcErrorCode,
  IpcResult,
  RunnerEvent,
  RunnerLimits,
  RunnerStartRequest,
  RunnerStage,
} from "../../shared/types";
import { acmCompilerService } from "./AcmCompilerService";
import { AcmRunnerHelper, acmRunnerHelper } from "./AcmRunnerHelper";

export const ACM_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = {
  compileTimeoutMs: 30_000,
  runTimeoutMs: 3_000,
  stdinBytes: 256 * 1024,
  stdoutBytes: 4 * 1024 * 1024,
  stderrBytes: 4 * 1024 * 1024,
  tempBytes: 128 * 1024 * 1024,
};

const requestSchema = z.object({
  documentId: z.string().trim().min(1).max(128),
  source: z.string(),
  stdin: z.string(),
  mode: z.enum(["compile", "run"]),
});

export interface AcmRunnerCompiler {
  probe(): Promise<IpcResult<CompilerProbeResult>>;
  getCompilerFlags(): string[];
  getCached?(): CompilerProbeResult | null;
}

export interface AcmRunnerServiceOptions {
  compiler?: AcmRunnerCompiler;
  helper?: AcmRunnerHelper;
  platform?: NodeJS.Platform;
  tempRoot?: string;
  limits?: Partial<RunnerLimits>;
}

type RunnerConstructor = AcmRunnerServiceOptions | AcmRunnerCompiler;

type Phase = "compile" | "run";
type StopReason = "cancelled" | "timeout" | "output-limit";

interface RunnerTask {
  id: string;
  request: RunnerStartRequest;
  phase: Phase | "preparing";
  tempDir: string | null;
  child: ChildProcess | null;
  stopRequested: boolean;
  phaseReason: StopReason | null;
  done: Promise<void> | null;
}

interface ProcessOutcome {
  status: "completed" | "failed" | "cancelled" | "timeout" | "output-limit";
  exitCode: number | null;
  errorCode?: IpcErrorCode;
  error?: string;
  durationMs: number;
}

class RunnerFailure extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunnerFailure";
  }
}

function errorResult<T>(
  errorCode: IpcResult<T>["errorCode"],
  error: string,
): IpcResult<T> {
  return { ok: false, errorCode, error };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stageFor(phase: Phase, finished: boolean): RunnerStage {
  if (phase === "compile")
    return finished ? "compile-finished" : "compile-started";
  return finished ? "run-finished" : "run-started";
}

function phaseLabel(phase: Phase): string {
  return phase === "compile" ? "编译" : "运行";
}

export class AcmRunnerService {
  private readonly compiler: AcmRunnerCompiler;
  private readonly helper: AcmRunnerHelper;
  private readonly platform: NodeJS.Platform;
  private readonly tempRoot: string;
  private readonly limits: RunnerLimits;
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private active: RunnerTask | null = null;
  private initialized = false;

  constructor(compiler?: AcmRunnerCompiler);
  constructor(options?: AcmRunnerServiceOptions);
  constructor(optionsOrCompiler: RunnerConstructor = {}) {
    const options: AcmRunnerServiceOptions =
      "probe" in optionsOrCompiler
        ? { compiler: optionsOrCompiler }
        : optionsOrCompiler;
    this.compiler = options.compiler ?? acmCompilerService;
    this.helper = options.helper ?? acmRunnerHelper;
    this.platform = options.platform ?? process.platform;
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.limits = { ...DEFAULT_RUNNER_LIMITS, ...options.limits };
  }

  async init(): Promise<void> {
    this.initialized = true;
  }

  onEvent(callback: (event: RunnerEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async start(
    request: RunnerStartRequest,
  ): Promise<IpcResult<{ taskId: string }>> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success)
      return errorResult("VALIDATION_FAILED", "运行请求无效");
    const checked = this.validateRequest(parsed.data);
    if (!checked.ok) return checked;
    if (this.platform !== "win32")
      return errorResult("ACM_UNSUPPORTED", "ACM runner 仅支持 Windows");
    if (this.active)
      return errorResult("ACM_RUNNER_BUSY", "已有编译或运行任务正在执行");

    const task: RunnerTask = {
      id: randomUUID(),
      request: parsed.data,
      phase: "preparing",
      tempDir: null,
      child: null,
      stopRequested: false,
      phaseReason: null,
      done: null,
    };
    this.active = task;
    try {
      const compilerPath = await this.resolveCompiler();
      if (this.active !== task)
        return errorResult("ACM_RUNNER_CANCELLED", "运行任务已取消");
      if (task.stopRequested) {
        await this.finishPreparingTask(task);
        return { ok: true, data: { taskId: task.id } };
      }
      task.tempDir = fs.mkdtempSync(
        path.join(this.tempRoot, "college-toolkit-runner-"),
      );
      this.writeSource(task);
      task.done = this.execute(task, compilerPath);
      void task.done;
      return { ok: true, data: { taskId: task.id } };
    } catch (error) {
      await this.failBeforeExecution(task);
      return this.failureResult(error);
    }
  }

  async stop(): Promise<IpcResult<boolean>> {
    const task = this.active;
    if (!task) return { ok: true, data: false };
    task.stopRequested = true;
    if (task.child) {
      task.phaseReason ??= "cancelled";
      try {
        await this.helper.terminate(task.child);
      } catch (error) {
        return errorResult(
          "ACM_RUNNER_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { ok: true, data: true };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    const task = this.active;
    if (!task) {
      this.listeners.clear();
      return;
    }
    await this.stop();
    if (task.done) await task.done;
    else await this.finishPreparingTask(task);
    this.listeners.clear();
  }

  private validateRequest(
    request: RunnerStartRequest,
  ): IpcResult<{ taskId: string }> | { ok: true } {
    if (byteLength(request.source) > ACM_MAX_SOURCE_BYTES)
      return errorResult("ACM_FILE_TOO_LARGE", "源码超过 2 MiB 限制");
    if (byteLength(request.stdin) > this.limits.stdinBytes)
      return errorResult("VALIDATION_FAILED", "标准输入超过 256 KiB 限制");
    return { ok: true };
  }

  private async resolveCompiler(): Promise<string> {
    const cached = this.compiler.getCached?.();
    if (cached?.available && cached.path) return cached.path;
    const result = await this.compiler.probe();
    if (!result.ok || !result.data)
      throw new RunnerFailure(
        result.errorCode ?? "ACM_COMPILER_INVALID",
        result.error ?? "编译器探测失败",
      );
    if (!result.data.available || !result.data.path)
      throw new RunnerFailure(
        "ACM_COMPILER_MISSING",
        result.data.reason ?? "没有找到可用的 x64 MinGW g++",
      );
    return result.data.path;
  }

  private writeSource(task: RunnerTask): void {
    if (!task.tempDir)
      throw new RunnerFailure("ACM_RUNNER_FAILED", "临时目录未创建");
    const sourcePath = path.join(task.tempDir, "main.cpp");
    fs.writeFileSync(sourcePath, task.request.source, {
      encoding: "utf8",
      flag: "wx",
    });
    this.assertTempSize(task.tempDir);
  }

  private async execute(task: RunnerTask, compilerPath: string): Promise<void> {
    try {
      const compile = await this.runPhase(task, "compile", compilerPath);
      if (compile.status !== "completed") return;
      if (task.request.mode === "compile") return;
      await this.runPhase(
        task,
        "run",
        path.join(task.tempDir as string, "program.exe"),
      );
    } catch (error) {
      const phase = task.phase === "preparing" ? "compile" : task.phase;
      this.emitFinished(task, phase, this.unexpectedOutcome(error));
    } finally {
      await this.cleanupTask(task);
    }
  }

  private async runPhase(
    task: RunnerTask,
    phase: Phase,
    command: string,
  ): Promise<ProcessOutcome> {
    task.phase = phase;
    task.phaseReason = null;
    const startedAt = Date.now();
    this.emitStarted(task, phase);
    if (task.stopRequested) {
      const outcome = this.cancelledOutcome(startedAt);
      this.emitFinished(task, phase, outcome);
      return outcome;
    }
    let child: ChildProcess;
    try {
      child = this.spawnPhase(task, phase, command);
      task.child = child;
    } catch (error) {
      const outcome = this.unexpectedOutcome(error, startedAt);
      this.emitFinished(task, phase, outcome);
      return outcome;
    }
    const outcome = await this.waitForChild(task, phase, child, startedAt);
    task.child = null;
    if (outcome.status === "completed" && phase === "compile") {
      try {
        this.assertExecutable(task);
        this.assertTempSize(task.tempDir as string);
      } catch (error) {
        const failed = this.unexpectedOutcome(error, startedAt);
        this.emitFinished(task, phase, failed);
        return failed;
      }
    }
    this.emitFinished(task, phase, outcome);
    return outcome;
  }

  private emitStarted(task: RunnerTask, phase: Phase): void {
    this.emit({
      taskId: task.id,
      documentId: task.request.documentId,
      stage: stageFor(phase, false),
      status: "started",
    });
  }

  private spawnPhase(
    task: RunnerTask,
    phase: Phase,
    command: string,
  ): ChildProcess {
    const args = this.phaseArguments(task, phase);
    const stdio =
      phase === "compile"
        ? (["ignore", "pipe", "pipe"] as const)
        : (["pipe", "pipe", "pipe"] as const);
    return this.helper.spawn(command, args, task.tempDir as string, stdio);
  }

  private phaseArguments(task: RunnerTask, phase: Phase): string[] {
    if (phase === "run") return [];
    return [
      ...this.compiler.getCompilerFlags(),
      path.join(task.tempDir as string, "main.cpp"),
      "-o",
      path.join(task.tempDir as string, "program.exe"),
    ];
  }

  private waitForChild(
    task: RunnerTask,
    phase: Phase,
    child: ChildProcess,
    startedAt: number,
  ): Promise<ProcessOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const decoders = {
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
      };
      const byteCounts = { stdout: 0, stderr: 0 };
      const finish = (exitCode: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(tempTimer);
        this.emitDecoderTails(task, decoders);
        resolve(this.outcome(task, exitCode, error, startedAt));
      };
      const timer = setTimeout(() => {
        if (task.phaseReason) return;
        task.phaseReason = "timeout";
        void this.helper.terminate(child).catch(() => undefined);
      }, this.timeoutFor(phase));
      const tempTimer = setInterval(() => {
        if (task.phaseReason || !task.tempDir) return;
        if (!this.tempDirectoryExceeded(task)) return;
        task.phaseReason = "output-limit";
        void this.helper.terminate(child).catch(() => undefined);
      }, 100);
      child.stdout?.on("data", (chunk: Buffer | string) =>
        this.consumeOutput(task, child, "stdout", chunk, byteCounts, decoders),
      );
      child.stderr?.on("data", (chunk: Buffer | string) =>
        this.consumeOutput(task, child, "stderr", chunk, byteCounts, decoders),
      );
      const failStream = (error: Error): void => {
        void this.helper.terminate(child).catch(() => undefined);
        finish(null, error);
      };
      child.stdout?.once("error", failStream);
      child.stderr?.once("error", failStream);
      child.stdin?.once("error", () => undefined);
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) =>
        finish(typeof code === "number" ? code : null),
      );
      if (task.stopRequested) {
        task.phaseReason ??= "cancelled";
        void this.helper.terminate(child).catch(() => undefined);
      }
      if (phase === "run" && child.stdin) {
        child.stdin.end(Buffer.from(task.request.stdin, "utf8"));
      }
    });
  }

  private consumeOutput(
    task: RunnerTask,
    child: ChildProcess,
    stream: "stdout" | "stderr",
    chunk: Buffer | string,
    byteCounts: { stdout: number; stderr: number },
    decoders: { stdout: StringDecoder; stderr: StringDecoder },
  ): void {
    if (task.phaseReason) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const limit = this.limits[`${stream}Bytes`];
    const remaining = Math.max(0, limit - byteCounts[stream]);
    const accepted = buffer.subarray(0, remaining);
    byteCounts[stream] += accepted.byteLength;
    const text = decoders[stream].write(accepted);
    if (text)
      this.emit({
        taskId: task.id,
        documentId: task.request.documentId,
        stage: stageFor(task.phase as Phase, false),
        stream,
        text,
        status: "data",
      });
    if (accepted.byteLength < buffer.byteLength) {
      task.phaseReason = "output-limit";
      void this.helper.terminate(child).catch(() => undefined);
    }
  }

  private emitDecoderTails(
    task: RunnerTask,
    decoders: { stdout: StringDecoder; stderr: StringDecoder },
  ): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const text = decoders[stream].end();
      if (text)
        this.emit({
          taskId: task.id,
          documentId: task.request.documentId,
          stage: stageFor(task.phase as Phase, false),
          stream,
          text,
          status: "data",
        });
    }
  }

  private outcome(
    task: RunnerTask,
    exitCode: number | null,
    error: Error | undefined,
    startedAt: number,
  ): ProcessOutcome {
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (task.phaseReason === "output-limit")
      return {
        status: "output-limit",
        exitCode,
        errorCode: "ACM_RUNNER_OUTPUT_LIMIT",
        durationMs,
      };
    if (task.phaseReason === "timeout")
      return {
        status: "timeout",
        exitCode,
        errorCode: "ACM_RUNNER_TIMEOUT",
        durationMs,
      };
    if (task.phaseReason === "cancelled" || task.stopRequested)
      return {
        status: "cancelled",
        exitCode,
        errorCode: "ACM_RUNNER_CANCELLED",
        durationMs,
      };
    if (error)
      return {
        status: "failed",
        exitCode,
        errorCode: "ACM_RUNNER_FAILED",
        error: error.message,
        durationMs,
      };
    if (exitCode === 0) return { status: "completed", exitCode, durationMs };
    return {
      status: "failed",
      exitCode,
      errorCode: "ACM_RUNNER_FAILED",
      durationMs,
    };
  }

  private cancelledOutcome(startedAt: number): ProcessOutcome {
    return {
      status: "cancelled",
      exitCode: null,
      errorCode: "ACM_RUNNER_CANCELLED",
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  private unexpectedOutcome(
    error: unknown,
    startedAt = Date.now(),
  ): ProcessOutcome {
    const known = error instanceof RunnerFailure ? error : null;
    return {
      status: "failed",
      exitCode: null,
      errorCode: known?.code ?? "ACM_RUNNER_FAILED",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  private emitFinished(
    task: RunnerTask,
    phase: Phase,
    outcome: ProcessOutcome,
  ): void {
    this.emit({
      taskId: task.id,
      documentId: task.request.documentId,
      stage: stageFor(phase, true),
      status: outcome.status,
      exitCode: outcome.exitCode,
      errorCode: outcome.errorCode,
      durationMs: outcome.durationMs,
    });
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...event });
      } catch {
        // One renderer listener must not interrupt process cleanup or others.
      }
    }
  }

  private timeoutFor(phase: Phase): number {
    return phase === "compile"
      ? this.limits.compileTimeoutMs
      : this.limits.runTimeoutMs;
  }

  private assertExecutable(task: RunnerTask): void {
    const executable = path.join(task.tempDir as string, "program.exe");
    const stat = fs.lstatSync(executable);
    if (!stat.isFile() || stat.size === 0)
      throw new RunnerFailure("ACM_RUNNER_FAILED", "编译器没有生成可运行程序");
  }

  private assertTempSize(directory: string): void {
    const total = this.directoryBytes(directory);
    if (total > this.limits.tempBytes)
      throw new RunnerFailure(
        "ACM_RUNNER_OUTPUT_LIMIT",
        "临时构建目录超过大小限制",
      );
  }

  private tempDirectoryExceeded(task: RunnerTask): boolean {
    try {
      return (
        this.directoryBytes(task.tempDir as string) > this.limits.tempBytes
      );
    } catch {
      return true;
    }
  }

  private directoryBytes(directory: string): number {
    let total = 0;
    const pending = [directory];
    while (pending.length) {
      const current = pending.pop() as string;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile()) total += fs.statSync(target).size;
        else
          throw new RunnerFailure(
            "ACM_RUNNER_FAILED",
            "临时构建目录包含不支持的文件类型",
          );
        if (total > this.limits.tempBytes) return total;
      }
    }
    return total;
  }

  private async failBeforeExecution(task: RunnerTask): Promise<void> {
    await this.cleanupTask(task);
    if (this.active === task) this.active = null;
  }

  private async finishPreparingTask(task: RunnerTask): Promise<void> {
    if (this.active !== task) return;
    task.phaseReason = "cancelled";
    this.emit({
      taskId: task.id,
      documentId: task.request.documentId,
      stage: "compile-started",
      status: "started",
    });
    this.emitFinished(task, "compile", this.cancelledOutcome(Date.now()));
    await this.cleanupTask(task);
  }

  private async cleanupTask(task: RunnerTask): Promise<void> {
    task.child = null;
    if (!task.tempDir) {
      if (this.active === task) this.active = null;
      return;
    }
    const directory = task.tempDir;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          fs.rmSync(directory, {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 50,
          });
          if (!fs.existsSync(directory)) break;
        } catch {
          if (attempt === 1) break;
        }
      }
      if (fs.existsSync(directory))
        console.warn(`[acm-runner] 临时目录清理将在下次启动重试: ${directory}`);
    } finally {
      task.tempDir = null;
      if (this.active === task) this.active = null;
    }
  }

  private failureResult(error: unknown): IpcResult<{ taskId: string }> {
    if (error instanceof RunnerFailure)
      return errorResult(error.code, error.message);
    return errorResult(
      "ACM_RUNNER_FAILED",
      `${phaseLabel(this.active?.phase === "run" ? "run" : "compile")}失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const acmRunnerService = new AcmRunnerService();
