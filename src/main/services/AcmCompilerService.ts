import { app } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  CompilerProbeResult,
  CompilerSelection,
  IpcResult,
} from "../../shared/types";

const execFileAsync = promisify(execFile);
const CONFIG_FILE = "acm-toolchain.json";
const CXX_FLAGS = [
  "-std=c++17",
  "-O2",
  "-pipe",
  "-Wall",
  "-Wextra",
  "-static-libgcc",
  "-static-libstdc++",
];
const selectionSchema = z.object({
  mode: z.enum(["auto", "user", "builtin"]),
  path: z.string().trim().max(1024).nullable(),
});

const HELLO_SOURCE = '#include <iostream>\nint main(){std::cout << "ok\\n";}\n';

function resultError<T>(
  errorCode: IpcResult<T>["errorCode"],
  error: string,
): IpcResult<T> {
  return { ok: false, errorCode, error };
}

function isX64Pe(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 0x40 || buffer.subarray(0, 2).toString() !== "MZ")
      return false;
    const offset = buffer.readUInt32LE(0x3c);
    return (
      offset + 6 <= buffer.length &&
      buffer.subarray(offset, offset + 4).toString() === "PE\0\0" &&
      buffer.readUInt16LE(offset + 4) === 0x8664
    );
  } catch {
    return false;
  }
}

function isUnsafePath(filePath: string): boolean {
  return (
    /^(?:\\\\[.?]\\|\\\\\?\\)/.test(filePath) ||
    /^\\\\[^\\]+\\[^\\]+/.test(filePath)
  );
}

function normalizeCompilerPath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.trim().length === 0)
    throw new Error("编译器路径不能为空");
  const resolved = path.resolve(filePath);
  if (
    isUnsafePath(resolved) ||
    path.basename(resolved).toLowerCase() !== "g++.exe"
  )
    throw new Error("编译器必须是普通路径下的 g++.exe");
  return resolved;
}

export class AcmCompilerService {
  private initialized = false;
  private selection: CompilerSelection = { mode: "auto", path: null };
  private configPath = "";
  private cached: CompilerProbeResult | null = null;
  private probePromise: Promise<IpcResult<CompilerProbeResult>> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.configPath = path.join(app.getPath("userData"), CONFIG_FILE);
    this.selection = this.readSelection();
    this.initialized = true;
  }

  getSelection(): IpcResult<CompilerSelection> {
    return { ok: true, data: { ...this.selection } };
  }

  setSelection(selection: CompilerSelection): IpcResult<CompilerSelection> {
    const parsed = selectionSchema.safeParse(selection);
    if (!parsed.success)
      return resultError("ACM_COMPILER_INVALID", "编译器选择无效");
    if (parsed.data.mode === "user" && !parsed.data.path)
      return resultError(
        "ACM_COMPILER_INVALID",
        "用户模式必须指定 g++.exe 路径",
      );
    const previous = this.selection;
    try {
      const next: CompilerSelection = {
        mode: parsed.data.mode,
        path:
          parsed.data.mode === "user"
            ? normalizeCompilerPath(parsed.data.path as string)
            : null,
      };
      this.selection = next;
      this.cached = null;
      this.writeSelection();
      return this.getSelection();
    } catch (error) {
      this.selection = previous;
      return resultError(
        "ACM_COMPILER_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async probe(): Promise<IpcResult<CompilerProbeResult>> {
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.probeInternal();
    try {
      return await this.probePromise;
    } finally {
      this.probePromise = null;
    }
  }

  private async probeInternal(): Promise<IpcResult<CompilerProbeResult>> {
    const candidates = this.candidates();
    for (const candidate of candidates) {
      const result = await this.probeCandidate(candidate);
      if (result.available) {
        this.cached = result;
        return { ok: true, data: result };
      }
    }
    const fallback = {
      available: false,
      path: null,
      version: null,
      target: null,
      reason:
        this.selection.mode === "user"
          ? "指定的 g++ 不可用"
          : "没有找到可用的 x64 MinGW g++",
    } satisfies CompilerProbeResult;
    this.cached = fallback;
    return { ok: true, data: fallback };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.cached = null;
    this.probePromise = null;
  }

  getCompilerFlags(): string[] {
    return [...CXX_FLAGS];
  }

  getCached(): CompilerProbeResult | null {
    return this.cached ? { ...this.cached } : null;
  }

  private candidates(): string[] {
    if (this.selection.mode === "user")
      return this.selection.path ? [this.selection.path] : [];
    const result: string[] = [];
    if (this.selection.mode === "auto") result.push("g++");
    const builtin = this.builtinPath();
    if (builtin) result.push(builtin);
    return result;
  }

  private builtinPath(): string | null {
    const source = process.env.ACM_MINGW_SOURCE?.trim();
    if (!app.isPackaged && source) return path.join(source, "bin", "g++.exe");
    const packaged = path.join(
      process.resourcesPath,
      "toolchain",
      "bin",
      "g++.exe",
    );
    return fs.existsSync(packaged) ? packaged : null;
  }

  private async probeCandidate(
    candidate: string,
  ): Promise<CompilerProbeResult> {
    const executable =
      candidate === "g++" ? await this.findOnPath() : candidate;
    if (!executable || !fs.existsSync(executable) || !isX64Pe(executable))
      return {
        available: false,
        path: executable ?? null,
        version: null,
        target: null,
        reason: "编译器不是 x64 PE",
      };
    try {
      const version = await this.run(executable, ["--version"]);
      const target = (await this.run(executable, ["-dumpmachine"])).trim();
      if (!target.includes("x86_64-w64-mingw32"))
        return {
          available: false,
          path: executable,
          version: version.trim(),
          target,
          reason: "编译器目标不是 x64 MinGW",
        };
      await this.compileProbe(executable);
      return {
        available: true,
        path: executable,
        version: version.split(/\r?\n/, 1)[0].trim(),
        target,
      };
    } catch (error) {
      return {
        available: false,
        path: executable,
        version: null,
        target: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async findOnPath(): Promise<string | null> {
    try {
      const result = await this.run("where.exe", ["g++.exe"]);
      return (
        result
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.toLowerCase().endsWith("g++.exe")) ?? null
      );
    } catch {
      return null;
    }
  }

  private async compileProbe(executable: string): Promise<void> {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "college-toolkit-probe-"),
    );
    const source = path.join(directory, "hello.cpp");
    const output = path.join(directory, "hello.exe");
    fs.writeFileSync(source, HELLO_SOURCE, "utf8");
    try {
      await this.run(executable, [...CXX_FLAGS, source, "-o", output], 30000);
      if (!fs.existsSync(output) || !isX64Pe(output))
        throw new Error("C++17 探针未生成 x64 程序");
      const result = await this.run(output, [], 3000);
      if (result.trim() !== "ok") throw new Error("C++17 探针运行结果不正确");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  private async run(
    command: string,
    args: string[],
    timeout = 10000,
  ): Promise<string> {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    });
    return `${result.stdout}${result.stderr}`;
  }

  private readSelection(): CompilerSelection {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(this.configPath, "utf8"),
      );
      const parsed = selectionSchema.safeParse(value);
      if (parsed.success && (parsed.data.mode !== "user" || parsed.data.path)) {
        return {
          mode: parsed.data.mode,
          path:
            parsed.data.mode === "user"
              ? normalizeCompilerPath(parsed.data.path as string)
              : null,
        };
      }
    } catch {
      // Invalid machine-only selection falls back to automatic probing.
    }
    return { mode: "auto", path: null };
  }

  private writeSelection(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const backup = `${this.configPath}.${process.pid}.${randomUUID()}.bak`;
    fs.writeFileSync(
      temporary,
      JSON.stringify(this.selection, null, 2),
      "utf8",
    );
    try {
      if (fs.existsSync(this.configPath)) {
        fs.renameSync(this.configPath, backup);
        try {
          fs.renameSync(temporary, this.configPath);
        } catch (error) {
          fs.renameSync(backup, this.configPath);
          throw error;
        }
        fs.rmSync(backup, { force: true });
      } else {
        fs.renameSync(temporary, this.configPath);
      }
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(backup, { force: true });
      throw error;
    }
  }
}

export const acmCompilerService = new AcmCompilerService();
