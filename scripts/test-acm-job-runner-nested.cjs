/* eslint-env node */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const buildHelper = path.join(
  root,
  ".build",
  "acm-job-runner",
  "acm-job-runner.exe",
);
const defaultAppxOutput = "release-v0.4.0-msix-local";

const outerJobProbe = String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AcmOuterJobProbe {
  private const uint CreateSuspended = 0x00000004;
  private const uint CreateNoWindow = 0x08000000;
  private const uint CreateUnicodeEnvironment = 0x00000400;
  private const uint JobObjectExtendedLimitInformation = 9;
  private const uint JobObjectLimitKillOnClose = 0x00002000;
  private const uint Synchronize = 0x00100000;
  private const uint WaitObject0 = 0x00000000;

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct StartupInfo {
    public uint Cb;
    public IntPtr Reserved;
    public IntPtr Desktop;
    public IntPtr Title;
    public uint X;
    public uint Y;
    public uint XSize;
    public uint YSize;
    public uint XCountChars;
    public uint YCountChars;
    public uint FillAttribute;
    public uint Flags;
    public ushort ShowWindow;
    public ushort Reserved2;
    public IntPtr Reserved2Pointer;
    public IntPtr StandardInput;
    public IntPtr StandardOutput;
    public IntPtr StandardError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr Process;
    public IntPtr Thread;
    public uint ProcessId;
    public uint ThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    uint informationClass,
    ref ExtendedLimitInformation information,
    uint informationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessW(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    ExtendedLimitInformation information = new ExtendedLimitInformation();
    information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnClose;
    if (SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      ref information,
      (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))) return job;
    CloseHandle(job);
    return IntPtr.Zero;
  }

  private static string QuoteArgument(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
      return value;
    StringBuilder result = new StringBuilder("\"");
    int backslashes = 0;
    foreach (char character in value) {
      if (character == '\\') {
        backslashes++;
        continue;
      }
      if (character == '"') {
        result.Append('\\', backslashes * 2 + 1);
        result.Append('"');
        backslashes = 0;
        continue;
      }
      result.Append('\\', backslashes);
      result.Append(character);
      backslashes = 0;
    }
    result.Append('\\', backslashes * 2);
    result.Append('"');
    return result.ToString();
  }

  private static string BuildCommandLine(string[] arguments) {
    StringBuilder result = new StringBuilder();
    for (int index = 0; index < arguments.Length; index++) {
      if (index > 0) result.Append(' ');
      result.Append(QuoteArgument(arguments[index]));
    }
    return result.ToString();
  }

  private static bool StartHelper(
    string helper,
    string[] arguments,
    out ProcessInformation processInformation) {
    StartupInfo startup = new StartupInfo();
    startup.Cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
    string[] fullArguments = new string[arguments.Length + 1];
    fullArguments[0] = helper;
    Array.Copy(arguments, 0, fullArguments, 1, arguments.Length);
    StringBuilder commandLine = new StringBuilder(BuildCommandLine(fullArguments));
    return CreateProcessW(
      helper,
      commandLine,
      IntPtr.Zero,
      IntPtr.Zero,
      false,
      CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment,
      IntPtr.Zero,
      null,
      ref startup,
      out processInformation);
  }

  private static void CloseProcessInformation(ref ProcessInformation information) {
    if (information.Thread != IntPtr.Zero) CloseHandle(information.Thread);
    if (information.Process != IntPtr.Zero) CloseHandle(information.Process);
    information.Thread = IntPtr.Zero;
    information.Process = IntPtr.Zero;
  }

  private static void TerminateAndWait(ref ProcessInformation information) {
    if (information.Process == IntPtr.Zero) return;
    TerminateProcess(information.Process, 99);
    WaitForSingleObject(information.Process, 5000);
  }

  private static int ReadExitCode(IntPtr process) {
    uint exitCode;
    return GetExitCodeProcess(process, out exitCode) ? (int)exitCode : 1;
  }

  private static bool TryReadPids(string marker, out uint[] pids) {
    pids = new uint[0];
    try {
      string[] lines = File.ReadAllLines(marker);
      List<uint> values = new List<uint>();
      foreach (string line in lines) {
        uint pid;
        if (uint.TryParse(line.Trim(), out pid) && pid > 0) values.Add(pid);
      }
      if (values.Count < 3) return false;
      pids = new uint[] { values[0], values[1], values[2] };
      return true;
    } catch {
      return false;
    }
  }

  private static bool WaitForMarker(string marker, out uint[] pids) {
    DateTime deadline = DateTime.UtcNow.AddSeconds(10);
    while (DateTime.UtcNow < deadline) {
      if (TryReadPids(marker, out pids)) return true;
      Thread.Sleep(100);
    }
    pids = new uint[0];
    return false;
  }

  private static bool WaitForProcessExit(uint pid) {
    IntPtr process = OpenProcess(Synchronize, false, pid);
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87;
    try {
      return WaitForSingleObject(process, 5000) == WaitObject0;
    } finally {
      CloseHandle(process);
    }
  }

  private static string NestedTargetScript() {
    return "$ErrorActionPreference='Stop'; " +
      "$child = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','ping','127.0.0.1','-t') -PassThru; " +
      "$grandchild = $null; for ($i = 0; $i -lt 30 -and -not $grandchild; $i++) { " +
      "$grandchild = Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq $child.Id | Select-Object -First 1; " +
      "if (-not $grandchild) { Start-Sleep -Milliseconds 100 } }; " +
      "if (-not $grandchild) { exit 8 }; " +
      "Set-Content -LiteralPath $env:ACM_NESTED_MARKER -Value @($PID,$child.Id,$grandchild.ProcessId); " +
      "Start-Sleep -Seconds 60";
  }

  public static int RunExitCode(string helper, string target) {
    IntPtr job = CreateKillOnCloseJob();
    if (job == IntPtr.Zero) return 90;
    ProcessInformation information = new ProcessInformation();
    try {
      string[] arguments = new string[] {
        target, "/d", "/c", "ping 127.0.0.1 -n 3 >nul & exit 7"
      };
      if (!StartHelper(helper, arguments, out information)) return 91;
      if (!AssignProcessToJobObject(job, information.Process)) {
        TerminateAndWait(ref information);
        return 92;
      }
      if (ResumeThread(information.Thread) == 0xffffffff) {
        TerminateAndWait(ref information);
        return 93;
      }
      WaitForSingleObject(information.Process, 15000);
      return ReadExitCode(information.Process);
    } finally {
      CloseProcessInformation(ref information);
      CloseHandle(job);
    }
  }

  public static int RunNestedCleanup(string helper, string target, string marker) {
    IntPtr job = CreateKillOnCloseJob();
    if (job == IntPtr.Zero) return 90;
    ProcessInformation information = new ProcessInformation();
    try {
      string[] arguments = new string[] {
        target, "-NoProfile", "-NonInteractive", "-Command", NestedTargetScript()
      };
      if (!StartHelper(helper, arguments, out information)) return 91;
      if (!AssignProcessToJobObject(job, information.Process)) {
        TerminateAndWait(ref information);
        return 92;
      }
      if (ResumeThread(information.Thread) == 0xffffffff) {
        TerminateAndWait(ref information);
        return 93;
      }
      uint[] pids;
      if (!WaitForMarker(marker, out pids)) {
        TerminateAndWait(ref information);
        Console.WriteLine("NESTED_TARGETS_EXITED:false");
        return 94;
      }
      TerminateAndWait(ref information);
      bool helperTerminated =
        WaitForSingleObject(information.Process, 0) == WaitObject0;
      Console.WriteLine("HELPER_TERMINATED:" +
        helperTerminated.ToString().ToLowerInvariant());
      bool allExited = true;
      foreach (uint pid in pids) {
        if (!WaitForProcessExit(pid)) allExited = false;
      }
      Console.WriteLine("NESTED_TARGETS_EXITED:" + allExited.ToString().ToLowerInvariant());
      return helperTerminated && allExited ? 0 : 95;
    } finally {
      TerminateAndWait(ref information);
      CloseProcessInformation(ref information);
      CloseHandle(job);
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$target = Join-Path ($env:SystemRoot.Trim()) "System32\cmd.exe"
$exitCode = [AcmOuterJobProbe]::RunExitCode($env:ACM_JOB_HELPER, $target)
Write-Output ("HELPER_EXIT:" + $exitCode)
if ($exitCode -ne 7) { exit 1 }
$nestedCode = [AcmOuterJobProbe]::RunNestedCleanup($env:ACM_JOB_HELPER, (Join-Path ($env:SystemRoot.Trim()) "System32\WindowsPowerShell\v1.0\powershell.exe"), $env:ACM_NESTED_MARKER)
Write-Output ("NESTED_RESULT:" + $nestedCode)
if ($nestedCode -ne 0) { exit 1 }
exit 0
`;

function resolveHelper() {
  const supplied = process.env.ACM_JOB_HELPER?.trim();
  if (supplied) return path.resolve(supplied);
  if (process.argv[2]?.trim() === "--packaged") {
    return path.join(
      path.resolve(root, process.env.APPX_OUTPUT_DIR || defaultAppxOutput),
      "win-unpacked",
      "resources",
      "acm-job-runner.exe",
    );
  }
  const argument = process.argv[2]?.trim();
  return argument ? path.resolve(root, argument) : buildHelper;
}

function isX64Pe(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 0x40 || buffer.subarray(0, 2).toString() !== "MZ")
    return false;
  const offset = buffer.readUInt32LE(0x3c);
  return (
    offset + 6 <= buffer.length &&
    buffer.subarray(offset, offset + 4).toString() === "PE\0\0" &&
    buffer.readUInt16LE(offset + 4) === 0x8664
  );
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readPids(marker) {
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

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return;
  const taskkill = path.join(
    process.env.SystemRoot?.trim() || "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  try {
    execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // The outer Job Object is the primary cleanup; taskkill is only a test fallback.
  }
}

function cleanupMarkedProcesses(marker) {
  readPids(marker).forEach(killPid);
}

async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function waitForPidsToExit(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`嵌套 Job Object 终止后仍有进程存活：${pids.join(", ")}`);
}

async function runProbe(helper) {
  const powershell = path.join(
    process.env.SystemRoot?.trim() || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-job-nested-test-"),
  );
  const marker = path.join(directory, "nested-pids.txt");
  try {
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", outerJobProbe],
      {
        cwd: directory,
        windowsHide: true,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          ACM_JOB_HELPER: helper,
          ACM_NESTED_MARKER: marker,
        },
      },
    );
    const stdout = result.stdout ?? "";
    process.stdout.write(stdout);
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`外部 Job Object 宿主测试退出码异常：${result.status}`);
    if (!stdout.includes("HELPER_EXIT:7"))
      throw new Error("未观察到 helper 在外部 Job Object 中透传退出码");
    if (!stdout.includes("HELPER_TERMINATED:true"))
      throw new Error("未观察到 helper 被单独终止");
    if (!stdout.includes("NESTED_TARGETS_EXITED:true"))
      throw new Error("未观察到 helper 终止后嵌套目标全部退出");
    const pids = readPids(marker);
    if (pids.length !== 3) throw new Error("嵌套目标 PID marker 不完整");
    await waitForPidsToExit(pids);
    console.log(
      JSON.stringify({
        helper,
        host: "Windows PowerShell Add-Type CreateProcessW Job Object probe",
        helperExitCode: 7,
        nestedTargetsExited: true,
        targetPids: pids,
        windowsRelease: os.release(),
      }),
    );
  } finally {
    cleanupMarkedProcesses(marker);
    await removeDirectory(directory);
  }
}

async function run() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    console.log(
      JSON.stringify({
        status: "SKIPPED",
        reason: "windows-x64-only",
        platform: process.platform,
        arch: process.arch,
      }),
    );
    process.exitCode = 2;
    return;
  }
  const helper = resolveHelper();
  if (!fs.existsSync(helper)) throw new Error(`找不到 helper：${helper}`);
  if (!isX64Pe(helper)) throw new Error(`helper 不是 x64 PE：${helper}`);
  await runProbe(helper);
}

run().catch((error) => {
  console.error(
    `[test-acm-job-runner-nested] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
