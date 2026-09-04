import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BackupInspection,
  Course,
  Exam,
  Grade,
  IpcResult,
  Lab,
  Schedule,
} from "../../src/shared/types";
import { skipOnboarding } from "./onboarding";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

type AppSession = { app: ElectronApplication; page: Page };

const defaultExecutable = path.resolve(
  "release-v0.5.0-msix-local/win-unpacked/大学生工具组.exe",
);

function packagedExecutable(): string {
  const executable = path.resolve(
    process.env.PACKAGED_EXECUTABLE?.trim() || defaultExecutable,
  );
  if (!fs.existsSync(executable)) {
    throw new Error(
      `找不到 packaged E2E 可执行文件：${executable}。先运行 npm run package:appx，或设置 PACKAGED_EXECUTABLE。`,
    );
  }
  return executable;
}

function createProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "college-toolkit-e2e-"));
}

function launchEnvironment(
  backupPath: string | null,
  importPath: string | null,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    COLLEGE_TOOLKIT_STORE_SMOKE: "1",
  };
  if (backupPath) environment.COLLEGE_TOOLKIT_E2E_BACKUP_PATH = backupPath;
  if (importPath) environment.COLLEGE_TOOLKIT_E2E_IMPORT_PATH = importPath;
  return environment;
}

async function launchPackaged(
  profile: string,
  backupPath: string | null = null,
  importPath: string | null = null,
): Promise<AppSession> {
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    args: [`--user-data-dir=${profile}`],
    env: launchEnvironment(backupPath, importPath),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("body")).toContainText("大学生工具组");
  await skipOnboarding(page);
  return { app, page };
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error ?? "IPC 调用失败");
  return result.data as T;
}

function localDate(offsetDays = 0): string {
  const value = new Date();
  value.setDate(value.getDate() + offsetDays);
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("-");
}

function localIso(hour: number, minute: number): string {
  const value = new Date();
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
}

async function openSection(page: Page, name: string): Promise<void> {
  const routes: Record<string, string> = {
    日程: "/schedule",
    课程表: "/timetable",
    考试安排: "/exam",
    实验提醒: "/lab",
    成绩显示: "/grade",
    "ACM 临时 IDE": "/acm",
  };
  await page.locator(".ant-menu-item").filter({ hasText: name }).click();
  await expect(page).toHaveURL(new RegExp(`#${routes[name]}$`));
}

async function closeSession(session: AppSession | undefined): Promise<void> {
  if (!session) return;
  await session.app.close();
}

test("packaged build performs CRUD, restart persistence, settings, Store channel and backup restore", async () => {
  const profile = createProfile();
  const restoredProfile = createProfile();
  const backupPath = path.join(profile, "e2e-backup.zip");
  let session: AppSession | undefined;
  let reopened: AppSession | undefined;
  let restored: AppSession | undefined;
  const marker = `Packaged E2E ${Date.now()}`;

  try {
    session = await launchPackaged(profile, backupPath);
    const { page } = session;

    await expect(page.locator(".ant-menu-item")).toHaveCount(7);
    const schedulePayload: Omit<Schedule, "id" | "createdAt" | "updatedAt"> = {
      title: `${marker} 日程`,
      startTime: localIso(9, 0),
      endTime: localIso(10, 0),
      reminderOffset: 10,
      repeatRule: "none",
    };
    const schedule = unwrap(
      await page.evaluate(
        async (payload) => window.api.schedule.add(payload),
        schedulePayload,
      ),
    );
    const updatedSchedule = unwrap(
      await page.evaluate(
        async ({ id, title }) => window.api.schedule.update(id, { title }),
        { id: schedule.id, title: `${marker} 日程（已更新）` },
      ),
    );
    expect(updatedSchedule.title).toContain("已更新");
    const temporarySchedule = unwrap(
      await page.evaluate(async (payload) => window.api.schedule.add(payload), {
        ...schedulePayload,
        title: `${marker} 待删除日程`,
      }),
    );
    expect(
      unwrap(
        await page.evaluate(
          async (id) => window.api.schedule.remove(id),
          temporarySchedule.id,
        ),
      ),
    ).toBe(true);

    const coursePayload: Omit<Course, "id" | "createdAt" | "updatedAt"> = {
      name: `${marker} 课程`,
      teacher: "测试教师",
      location: "测试楼 A101",
      startWeek: 1,
      endWeek: 16,
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
      color: "#4285F4",
    };
    const course = unwrap(
      await page.evaluate(
        async (payload) => window.api.timetable.add(payload),
        coursePayload,
      ),
    );
    const updatedCourse = unwrap(
      await page.evaluate(
        async ({ id, name }) => window.api.timetable.update(id, { name }),
        { id: course.id, name: `${marker} 课程（已更新）` },
      ),
    );
    expect(updatedCourse.name).toContain("已更新");
    const temporaryCourse = unwrap(
      await page.evaluate(
        async (payload) => window.api.timetable.add(payload),
        { ...coursePayload, name: `${marker} 待删除课程` },
      ),
    );
    expect(
      unwrap(
        await page.evaluate(
          async (id) => window.api.timetable.remove(id),
          temporaryCourse.id,
        ),
      ),
    ).toBe(true);

    const examPayload: Omit<Exam, "id" | "createdAt" | "updatedAt"> = {
      courseName: `${marker} 考试`,
      date: localDate(3),
      startTime: "09:00",
      endTime: "11:00",
      location: "测试楼 B201",
      seat: "12",
      notes: "自动化验证",
      reminderOffsets: [1440, 60],
    };
    const exam = unwrap(
      await page.evaluate(
        async (payload) => window.api.exam.add(payload),
        examPayload,
      ),
    );
    const updatedExam = unwrap(
      await page.evaluate(
        async ({ id, location }) => window.api.exam.update(id, { location }),
        { id: exam.id, location: "测试楼 B202" },
      ),
    );
    expect(updatedExam.location).toBe("测试楼 B202");
    const temporaryExam = unwrap(
      await page.evaluate(async (payload) => window.api.exam.add(payload), {
        ...examPayload,
        courseName: `${marker} 待删除考试`,
      }),
    );
    expect(
      unwrap(
        await page.evaluate(
          async (id) => window.api.exam.remove(id),
          temporaryExam.id,
        ),
      ),
    ).toBe(true);

    const labPayload: Omit<Lab, "id" | "createdAt" | "updatedAt"> = {
      name: `${marker} 实验`,
      date: localDate(4),
      startTime: "14:00",
      endTime: "16:00",
      location: "实验楼 C301",
      instructor: "测试老师",
      notes: "带实验服",
      reminderOffsets: [1440, 60],
    };
    const lab = unwrap(
      await page.evaluate(
        async (payload) => window.api.lab.add(payload),
        labPayload,
      ),
    );
    const updatedLab = unwrap(
      await page.evaluate(
        async ({ id, location }) => window.api.lab.update(id, { location }),
        { id: lab.id, location: "实验楼 C302" },
      ),
    );
    expect(updatedLab.location).toBe("实验楼 C302");
    const temporaryLab = unwrap(
      await page.evaluate(async (payload) => window.api.lab.add(payload), {
        ...labPayload,
        name: `${marker} 待删除实验`,
      }),
    );
    expect(
      unwrap(
        await page.evaluate(
          async (id) => window.api.lab.remove(id),
          temporaryLab.id,
        ),
      ),
    ).toBe(true);

    const gradePayload: Omit<Grade, "id" | "createdAt" | "updatedAt"> = {
      courseName: `${marker} 成绩`,
      semester: "2026-2027-1",
      credit: 3,
      gradePoint: 4,
      score: 95,
      isDegreeCourse: true,
    };
    const grade = unwrap(
      await page.evaluate(
        async (payload) => window.api.grade.add(payload),
        gradePayload,
      ),
    );
    const updatedGrade = unwrap(
      await page.evaluate(
        async ({ id, score }) => window.api.grade.update(id, { score }),
        { id: grade.id, score: 96 },
      ),
    );
    expect(updatedGrade.score).toBe(96);
    const temporaryGrade = unwrap(
      await page.evaluate(async (payload) => window.api.grade.add(payload), {
        ...gradePayload,
        courseName: `${marker} 待删除成绩`,
      }),
    );
    expect(
      unwrap(
        await page.evaluate(
          async (id) => window.api.grade.remove(id),
          temporaryGrade.id,
        ),
      ),
    ).toBe(true);

    unwrap(
      await page.evaluate(
        async (value) => window.api.timetable.setSemesterStart(value),
        "2026-08-17",
      ),
    );
    unwrap(
      await page.evaluate(async () =>
        window.api.notify.setDnd({
          enabled: true,
          startTime: "00:00",
          endTime: "00:00",
        }),
      ),
    );
    unwrap(
      await page.evaluate(async () =>
        window.api.notify.send({
          title: "E2E 通知",
          body: "E2E 通知记录",
          source: "system",
        }),
      ),
    );

    await openSection(page, "课程表");
    await expect(page.locator("body")).toContainText(
      `${marker} 课程（已更新）`,
    );
    await openSection(page, "考试安排");
    await expect(page.locator("body")).toContainText(`${marker} 考试`);
    await openSection(page, "实验提醒");
    await expect(page.locator("body")).toContainText(`${marker} 实验`);
    await openSection(page, "成绩显示");
    await expect(page.locator("body")).toContainText(`${marker} 成绩`);
    await expect(page.locator("body")).toContainText("4.00");
    await openSection(page, "ACM 临时 IDE");
    await expect(page.locator("body")).toContainText(
      "单文件 C++ 快速编译与运行",
    );
    await openSection(page, "日程");
    await expect(page.locator("body")).toContainText(
      `${marker} 日程（已更新）`,
    );

    const themeButton = page.getByRole("button", { name: /跟随系统/ });
    const openThemeMenu = page.locator(
      ".ant-dropdown:not(.ant-dropdown-hidden)",
    );
    await expect(themeButton).toBeVisible({ timeout: 15_000 });
    let menuOpened = false;
    try {
      await themeButton.click({ timeout: 1_000 });
    } catch {
      // The native titlebar drag region may briefly intercept a pointer under
      // parallel Electron launch pressure. The click may still have reached
      // the page before Playwright timed out, so visibility is checked below.
    }
    try {
      await expect(openThemeMenu).toBeVisible({ timeout: 1_000 });
      menuOpened = true;
    } catch {
      // Only use the keyboard path after the post-click visibility check
      // confirms that the menu did not open.
    }
    if (!menuOpened) {
      await themeButton.focus();
      await themeButton.press("Enter");
    }
    await expect(openThemeMenu).toBeVisible({ timeout: 15_000 });
    const settingsMenuItem = openThemeMenu.getByRole("menuitem", {
      name: "设置",
    });
    await expect(settingsMenuItem).toBeVisible({ timeout: 15_000 });
    await settingsMenuItem.focus();
    await settingsMenuItem.press("Enter");
    const settings = page
      .locator(".ant-modal")
      .filter({ hasText: "课程与学期" })
      .last();
    await expect(settings).toBeVisible();
    for (const tab of [
      "课程与学期",
      "通知",
      "外观",
      "OCR 识别组件",
      "ACM 工具",
      "数据与备份",
      "关于与更新",
    ]) {
      await settings.getByRole("tab", { name: tab }).click();
      await expect(settings.getByRole("tab", { name: tab })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    await expect(settings).toContainText(
      "Microsoft Store（由 Store 管理更新）",
    );
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    const channel = unwrap(
      await page.evaluate(async () => window.api.update.getChannel()),
    );
    expect(channel).toBe("microsoft-store");
    const updateResult = await page.evaluate(async () =>
      window.api.update.checkManual(),
    );
    expect(updateResult).toMatchObject({
      ok: false,
      errorCode: "UPDATE_MANAGED_BY_STORE",
    });

    const backupResult = unwrap(
      await page.evaluate(async () => window.api.data.exportBackup()),
    );
    expect(backupResult.backupFormatVersion).toBe(3);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);

    await closeSession(session);
    session = undefined;
    reopened = await launchPackaged(profile, backupPath);
    const persisted = await reopened.page.evaluate(async () => {
      const [schedules, courses, exams, labs, grades] = await Promise.all([
        window.api.schedule.list(),
        window.api.timetable.list(),
        window.api.exam.list(),
        window.api.lab.list(),
        window.api.grade.list(),
      ]);
      return { schedules, courses, exams, labs, grades };
    });
    expect(unwrap(persisted.schedules).map((item) => item.title)).toContain(
      `${marker} 日程（已更新）`,
    );
    expect(unwrap(persisted.courses).map((item) => item.name)).toContain(
      `${marker} 课程（已更新）`,
    );
    expect(unwrap(persisted.exams).map((item) => item.courseName)).toContain(
      `${marker} 考试`,
    );
    expect(unwrap(persisted.labs).map((item) => item.name)).toContain(
      `${marker} 实验`,
    );
    expect(unwrap(persisted.grades).map((item) => item.courseName)).toContain(
      `${marker} 成绩`,
    );

    await closeSession(reopened);
    reopened = undefined;
    restored = await launchPackaged(restoredProfile, null, backupPath);
    const inspectionResult = unwrap(
      await restored.page.evaluate(async () => window.api.data.prepareImport()),
    );
    expect(inspectionResult.inspection).toMatchObject({
      backupFormatVersion: 3,
    });
    const inspection = inspectionResult.inspection as BackupInspection;
    expect(inspection.recordCounts.courses).toBeGreaterThan(0);
    const commitResult = unwrap(
      await restored.page.evaluate(
        async (token) => window.api.data.commitImport(token),
        inspection.token,
      ),
    );
    expect(commitResult.databaseSchemaVersion).toBe(2);
    const restoredCourses = unwrap(
      await restored.page.evaluate(async () => window.api.timetable.list()),
    );
    expect(restoredCourses.map((item) => item.name)).toContain(
      `${marker} 课程（已更新）`,
    );
    const restoredPreferences = unwrap(
      await restored.page.evaluate(async () =>
        window.api.timetable.getPreferences(),
      ),
    );
    expect(restoredPreferences.semesterStart).toBe("2026-08-17");
  } finally {
    await closeSession(restored);
    await closeSession(reopened);
    await closeSession(session);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(restoredProfile, { recursive: true, force: true });
  }
});
