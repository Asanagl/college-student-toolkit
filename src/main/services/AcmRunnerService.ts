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

export const ACM_RUNNER_TEMP_TTL_MS = 24 * 60 * 60 * 1000;
const RUNNER_TEMP_PREFIX = "college-toolkit-runner-";
const RUNNER_OWNER_FILE = ".college-toolkit-runner-owner.json";
const RUNNER_OWNER = "college-student-toolkit-acm";
const DEFAULT_TEMP_ROOT = path.join(os.tmpdir(), "college-student-toolkit-acm");

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
  staleTempTtlMs?: number;
  limits?: Partial<RunnerLimits>;
  writeFile?: RunnerTextWriter;
}

type RunnerConstructor = AcmRunnerServiceOptions | AcmRunnerCompiler;
type RunnerTextWriter = (
  filePath: string,
  data: string,
  options: { encoding: "utf8"; flag: "wx" },
) => void;

type Phase = "compile" | "run";
type StopReason = "cancelled" | "timeout" | "output-limit";

interface RunnerTask {
  id: string;
  request: RunnerStartRequest;
  phase: Phase | "preparing";
  tempDir: string | null;
  runtimePath: string | null;
  child: ChildProcess | null;
  stopRequested: boolean;
  phaseReason: StopReason | null;
  termination: Promise<void> | null;
  cleanupBlocked: boolean;
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

function isResourceWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EFBIG" || code === "EDQUOT";
}

function stageFor(phase: Phase, finished: boolean): RunnerStage {
  if (phase === "compile")
    return finished ? "compile-finished" : "compile-started";
  return finished ? "run-finished" : "run-started";
}

function phaseLabel(phase: Phase): string {
  return phase === "compile" ? "编译" : "运行";
}

function comparablePath(value: string): string {
  return path
    .resolve(value)
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isReparsePoint(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return true;
    if (platform !== "win32") return false;
    return (
      comparablePath(fs.realpathSync.native(filePath)) !==
      comparablePath(filePath)
    );
  } catch {
    return true;
  }
}

export class AcmRunnerService {
  private readonly compiler: AcmRunnerCompiler;
  private readonly helper: AcmRunnerHelper;
  private readonly platform: NodeJS.Platform;
  private readonly tempRoot: string;
  private readonly staleTempTtlMs: number;
  private readonly instanceId = randomUUID();
  private readonly limits: RunnerLimits;
  private readonly writeFile: RunnerTextWriter;
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
    this.tempRoot = path.resolve(options.tempRoot ?? DEFAULT_TEMP_ROOT);
    this.staleTempTtlMs = Math.max(
      1,
      options.staleTempTtlMs ?? ACM_RUNNER_TEMP_TTL_MS,
    );
    this.limits = { ...DEFAULT_RUNNER_LIMITS, ...options.limits };
    this.writeFile =
      options.writeFile ??
      ((target, data, writeOptions) =>
        fs.writeFileSync(target, data, writeOptions));
  }

  async init(): Promise<void> {
    this.ensureTempRoot();
    this.cleanupStaleTempDirectories();
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
    if (!this.initialized)
      return errorResult("ACM_PLUGIN_INVALID", "ACM runner 尚未初始化");
    if (this.active)
      return errorResult("ACM_RUNNER_BUSY", "已有编译或运行任务正在执行");

    const task: RunnerTask = {
      id: randomUUID(),
      request: parsed.data,
      phase: "preparing",
      tempDir: null,
      runtimePath: null,
      child: null,
      stopRequested: false,
      phaseReason: null,
      termination: null,
      cleanupBlocked: false,
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
      task.runtimePath = path.dirname(compilerPath);
      task.tempDir = this.createTaskTempDirectory(task);
      this.writeSource(task);
      task.done = this.scheduleExecution(task, compilerPath);
      void task.done;
      return { ok: true, data: { taskId: task.id } };
    } catch (error) {
      await this.failBeforeExecution(task);
      return this.failureResult(error);
    }
  }

  async stop(): Promise<IpcResult<boolean>> {
    if (!this.initialized)
      return errorResult("ACM_PLUGIN_INVALID", "ACM runner 尚未初始化");
    return this.stopActiveTask();
  }

  private async stopActiveTask(): Promise<IpcResult<boolean>> {
    const task = this.active;
    if (!task) return { ok: true, data: false };
    task.stopRequested = true;
    if (task.child) {
      task.phaseReason ??= "cancelled";
      try {
        await this.terminateChild(task, task.child);
      } catch (error) {
        return errorResult(
          "ACM_RUNNER_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (task.done) await task.done;
    return { ok: true, data: true };
  }

  async dispose(): Promise<void> {
    const task = this.active;
    if (task) {
      const stopped = await this.stopActiveTask();
      if (!stopped.ok)
        console.warn(`[acm-runner] 释放时终止子进程失败: ${stopped.error}`);
      else if (task.done) await task.done;
      else await this.finishPreparingTask(task);
    }
    this.initialized = false;
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
    try {
      this.writeFile(sourcePath, task.request.source, {
        encoding: "utf8",
        flag: "wx",
      });
      this.assertTempSize(task.tempDir);
    } catch (error) {
      if (isResourceWriteError(error))
        throw new RunnerFailure(
          "ACM_RUNNER_OUTPUT_LIMIT",
          "源码写入超过临时构建目录限制",
        );
      throw error;
    } finally {
      // The source is needed only until staging completes; releasing it also
      // bounds how long a failed write retains a second V8 string copy.
      task.request = { ...task.request, source: "" };
    }
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

  private scheduleExecution(
    task: RunnerTask,
    compilerPath: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      // Let the IPC response publish taskId before a fast child can emit a terminal event.
      setImmediate(() => {
        void this.execute(task, compilerPath).then(resolve, resolve);
      });
    });
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
    if (outcome.status === "completed") {
      try {
        if (phase === "compile") this.assertExecutable(task);
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
    task.termination = null;
    const args = this.phaseArguments(task, phase);
    const stdio =
      phase === "compile"
        ? (["ignore", "pipe", "pipe"] as const)
        : (["pipe", "pipe", "pipe"] as const);
    return this.helper.spawn(
      command,
      args,
      task.tempDir as string,
      stdio,
      task.runtimePath,
    );
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
      let terminationError: Error | undefined;
      const finish = async (
        exitCode: number | null,
        error?: Error,
        exitConfirmed = false,
      ): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(tempTimer);
        if (error || task.phaseReason) {
          try {
            await this.terminateChild(task, child);
          } catch (terminationFailure) {
            if (!exitConfirmed) task.cleanupBlocked = true;
            const value =
              terminationFailure instanceof Error
                ? terminationFailure
                : new Error(String(terminationFailure));
            error ??= value;
            if (!exitConfirmed) terminationError = value;
          }
        }
        this.emitDecoderTails(task, decoders);
        const result = this.outcome(task, exitCode, error, startedAt);
        if (terminationError && !exitConfirmed) {
          result.status = "failed";
          result.exitCode = exitCode;
          result.errorCode = "ACM_RUNNER_FAILED";
          result.error = terminationError.message;
        }
        resolve(result);
      };
      const timer = setTimeout(() => {
        if (task.phaseReason) return;
        task.phaseReason = "timeout";
        void this.terminateChild(task, child).catch(() => undefined);
      }, this.timeoutFor(phase));
      const tempTimer = setInterval(() => {
        if (task.phaseReason || !task.tempDir) return;
        if (!this.tempDirectoryExceeded(task)) return;
        task.phaseReason = "output-limit";
        void this.terminateChild(task, child).catch(() => undefined);
      }, 100);
      child.stdout?.on("data", (chunk: Buffer | string) =>
        this.consumeOutput(task, child, "stdout", chunk, byteCounts, decoders),
      );
      child.stderr?.on("data", (chunk: Buffer | string) =>
        this.consumeOutput(task, child, "stderr", chunk, byteCounts, decoders),
      );
      const failStream = (error: Error): void => {
        void finish(null, error);
      };
      child.stdout?.once("error", failStream);
      child.stderr?.once("error", failStream);
      child.stdin?.once("error", () => undefined);
      child.once("error", (error) => void finish(null, error));
      child.once(
        "close",
        (code) =>
          void finish(typeof code === "number" ? code : null, undefined, true),
      );
      if (task.stopRequested) {
        task.phaseReason ??= "cancelled";
        void this.terminateChild(task, child).catch(() => undefined);
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
      void this.terminateChild(task, child).catch(() => undefined);
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
      status:
        known?.code === "ACM_RUNNER_OUTPUT_LIMIT" ? "output-limit" : "failed",
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
      if (isReparsePoint(current, this.platform))
        throw new RunnerFailure(
          "ACM_RUNNER_FAILED",
          "临时构建目录包含不支持的 reparse point",
        );
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (isReparsePoint(target, this.platform))
          throw new RunnerFailure(
            "ACM_RUNNER_FAILED",
            "临时构建目录包含不支持的 reparse point",
          );
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

  private cleanupStaleTempDirectories(): void {
    try {
      if (!fs.existsSync(this.tempRoot)) return;
      const root = path.resolve(this.tempRoot);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.name.startsWith(RUNNER_TEMP_PREFIX)) continue;
        const target = path.join(root, entry.name);
        if (!entry.isDirectory() || isReparsePoint(target, this.platform))
          continue;
        const owner = this.readOwnerMetadata(target);
        if (!owner || !this.isExpiredOwner(owner)) continue;
        if (this.containsReparsePoint(target)) continue;
        fs.rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 50,
        });
      }
    } catch (error) {
      console.warn(`[acm-runner] 启动时清理旧临时目录失败: ${String(error)}`);
    }
  }

  private ensureTempRoot(): void {
    fs.mkdirSync(this.tempRoot, { recursive: true });
    if (isReparsePoint(this.tempRoot, this.platform))
      throw new RunnerFailure(
        "ACM_RUNNER_FAILED",
        "ACM runner 临时根目录不能是 reparse point",
      );
    const stat = fs.lstatSync(this.tempRoot);
    if (!stat.isDirectory())
      throw new RunnerFailure("ACM_RUNNER_FAILED", "ACM runner 临时根目录无效");
  }

  private createTaskTempDirectory(task: RunnerTask): string {
    let directory: string;
    try {
      directory = fs.mkdtempSync(path.join(this.tempRoot, RUNNER_TEMP_PREFIX));
    } catch (error) {
      if (isResourceWriteError(error))
        throw new RunnerFailure(
          "ACM_RUNNER_OUTPUT_LIMIT",
          "无法创建临时构建目录",
        );
      throw error;
    }
    // Register immediately so marker-write failures can use the normal
    // cleanup path instead of leaking an unowned directory.
    task.tempDir = directory;
    const metadata = {
      formatVersion: 1,
      owner: RUNNER_OWNER,
      instanceId: this.instanceId,
      pid: process.pid,
      createdAt: Date.now(),
      taskId: task.id,
    };
    try {
      this.writeFile(
        path.join(directory, RUNNER_OWNER_FILE),
        `${JSON.stringify(metadata)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if (isResourceWriteError(error))
        throw new RunnerFailure(
          "ACM_RUNNER_OUTPUT_LIMIT",
          "无法写入临时构建目录标记",
        );
      throw error;
    }
    return directory;
  }

  private readOwnerMetadata(directory: string): {
    owner: string;
    createdAt: number;
  } | null {
    const marker = path.join(directory, RUNNER_OWNER_FILE);
    try {
      if (isReparsePoint(marker, this.platform)) return null;
      const value: unknown = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (!value || typeof value !== "object") return null;
      const metadata = value as Record<string, unknown>;
      if (
        metadata.formatVersion !== 1 ||
        metadata.owner !== RUNNER_OWNER ||
        typeof metadata.createdAt !== "number" ||
        !Number.isFinite(metadata.createdAt)
      )
        return null;
      return {
        owner: metadata.owner,
        createdAt: metadata.createdAt,
      };
    } catch {
      return null;
    }
  }

  private isExpiredOwner(owner: { createdAt: number }): boolean {
    const age = Date.now() - owner.createdAt;
    return age >= this.staleTempTtlMs && age < Number.MAX_SAFE_INTEGER;
  }

  private containsReparsePoint(directory: string): boolean {
    const pending = [directory];
    try {
      while (pending.length) {
        const current = pending.pop() as string;
        if (isReparsePoint(current, this.platform)) return true;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const target = path.join(current, entry.name);
          if (isReparsePoint(target, this.platform)) return true;
          if (entry.isDirectory()) pending.push(target);
        }
      }
      return false;
    } catch {
      return true;
    }
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
    task.termination = null;
    if (!task.tempDir) {
      if (this.active === task) this.active = null;
      return;
    }
    const directory = task.tempDir;
    try {
      if (task.cleanupBlocked || this.containsReparsePoint(directory)) {
        console.warn(
          `[acm-runner] 临时目录包含未清理资源，保留供恢复: ${directory}`,
        );
        return;
      }
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

  private terminateChild(task: RunnerTask, child: ChildProcess): Promise<void> {
    if (!task.termination) {
      const termination = this.helper.terminate(child).catch((error) => {
        if (task.termination === termination) task.termination = null;
        throw error;
      });
      task.termination = termination;
    }
    return task.termination;
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
