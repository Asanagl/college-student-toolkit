import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RunnerSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type RunnerExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null) => void,
) => ChildProcess;

export interface RunnerProcessFactory {
  spawn: RunnerSpawn;
  execFile: RunnerExecFile;
}

const DEFAULT_TERMINATION_TIMEOUT_MS = 3_000;
const JOB_OBJECT_HELPER_NAME = "acm-job-runner.exe";

const defaultFactory: RunnerProcessFactory = {
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  execFile: (file, args, options, callback) =>
    nodeExecFile(file, args, options, (error) => callback(error)),
};

export function createAcmProcessEnvironment(
  command: string,
  runtimePath?: string | null,
): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  const commandDir = path.dirname(command);
  const pathEntries = [commandDir, runtimePath, system32].filter(
    (entry, index, values): entry is string =>
      typeof entry === "string" &&
      entry.trim().length > 0 &&
      entry !== "." &&
      values.indexOf(entry) === index,
  );
  const inheritedPath = process.env.PATH?.trim();
  const controlledPath = pathEntries.join(path.delimiter);
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: process.env.ComSpec?.trim() || path.join(system32, "cmd.exe"),
    TEMP: process.env.TEMP?.trim() || os.tmpdir(),
    TMP: process.env.TMP?.trim() || os.tmpdir(),
    // Keep the user's existing search path intact; controlled directories are appended.
    PATH: [inheritedPath, controlledPath].filter(Boolean).join(path.delimiter),
    LANG: "C",
    LC_ALL: "C",
  };
}

function systemExecutable(name: string): string {
  const root = process.env.SystemRoot?.trim() || "C:\\Windows";
  return path.join(root, "System32", name);
}

function defaultJobObjectExecutable(platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  const processWithResources = process as NodeJS.Process & {
    resourcesPath?: string;
  };
  const resourcesPath = processWithResources.resourcesPath?.trim();
  if (!resourcesPath) return null;
  const candidate = path.join(resourcesPath, JOB_OBJECT_HELPER_NAME);
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Owns process creation and process-tree termination for the ACM runner.
 * Keeping this boundary small lets the native Job Object helper replace the
 * taskkill fallback without changing runner state or IPC behavior.
 */
export class AcmRunnerHelper {
  constructor(
    private readonly factory: RunnerProcessFactory = defaultFactory,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly terminationTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
    private readonly jobObjectExecutable:
      | string
      | null = defaultJobObjectExecutable(platform),
  ) {}

  spawn(
    command: string,
    args: string[],
    cwd: string,
    stdio:
      | readonly ["ignore", "pipe", "pipe"]
      | readonly ["pipe", "pipe", "pipe"],
    runtimePath?: string | null,
  ): ChildProcess {
    const helper = this.platform === "win32" ? this.jobObjectExecutable : null;
    const launchCommand = helper ?? command;
    const launchArgs = helper ? [command, ...args] : args;
    return this.factory.spawn(launchCommand, launchArgs, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: [...stdio],
      env: createAcmProcessEnvironment(command, runtimePath),
    });
  }

  async terminate(child: ChildProcess): Promise<void> {
    if (this.hasExited(child)) return;
    if (this.platform === "win32" && child.pid)
      return this.terminateWindowsTree(child.pid, child);
    this.forceKill(child);
    await this.requireChildExit(child);
  }

  private terminateWindowsTree(
    pid: number,
    child: ChildProcess,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let waitStarted = false;
      let killer: ChildProcess | null = null;
      const childExit = this.waitForChildExit(child);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const waitForExit = (): void => {
        if (waitStarted || settled) return;
        waitStarted = true;
        void childExit.then((exited) => {
          if (exited) finish();
          else finish(new Error("ACM runner 子进程未确认退出"));
        });
      };
      const timer = setTimeout(() => {
        this.stopProcess(killer);
        this.forceKill(child);
        waitForExit();
      }, this.terminationTimeoutMs);

      try {
        killer = this.factory.execFile(
          systemExecutable("taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          {
            windowsHide: true,
            shell: false,
            env: createAcmProcessEnvironment(systemExecutable("taskkill.exe")),
          },
          (error) => {
            if (error) this.forceKill(child);
            waitForExit();
          },
        );
        killer.once("error", () => {
          this.forceKill(child);
          waitForExit();
        });
      } catch {
        this.forceKill(child);
        waitForExit();
      }
    });
  }

  private waitForChildExit(child: ChildProcess): Promise<boolean> {
    if (this.hasExited(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const onClose = (): void => finish(true);
      const timer = setTimeout(() => {
        finish(this.hasExited(child));
      }, this.terminationTimeoutMs);
      child.once("exit", onExit);
      child.once("close", onClose);
    });
  }

  private async requireChildExit(child: ChildProcess): Promise<void> {
    if (await this.waitForChildExit(child)) return;
    throw new Error("ACM runner 子进程未确认退出");
  }

  private hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  private forceKill(child: ChildProcess): boolean {
    try {
      return child.kill(this.platform === "win32" ? undefined : "SIGKILL");
    } catch {
      // The process may have exited between the state check and kill call.
      return false;
    }
  }

  private stopProcess(child: ChildProcess | null): void {
    if (!child) return;
    try {
      child.kill();
    } catch {
      // taskkill may already have exited before its fallback is attempted.
    }
  }
}

export const acmRunnerHelper = new AcmRunnerHelper();
