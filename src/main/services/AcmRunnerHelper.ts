import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";

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

const defaultFactory: RunnerProcessFactory = {
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  execFile: (file, args, options, callback) =>
    nodeExecFile(file, args, options, (error) => callback(error)),
};

/**
 * Owns process creation and process-tree termination for the ACM runner.
 * Keeping this boundary small lets the native Job Object helper replace the
 * taskkill fallback without changing runner state or IPC behavior.
 */
export class AcmRunnerHelper {
  constructor(
    private readonly factory: RunnerProcessFactory = defaultFactory,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  spawn(
    command: string,
    args: string[],
    cwd: string,
    stdio:
      | readonly ["ignore", "pipe", "pipe"]
      | readonly ["pipe", "pipe", "pipe"],
  ): ChildProcess {
    return this.factory.spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: [...stdio],
    });
  }

  async terminate(child: ChildProcess): Promise<void> {
    if (!child.pid) {
      this.forceKill(child);
      return;
    }
    if (this.platform !== "win32") {
      this.forceKill(child);
      return;
    }
    await this.terminateWindowsTree(child.pid, child);
  }

  private terminateWindowsTree(
    pid: number,
    child: ChildProcess,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let killer: ChildProcess | null = null;
      const timer = setTimeout(() => {
        killer?.kill();
        this.forceKill(child);
        finish();
      }, 3000);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      try {
        killer = this.factory.execFile(
          "taskkill.exe",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, shell: false },
          () => finish(),
        );
        killer.once("error", () => {
          this.forceKill(child);
          finish();
        });
      } catch {
        this.forceKill(child);
        finish();
      }
    });
  }

  private forceKill(child: ChildProcess): void {
    try {
      child.kill(this.platform === "win32" ? undefined : "SIGKILL");
    } catch {
      // The process may have exited between the state check and kill call.
    }
  }
}

export const acmRunnerHelper = new AcmRunnerHelper();
