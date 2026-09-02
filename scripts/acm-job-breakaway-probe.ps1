$ErrorActionPreference = "Stop"
$source = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class AcmJobBreakaway {
  public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public uint cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public ushort wShowWindow;
    public ushort cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessW(
    string lpApplicationName,
    StringBuilder lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
  public static int TryBreakaway(string command, out int errorCode, out uint pid) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    StringBuilder cmd = new StringBuilder(command);
    bool created = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref si, out pi);
    errorCode = Marshal.GetLastWin32Error();
    pid = created ? pi.dwProcessId : 0;
    if (created) {
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
    }
    return created ? 1 : 0;
  }
}
"@
Add-Type -TypeDefinition $source
$created = 0
$errorCode = 0
$breakawayPid = [uint32]0
$command = $env:ComSpec + " /d /c ping 127.0.0.1 -t"
$created = [AcmJobBreakaway]::TryBreakaway($command, [ref]$errorCode, [ref]$breakawayPid)
$child = Start-Process -FilePath $env:ComSpec -ArgumentList @("/d","/c","ping","127.0.0.1","-t") -PassThru
Set-Content -LiteralPath $env:ACM_JOB_RUNNER_MARKER -Value @($PID, $child.Id, $created, $errorCode, $breakawayPid)
if ($created -ne 0) { exit 9 }
Start-Sleep -Seconds 60
