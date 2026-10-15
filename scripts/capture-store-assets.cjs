const { _electron: electron } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const executable = path.resolve(
  process.env.PACKAGED_EXECUTABLE?.trim() ||
    "release-v0.5.0-msix-local/win-unpacked/大学生工具组.exe",
);
const outputDir = path.resolve("docs/store-assets");

const WORKBENCH_SOURCE = `#include <iostream>

int main() {
  int value = 0;
  if (!(std::cin >> value)) return 1;
  std::cout << "next: " << value + 1 << "\\n";
  return 0;
}
`;

const REFERENCE_SOURCE = `#include <iostream>

int main() {
  int value = 0;
  if (!(std::cin >> value)) return 1;
  std::cout << value + 1 << "\\n";
}
`;

const CANDIDATE_SOURCE = REFERENCE_SOURCE.replace("value + 1", "value + 2");

function unwrap(result) {
  if (!result || result.ok !== true) {
    throw new Error(result?.error || "演示数据写入失败");
  }
  return result.data;
}

function localDate(offsetDays) {
  const value = new Date();
  value.setDate(value.getDate() + offsetDays);
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("-");
}

function localIso(hour, minute, offsetDays = 0) {
  const value = new Date();
  value.setDate(value.getDate() + offsetDays);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
}

async function seedDemoData(page) {
  unwrap(
    await page.evaluate(async () =>
      window.api.timetable.setSemesterStart("2026-08-17"),
    ),
  );
  unwrap(
    await page.evaluate(async (payload) => window.api.timetable.add(payload), {
      name: "高等数学",
      teacher: "王老师",
      location: "南教 A101",
      startWeek: 1,
      endWeek: 16,
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
      color: "#3b82f6",
    }),
  );
  unwrap(
    await page.evaluate(async (payload) => window.api.schedule.add(payload), {
      title: "项目周会",
      startTime: localIso(10, 0),
      endTime: localIso(11, 0),
      reminderOffset: 10,
      repeatRule: "none",
    }),
  );
  unwrap(
    await page.evaluate(async (payload) => window.api.exam.add(payload), {
      courseName: "高等数学",
      date: localDate(7),
      startTime: "09:00",
      endTime: "11:00",
      location: "南教 B201",
      seat: "08",
      notes: "请携带学生证",
      reminderOffsets: [1440, 60],
    }),
  );
  unwrap(
    await page.evaluate(async (payload) => window.api.lab.add(payload), {
      name: "物理实验：摆的周期",
      date: localDate(4),
      startTime: "14:00",
      endTime: "16:00",
      location: "实验楼 C301",
      instructor: "李老师",
      notes: "提前预习实验要求",
      reminderOffsets: [60],
    }),
  );
  unwrap(
    await page.evaluate(async (payload) => window.api.grade.add(payload), {
      courseName: "高等数学",
      semester: "2026-2027-1",
      credit: 4,
      gradePoint: 4,
      score: 95,
      isDegreeCourse: true,
    }),
  );
}

async function openSection(page, name, route) {
  await page.locator(".ant-menu-item").filter({ hasText: name }).click();
  const discard = page
    .locator(".ant-modal")
    .filter({ hasText: "离开 ACM 临时 IDE？" })
    .last();
  try {
    await discard.waitFor({ state: "visible", timeout: 2_000 });
    await discard.getByRole("button", { name: "离开并丢弃" }).click();
  } catch {
    // The guard is only shown when the previous ACM page has unsaved edits.
  }
  await page.waitForURL(new RegExp(`#${route}$`));
  await page.waitForTimeout(350);
}

async function waitForCompiler(page) {
  const toolbar = page
    .locator(".acm-compiler-tools, .acm-diff-toolbar")
    .first();
  await toolbar.waitFor({ state: "visible", timeout: 15_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const text = (await toolbar.textContent()) ?? "";
    if (/g\+\+/.test(text) && !text.includes("未检测到编译器")) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 ACM 编译器探测完成超时");
}

async function waitForEnabled(locator) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 ACM 操作按钮可用超时");
}

async function seedWorkbenchDemo(page) {
  await waitForCompiler(page);
  const newButton = page.getByRole("button", { name: /新建/ }).first();
  await newButton.click();
  await page.getByRole("menuitem", { name: "基础 I/O 模板" }).click();
  const editor = page.locator(".cm-content").first();
  await editor.waitFor({ state: "visible" });
  await editor.fill(WORKBENCH_SOURCE);
  await page.getByLabel("程序标准输入").fill("41\n");
  const runButton = page.getByRole("button", { name: "编译并运行" });
  await waitForEnabled(runButton);
  await runButton.click();
  await page
    .locator(".acm-terminal-output")
    .getByText(/next: 42/)
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function seedDiffDemo(page) {
  await waitForCompiler(page);
  const editors = page.locator(".acm-diff-editor-card .cm-content");
  await editors.nth(0).fill(REFERENCE_SOURCE);
  await editors.nth(1).fill(CANDIDATE_SOURCE);
  await page
    .getByPlaceholder("输入将同时提供给标准程序和待测程序")
    .fill("41\n");
  const startButton = page.getByRole("button", { name: "开始对拍" });
  await waitForEnabled(startButton);
  await startButton.click();
  await page
    .locator(".ant-alert-message")
    .filter({ hasText: "WA：输出不一致" })
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function capture(page, name) {
  const filePath = path.join(outputDir, name);
  await page.screenshot({ path: filePath, type: "png" });
  return filePath;
}

async function skipOnboarding(page) {
  const modal = page
    .locator(".ant-modal")
    .filter({ hasText: "欢迎使用大学生工具组" })
    .last();
  if (await modal.isVisible().catch(() => false)) {
    await modal.getByRole("button", { name: "跳过引导" }).click();
    await modal.waitFor({ state: "hidden" });
  }
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`找不到 ${executable}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "college-toolkit-store-assets-"),
  );
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`, "--window-size=1366,768"],
    env: { ...process.env, COLLEGE_TOOLKIT_STORE_SMOKE: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 1366, height: 768 });
    const files = [];
    await page
      .locator(".ant-modal")
      .filter({ hasText: "欢迎使用大学生工具组" })
      .last()
      .waitFor({ state: "visible", timeout: 15_000 });
    files.push(await capture(page, "zh-cn-desktop-08-onboarding.png"));
    await skipOnboarding(page);
    await seedDemoData(page);
    await openSection(page, "课程表", "/timetable");
    files.push(await capture(page, "zh-cn-desktop-01-timetable.png"));
    await openSection(page, "日程", "/schedule");
    files.push(await capture(page, "zh-cn-desktop-02-schedule.png"));
    await openSection(page, "考试安排", "/exam");
    files.push(await capture(page, "zh-cn-desktop-03-exams.png"));
    await openSection(page, "成绩显示", "/grade");
    files.push(await capture(page, "zh-cn-desktop-04-grades.png"));
    await openSection(page, "ACM 临时 IDE", "/acm");
    await seedWorkbenchDemo(page);
    files.push(await capture(page, "zh-cn-desktop-06-acm-workbench.png"));
    await openSection(page, "ACM 对拍", "/acm-diff");
    await seedDiffDemo(page);
    await page.locator(".acm-diff-difference").scrollIntoViewIfNeeded();
    files.push(await capture(page, "zh-cn-desktop-07-acm-diff.png"));
    await page.getByRole("button", { name: /跟随系统/ }).click();
    await page.getByRole("menuitem", { name: "设置" }).click();
    const settings = page
      .locator(".ant-modal")
      .filter({ hasText: "课程与学期" })
      .last();
    await settings.getByRole("tab", { name: "关于与更新" }).click();
    await page.waitForTimeout(250);
    files.push(await capture(page, "zh-cn-desktop-05-settings.png"));
    console.log(JSON.stringify(files));
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
