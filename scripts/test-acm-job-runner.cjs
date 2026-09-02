/* eslint-env node */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const defaultAppxOutput = "release-v0.4.0-msix-local";
const helper = resolveHelper();
const breakawayProbe = path.join(
  root,
  "scripts",
  "acm-job-breakaway-probe.ps1",
);

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
  if (!argument || argument.startsWith("--"))
    return path.join(root, ".build", "acm-job-runner", "acm-job-runner.exe");
  return path.resolve(root, argument);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForMarker(marker, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) {
      const pids = fs
        .readFileSync(marker, "utf8")
        .split(/\r?\n/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      if (pids.length >= 3) return pids.slice(0, 3);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待 helper 目标及后代 PID 超时");
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (typeof child.exitCode === "number") return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("等待 helper 退出超时")),
      timeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(typeof code === "number" ? code : (child.exitCode ?? -1));
    });
  });
}

async function waitForPidsToExit(pids, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Job Object 终止后仍有进程存活：${pids.join(", ")}`);
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
    // Cleanup is best effort after the assertion has captured the failure.
  }
}

async function verifyExitCode(target, directory) {
  const child = spawn(
    helper,
    [target, "-NoProfile", "-NonInteractive", "-Command", "exit 7"],
    {
      cwd: directory,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  try {
    const exitCode = await waitForExit(child);
    if (exitCode !== 7) throw new Error(`helper 未透传目标退出码：${exitCode}`);
  } finally {
    if (child.pid && processExists(child.pid)) killPid(child.pid);
  }
}

function powershellTarget() {
  return path.join(
    process.env.SystemRoot?.trim() || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function treeTerminationCommand() {
  return (
    "$child = Start-Process -FilePath $env:ComSpec " +
    "-ArgumentList @('/d','/c','ping','127.0.0.1','-t') -PassThru; " +
    "$grandchild = $null; for ($i = 0; $i -lt 20 -and -not $grandchild; $i++) { " +
    "$grandchild = Get-CimInstance Win32_Process | Where-Object " +
    "ParentProcessId -eq $child.Id | Select-Object -First 1; " +
    "if (-not $grandchild) { Start-Sleep -Milliseconds 100 } }; " +
    "if (-not $grandchild) { exit 8 }; " +
    "$value = @($PID, $child.Id, $grandchild.ProcessId); Set-Content -LiteralPath " +
    "$env:ACM_JOB_RUNNER_MARKER -Value $value; Start-Sleep -Seconds 60"
  );
}

async function verifyBreakawayAllowedWithoutHelper(target, directory, marker) {
  let runner;
  let extraPids = [];
  try {
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
    runner = spawn(
      target,
      ["-NoProfile", "-NonInteractive", "-File", breakawayProbe],
      {
        cwd: directory,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ACM_JOB_RUNNER_MARKER: marker },
      },
    );
    const deadline = Date.now() + 10_000;
    let values = [];
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) {
        values = fs
          .readFileSync(marker, "utf8")
          .split(/\r?\n/)
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value));
        if (values.length >= 4) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (values.length < 4)
      throw new Error("等待 fallback breakaway 探针结果超时");
    const [shellPid, childPid, breakawayCreated, , breakawayPid] = values;
    extraPids = [shellPid, childPid, breakawayPid].filter(
      (pid) => Number.isInteger(pid) && pid > 0,
    );
    if (breakawayCreated === 0)
      throw new Error("没有 helper 时 breakaway 仍失败，对照无效");
    if (processExists(runner.pid)) {
      if (!runner.kill()) throw new Error("无法结束 fallback wrapper");
      await waitForExit(runner);
    }
    console.log(
      JSON.stringify({
        helper: null,
        strategy: "fallback-allows-create-breakaway-from-job",
        breakawayCreated: true,
        targetPids: extraPids,
      }),
    );
  } finally {
    if (runner?.pid && processExists(runner.pid)) killPid(runner.pid);
    extraPids.forEach(killPid);
  }
}

async function verifyBreakawayRejected(target, directory, marker) {
  let runner;
  let pids = [];
  try {
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
    runner = spawn(
      helper,
      [target, "-NoProfile", "-NonInteractive", "-File", breakawayProbe],
      {
        cwd: directory,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ACM_JOB_RUNNER_MARKER: marker },
      },
    );
    const deadline = Date.now() + 10_000;
    let values = [];
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) {
        values = fs
          .readFileSync(marker, "utf8")
          .split(/\r?\n/)
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value));
        if (values.length >= 4) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (values.length < 4) throw new Error("等待 breakaway 探针结果超时");
    const [shellPid, childPid, breakawayCreated, breakawayError] = values;
    if (breakawayCreated !== 0)
      throw new Error("helper Job 允许 CREATE_BREAKAWAY_FROM_JOB");
    if (breakawayError !== 5 && breakawayError !== 87)
      throw new Error(`意外的 breakaway 错误码：${breakawayError}`);
    pids = [shellPid, childPid].filter(
      (pid) => Number.isInteger(pid) && pid > 0,
    );
    if (!pids.every(processExists)) throw new Error("breakaway 对照后代未启动");
    if (!runner.kill()) throw new Error("无法结束 helper wrapper");
    await waitForExit(runner);
    await waitForPidsToExit(pids);
    console.log(
      JSON.stringify({
        helper,
        strategy: "reject-create-breakaway-from-job",
        breakawayCreated: false,
        breakawayError,
        targetPids: pids,
      }),
    );
  } finally {
    if (runner?.pid && processExists(runner.pid)) killPid(runner.pid);
    pids.forEach(killPid);
  }
}

async function verifyTreeTermination(target, directory, marker) {
  let runner;
  let pids = [];
  try {
    runner = spawn(
      helper,
      [
        target,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        treeTerminationCommand(),
      ],
      {
        cwd: directory,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ACM_JOB_RUNNER_MARKER: marker },
      },
    );
    pids = await waitForMarker(marker);
    if (!pids.every(processExists)) throw new Error("helper 目标尚未运行");
    if (!runner.kill()) throw new Error("无法结束 helper wrapper");
    await waitForExit(runner);
    await waitForPidsToExit(pids);
    console.log(
      JSON.stringify({ helper, wrapperPid: runner.pid, targetPids: pids }),
    );
  } finally {
    if (runner?.pid && processExists(runner.pid)) killPid(runner.pid);
    pids.forEach(killPid);
  }
}

async function run() {
  if (process.platform !== "win32") {
    console.log("ACM Job Object helper test skipped: Windows only.");
    return;
  }
  if (!fs.existsSync(helper))
    throw new Error(
      `找不到 helper：${helper}，请先运行 npm run build:runner-helper`,
    );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-job-runner-test-"),
  );
  const marker = path.join(directory, "marker with spaces.txt");
  try {
    const target = powershellTarget();
    const fallbackOnly = process.argv[2]?.trim() === "--fallback";
    if (fallbackOnly) {
      await verifyBreakawayAllowedWithoutHelper(target, directory, marker);
    } else {
      await verifyExitCode(target, directory);
      await verifyTreeTermination(target, directory, marker);
      await verifyBreakawayRejected(target, directory, marker);
    }
  } finally {
    await removeDirectory(directory);
  }
}

run().catch((error) => {
  console.error(
    `[test-acm-job-runner] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
