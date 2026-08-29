import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

test.setTimeout(120_000);

type AppSession = { app: ElectronApplication; page: Page };
type FixtureServer = { server: Server; origin: string };

const executablePath = path.resolve(
  process.env.PACKAGED_EXECUTABLE?.trim() ||
    "release-v0.4.0-msix-local/win-unpacked/大学生工具组.exe",
);
const entryFixturePath = path.resolve(
  "tests/fixtures/import-browser-entry.html",
);
const courseFixturePath = path.resolve(
  "tests/fixtures/import-browser-course.html",
);
const ocrArchivePath = path.resolve("ocr-chi-sim-1.0.0.traineddata.gz");

function createProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "college-toolkit-import-"));
}

async function startFixtureServer(): Promise<FixtureServer> {
  const entry = fs.readFileSync(entryFixturePath, "utf8");
  const course = fs.readFileSync(courseFixturePath, "utf8");
  const server = createServer((request, response) => {
    const body =
      request.url === "/schedule" ? course : request.url === "/" ? entry : null;
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("本地教务 fixture 未取得监听地址");
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function stopFixtureServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function launchPackaged(profile: string): Promise<AppSession> {
  if (!fs.existsSync(executablePath)) {
    throw new Error(`找不到 packaged E2E 可执行文件：${executablePath}`);
  }
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, COLLEGE_TOOLKIT_STORE_SMOKE: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page).toHaveTitle("大学生工具组");
  return { app, page };
}

function seedOcrComponent(profile: string): void {
  if (!fs.existsSync(ocrArchivePath)) {
    throw new Error(`找不到仓库内 OCR fixture：${ocrArchivePath}`);
  }
  const target = path.join(
    profile,
    "components",
    "ocr-chi-sim",
    "1.0.0",
    "chi_sim.traineddata",
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zlib.gunzipSync(fs.readFileSync(ocrArchivePath)));
}

async function autoApproveHttp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & {
      __collegeToolkitHttpPrompts?: number;
    };
    state.__collegeToolkitHttpPrompts = 0;
    const patched = dialog as unknown as {
      showMessageBox: (...args: unknown[]) => Promise<unknown>;
    };
    patched.showMessageBox = async () => {
      state.__collegeToolkitHttpPrompts =
        (state.__collegeToolkitHttpPrompts ?? 0) + 1;
      return { response: 1, checkboxChecked: false };
    };
  });
}

async function remoteUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed())
      .map((contents) => contents.getURL()),
  );
}

async function remoteEvaluate<T>(
  app: ElectronApplication,
  origin: string,
  expression: string,
): Promise<T> {
  return app.evaluate(
    async ({ webContents }, target) => {
      const view = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            !contents.isDestroyed() &&
            contents.getURL().startsWith(target.origin),
        );
      if (!view) throw new Error(`找不到教务 fixture 页面：${target.origin}`);
      return view.executeJavaScript(target.expression) as Promise<T>;
    },
    { origin, expression },
  );
}

async function closeSession(session: AppSession | undefined): Promise<void> {
  await session?.app.close();
}

test("OCR 未安装时 packaged DOM 导入仍可用", async () => {
  const profile = createProfile();
  let session: AppSession | undefined;
  try {
    session = await launchPackaged(profile);
    const status = await session.page.evaluate(() =>
      window.api.ocrComponent.getStatus(),
    );
    const fixtureHtml = fs.readFileSync(courseFixturePath, "utf8");
    const parsed = await session.page.evaluate(
      (html) => window.api.importBrowser.parseDom(html),
      fixtureHtml,
    );

    expect(status).toMatchObject({
      ok: true,
      data: { state: "not-installed", currentBytes: 0 },
    });
    expect(parsed).toMatchObject({
      ok: true,
      data: [{ name: "数据结构", location: "教学楼C303" }],
    });
  } finally {
    await closeSession(session);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("fixture 教务站支持 HTTP 确认、window.open、DOM/OCR 冲突合并", async () => {
  const profile = createProfile();
  const fixture = await startFixtureServer();
  let session: AppSession | undefined;
  try {
    seedOcrComponent(profile);
    session = await launchPackaged(profile);
    const { app, page } = session;
    await autoApproveHttp(app);
    await page.getByText("课程表", { exact: true }).click();

    const toolbarPromise = app.waitForEvent("window");
    await page.getByRole("button", { name: "自动导入" }).click();
    const toolbar = await toolbarPromise;
    await expect(toolbar).toHaveTitle("教务系统导入");
    await toolbar
      .getByPlaceholder("输入教务系统网址并回车")
      .fill(fixture.origin);
    await toolbar.getByRole("button", { name: "前往" }).click();
    await expect
      .poll(() => remoteUrls(app), { timeout: 15_000 })
      .toContain(`${fixture.origin}/`);

    await remoteEvaluate<void>(
      app,
      fixture.origin,
      'document.getElementById("open-schedule").click()',
    );
    await expect
      .poll(() => remoteUrls(app), { timeout: 15_000 })
      .toContain(`${fixture.origin}/schedule`);
    await expect
      .poll(
        () => remoteEvaluate<string>(app, fixture.origin, "document.title"),
        {
          timeout: 15_000,
        },
      )
      .toBe("课程表");

    await toolbar.getByRole("button", { name: "开始识别" }).click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
    const extraction = await page.evaluate(async () =>
      window.api.importBrowser.extractDom(),
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) throw new Error(extraction.error ?? "DOM 提取失败");
    const parsedDom = await page.evaluate(
      async (html) => window.api.importBrowser.parseDom(html),
      extraction.data,
    );
    expect(parsedDom).toMatchObject({ ok: true });
    expect(
      parsedDom.ok && parsedDom.data?.map((course) => course.name),
    ).toContain("数据结构");

    const conflict = page
      .locator(".ant-modal")
      .filter({ hasText: "DOM 与 OCR 结果冲突比对" })
      .last();
    await expect(conflict).toBeVisible({ timeout: 30_000 });
    await expect(conflict).toContainText("数据结构");
    await expect(conflict).toContainText("OCR");
    await conflict.getByRole("radio", { name: "OCR" }).check();
    await conflict.getByRole("button", { name: "确认导入" }).click();
    await expect(page.locator("body")).toContainText("OCR");

    const courses = await page.evaluate(async () =>
      window.api.timetable.list(),
    );
    expect(courses).toMatchObject({ ok: true });
    expect(courses.ok && courses.data?.map((course) => course.name)).toContain(
      "OCR",
    );
    const promptCount = await app.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __collegeToolkitHttpPrompts?: number;
          }
        ).__collegeToolkitHttpPrompts ?? 0,
    );
    expect(promptCount).toBeGreaterThanOrEqual(2);
  } finally {
    await closeSession(session);
    await stopFixtureServer(fixture.server);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
