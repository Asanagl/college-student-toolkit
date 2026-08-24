import { afterEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const electronMock = vi.hoisted(() => {
  return {
    userData: "",
    fetch: vi.fn(),
    windows: [] as Array<{ webContents: { send: ReturnType<typeof vi.fn> } }>,
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userData },
  BrowserWindow: { getAllWindows: () => electronMock.windows },
  net: { fetch: electronMock.fetch },
}));

electronMock.userData = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-ocr-"));

import {
  OcrComponentService,
  OCR_COMPONENT_MANIFEST,
} from "../../src/main/services/OcrComponentService";
import { OcrService } from "../../src/main/services/OcrService";

const originalManifest = { ...OCR_COMPONENT_MANIFEST };

function hash(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function configureManifest(payload: Buffer): Buffer {
  const compressed = zlib.gzipSync(payload, { level: 9 });
  Object.assign(OCR_COMPONENT_MANIFEST, {
    compressedBytes: compressed.length,
    compressedSha256: hash(compressed),
    extractedBytes: payload.length,
    extractedSha256: hash(payload),
  });
  return compressed;
}

function responseFor(
  compressed: Buffer,
  url = OCR_COMPONENT_MANIFEST.assetUrl,
): Response {
  let sent = false;
  const reader = {
    read: async () => {
      if (sent) return { done: true, value: undefined };
      sent = true;
      return { done: false, value: new Uint8Array(compressed) };
    },
    releaseLock: vi.fn(),
  };
  return {
    ok: true,
    status: 200,
    url,
    body: { getReader: () => reader },
  } as unknown as Response;
}

function responseForChunks(chunks: Buffer[]): Response {
  let index = 0;
  const reader = {
    read: async () => {
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      return { done: false, value: new Uint8Array(value) };
    },
    releaseLock: vi.fn(),
  };
  return {
    ok: true,
    status: 200,
    url: OCR_COMPONENT_MANIFEST.assetUrl,
    body: { getReader: () => reader },
  } as unknown as Response;
}

function languagePath(): string {
  return path.join(
    electronMock.userData,
    "components",
    OCR_COMPONENT_MANIFEST.id,
    OCR_COMPONENT_MANIFEST.version,
    "chi_sim.traineddata",
  );
}

afterEach(async () => {
  const component = OcrComponentService.getInstance();
  await component.dispose();
  fs.rmSync(electronMock.userData, { recursive: true, force: true });
  fs.mkdirSync(electronMock.userData, { recursive: true });
  Object.assign(OCR_COMPONENT_MANIFEST, originalManifest);
  vi.clearAllMocks();
  electronMock.windows = [];
  await OcrService.getInstance().dispose();
});

describe("可选 OCR 组件", () => {
  it("按双哈希流式安装，并能识别篡改后的组件", async () => {
    const payload = Buffer.from("fake-chi-sim-model");
    const compressed = configureManifest(payload);
    electronMock.fetch.mockResolvedValue(responseFor(compressed));
    const service = OcrComponentService.getInstance();
    await service.init();
    await service.init();
    expect(service.getManifest()).toMatchObject({
      id: OCR_COMPONENT_MANIFEST.id,
      version: OCR_COMPONENT_MANIFEST.version,
    });
    expect(service.getInstalledLanguagePath()).toBeNull();
    const statuses: string[] = [];
    const unsubscribe = service.onStatusChange((status) =>
      statuses.push(status.state),
    );
    const failingUnsubscribe = service.onStatusChange(() => {
      throw new Error("UI listener failed");
    });
    electronMock.windows = [{ webContents: { send: vi.fn() } }];

    const result = await service.install();

    expect(result).toMatchObject({ ok: true, data: { state: "ready" } });
    expect(fs.readFileSync(languagePath())).toEqual(payload);
    expect(service.getInstalledLanguagePath()).toBe(languagePath());
    expect(statuses).toContain("downloading");
    expect(statuses.at(-1)).toBe("ready");
    expect(electronMock.windows[0].webContents.send).toHaveBeenCalled();
    unsubscribe();
    failingUnsubscribe();

    const replacement = Buffer.from("replacement-model");
    const replacementCompressed = configureManifest(replacement);
    electronMock.fetch.mockResolvedValue(responseFor(replacementCompressed));
    await expect(service.install()).resolves.toMatchObject({
      ok: true,
      data: { state: "ready" },
    });
    expect(fs.readFileSync(languagePath())).toEqual(replacement);

    fs.writeFileSync(languagePath(), Buffer.from("tampered"));
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: "invalid" },
    });
  });

  it("下载哈希错误时保留已有模型，并清理 partial 文件", async () => {
    const payload = Buffer.from("stable-model");
    const compressed = configureManifest(payload);
    electronMock.fetch.mockResolvedValue(responseFor(compressed));
    const service = OcrComponentService.getInstance();
    await service.init();
    await expect(service.install()).resolves.toMatchObject({ ok: true });
    const previous = fs.readFileSync(languagePath());

    OCR_COMPONENT_MANIFEST.compressedSha256 = "0".repeat(64);
    const failed = await service.install();

    expect(failed).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });
    expect(fs.readFileSync(languagePath())).toEqual(previous);
    expect(
      fs
        .readdirSync(path.dirname(languagePath()))
        .some((name) => name.includes("partial")),
    ).toBe(false);
  });

  it("拒绝同长度篡改，并能在活动下载期间安全销毁服务", async () => {
    const payload = Buffer.from("stable-model-for-status");
    const compressed = configureManifest(payload);
    electronMock.fetch.mockResolvedValue(responseFor(compressed));
    const service = OcrComponentService.getInstance();
    await service.init();
    await expect(service.install()).resolves.toMatchObject({ ok: true });

    // 保持文件大小不变，确保校验确实执行了第二个哈希条件。
    fs.writeFileSync(languagePath(), Buffer.alloc(payload.length, 0x5a));
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: "invalid" },
    });

    const pendingPayload = Buffer.from("pending-model");
    configureManifest(pendingPayload);
    electronMock.fetch.mockImplementation(
      async (_url: string, options?: RequestInit) => {
        const signal = options?.signal;
        const reader = {
          read: () =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  const error = new Error("aborted");
                  Object.defineProperty(error, "name", { value: "AbortError" });
                  reject(error);
                },
                { once: true },
              );
            }),
          releaseLock: vi.fn(),
        };
        return {
          ok: true,
          status: 200,
          url: OCR_COMPONENT_MANIFEST.assetUrl,
          body: { getReader: () => reader },
        } as unknown as Response;
      },
    );
    const pending = service.install();
    await vi.waitFor(() => expect(electronMock.fetch).toHaveBeenCalled());
    await service.dispose();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });
  });

  it("支持取消下载，且没有进行中的下载时取消是幂等的", async () => {
    const payload = Buffer.from("cancel-me");
    configureManifest(payload);
    electronMock.fetch.mockImplementation(
      async (_url: string, options?: RequestInit) => {
        const signal = options?.signal;
        const reader = {
          read: () =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  const error = new Error("aborted");
                  Object.defineProperty(error, "name", { value: "AbortError" });
                  reject(error);
                },
                { once: true },
              );
            }),
          releaseLock: vi.fn(),
        };
        return {
          ok: true,
          status: 200,
          url: OCR_COMPONENT_MANIFEST.assetUrl,
          body: { getReader: () => reader },
        } as unknown as Response;
      },
    );
    const service = OcrComponentService.getInstance();
    await service.init();
    expect(service.cancelInstall()).toMatchObject({ ok: true, data: false });
    const pending = service.install();
    await vi.waitFor(() => expect(electronMock.fetch).toHaveBeenCalled());
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "BACKUP_BUSY",
    });
    expect(service.remove()).toMatchObject({
      ok: false,
      errorCode: "BACKUP_BUSY",
    });
    expect(service.cancelInstall()).toMatchObject({ ok: true, data: true });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: "not-installed" },
    });
  });

  it("rejects non-OK, empty, oversized and invalid OCR responses", async () => {
    const payload = Buffer.from("invalid-response-model");
    configureManifest(payload);
    const service = OcrComponentService.getInstance();
    await service.init();

    electronMock.fetch.mockResolvedValue({
      ok: false,
      status: 503,
    });
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });

    electronMock.fetch.mockRejectedValue("network down");
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });

    electronMock.fetch.mockResolvedValue({ ok: true, status: 200, body: null });
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });

    const oversized = Buffer.alloc(1024 * 1024 + 2, 1);
    Object.assign(OCR_COMPONENT_MANIFEST, {
      compressedBytes: 1,
      compressedSha256: "0".repeat(64),
    });
    electronMock.fetch.mockResolvedValue(responseFor(oversized));
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });

    const chunks = [Buffer.alloc(64 * 1024, 1), Buffer.alloc(64 * 1024, 2)];
    Object.assign(OCR_COMPONENT_MANIFEST, {
      compressedBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
      compressedSha256: "0".repeat(64),
    });
    electronMock.fetch.mockResolvedValue(responseForChunks(chunks));
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });

    const invalidGzip = Buffer.from("not-gzip");
    Object.assign(OCR_COMPONENT_MANIFEST, {
      compressedBytes: invalidGzip.length,
      compressedSha256: hash(invalidGzip),
      extractedBytes: payload.length,
      extractedSha256: hash(payload),
    });
    electronMock.fetch.mockResolvedValue(responseFor(invalidGzip));
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });

    const validCompressed = configureManifest(payload);
    OCR_COMPONENT_MANIFEST.compressedBytes = validCompressed.length + 1;
    electronMock.fetch.mockResolvedValue(responseFor(validCompressed));
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });

    const hashMismatch = configureManifest(payload);
    OCR_COMPONENT_MANIFEST.extractedSha256 = "0".repeat(64);
    electronMock.fetch.mockResolvedValue(responseFor(hashMismatch));
    expect(await service.install()).toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });
  });

  it("allows the fixed GitHub Release asset's real redirect target", async () => {
    const payload = Buffer.from("redirected-model");
    const compressed = configureManifest(payload);
    const redirectUrl =
      "https://release-assets.githubusercontent.com/github-production-release-asset/1290461151/dcbc1ea0-066c-4dcc-9285-c6ab238f9d24?sp=r&sv=2018-11-09&sig=test";
    electronMock.fetch.mockResolvedValue(responseFor(compressed, redirectUrl));

    const service = OcrComponentService.getInstance();
    await service.init();
    await expect(service.install()).resolves.toMatchObject({
      ok: true,
      data: { state: "ready" },
    });
    expect(fs.readFileSync(languagePath())).toEqual(payload);
  });

  it.each([
    "http://release-assets.githubusercontent.com/github-production-release-asset/1290461151/dcbc1ea0-066c-4dcc-9285-c6ab238f9d24?sig=test",
    "https://evil.example/github-production-release-asset/1290461151/dcbc1ea0-066c-4dcc-9285-c6ab238f9d24?sig=test",
    "https://release-assets.githubusercontent.com/other/1290461151/dcbc1ea0-066c-4dcc-9285-c6ab238f9d24?sig=test",
  ])("rejects an untrusted OCR redirect URL: %s", async (redirectUrl) => {
    const payload = Buffer.from("untrusted-redirect-model");
    const compressed = configureManifest(payload);
    electronMock.fetch.mockResolvedValue(responseFor(compressed, redirectUrl));

    const service = OcrComponentService.getInstance();
    await service.init();
    await expect(service.install()).resolves.toMatchObject({
      ok: false,
      errorCode: "OCR_DOWNLOAD_FAILED",
    });
    expect(fs.existsSync(languagePath())).toBe(false);
  });

  it("reports invalid files and can be queried before initialization", async () => {
    const service = OcrComponentService.getInstance();
    await service.dispose();
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: "not-installed" },
    });
    expect(service.getInstalledLanguagePath()).toBeNull();
    fs.mkdirSync(path.dirname(languagePath()), { recursive: true });
    fs.mkdirSync(languagePath());
    expect(service.getStatus()).toMatchObject({
      ok: true,
      data: { state: "invalid" },
    });
    expect(service.remove()).toMatchObject({ ok: true, data: true });
  });

  it("does not require a compressed byte count when the manifest leaves it unspecified", async () => {
    const payload = Buffer.from("model-without-compressed-size");
    const compressed = configureManifest(payload);
    OCR_COMPONENT_MANIFEST.compressedBytes = 0;
    OCR_COMPONENT_MANIFEST.compressedSha256 = hash(compressed);
    electronMock.fetch.mockResolvedValue(responseFor(compressed));

    const service = OcrComponentService.getInstance();
    await service.init();
    await expect(service.install()).resolves.toMatchObject({
      ok: true,
      data: { state: "ready" },
    });
    expect(fs.readFileSync(languagePath())).toEqual(payload);
  });

  it("OCR 识别在组件缺失时返回稳定错误码", async () => {
    const service = OcrComponentService.getInstance();
    await service.init();
    await service.remove();
    await OcrService.getInstance().dispose();

    await expect(
      OcrService.getInstance().recognize(Buffer.from("image")),
    ).rejects.toMatchObject({
      code: "OCR_COMPONENT_MISSING",
    });
  });
});
