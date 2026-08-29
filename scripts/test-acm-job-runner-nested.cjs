/* eslint-env node */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const helper = path.join(
  root,
  ".build",
  "acm-job-runner",
  "acm-job-runner.exe",
);

const outerJobProbe = String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class AcmOuterJobProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  public static int Run(string helper, string target) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) {
      Console.WriteLine("CREATE_JOB_FAILED:" + Marshal.GetLastWin32Error());
      return 90;
    }
    try {
      var info = new ProcessStartInfo {
        FileName = helper,
        Arguments = "\"" + target + "\" /d /c \"ping 127.0.0.1 -n 3 >nul & exit 7\"",
        UseShellExecute = false,
        CreateNoWindow = true
      };
      using (var process = Process.Start(info)) {
        if (process == null) return 91;
        if (!AssignProcessToJobObject(job, process.Handle)) {
          int error = Marshal.GetLastWin32Error();
          Console.WriteLine("ASSIGN_FAILED:" + error);
          try { process.Kill(); } catch { }
          return 100;
        }
        process.WaitForExit();
        Console.WriteLine("HELPER_EXIT:" + process.ExitCode);
        return process.ExitCode;
      }
    } finally {
      CloseHandle(job);
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$target = Join-Path ($env:SystemRoot.Trim()) "System32\cmd.exe"
$exitCode = [AcmOuterJobProbe]::Run($env:ACM_JOB_HELPER, $target)
Write-Output ("RESULT:" + $exitCode)
if ($exitCode -ne 7) { exit 1 }
exit 0
`;

function runProbe() {
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
  try {
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", outerJobProbe],
      {
        cwd: directory,
        windowsHide: true,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, ACM_JOB_HELPER: helper },
      },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`外部 Job Object 宿主测试退出码异常：${result.status}`);
    if (!(result.stdout ?? "").includes("HELPER_EXIT:7"))
      throw new Error("未观察到嵌套 Job Object helper 的退出码透传");
    console.log(
      JSON.stringify({
        helper,
        host: "Windows PowerShell Add-Type Job Object probe",
        helperExitCode: 7,
        windowsRelease: os.release(),
      }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function run() {
  if (process.platform !== "win32") {
    console.log("ACM nested Job Object test skipped: Windows only.");
    return;
  }
  if (!fs.existsSync(helper))
    throw new Error(
      `找不到 helper：${helper}，请先运行 npm run build:runner-helper`,
    );
  runProbe();
}

try {
  run();
} catch (error) {
  console.error(
    `[test-acm-job-runner-nested] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
