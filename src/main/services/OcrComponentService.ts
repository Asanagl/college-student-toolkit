// 可选 OCR 组件管理：只有用户明确点击安装时才访问固定 Release 资产。
import { app, BrowserWindow, net } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  IPC_CHANNELS,
  type IpcResult,
  type OcrComponentManifest,
  type OcrComponentStatus,
} from "../../shared/types";

export const OCR_COMPONENT_MANIFEST: OcrComponentManifest = {
  id: "ocr-chi-sim",
  version: "1.0.0",
  engine: "tesseract.js 5.x",
  assetUrl:
    "https://github.com/Asanagl/college-student-toolkit/releases/download/v0.3.0/ocr-chi-sim-1.0.0.traineddata.gz",
  compressedBytes: 1_710_883,
  extractedBytes: 2_471_033,
  compressedSha256:
    "037B9E59AB3598EF6E892E1DC9AB7D34AE993B555C7296B9E08A2F0675648A9E",
  extractedSha256:
    "9784F7C917C546424B690FCDE708CE1F604A4393D08BB51DDAB146D7D7C794E6",
  license: "Apache-2.0 / tesseract-ocr language data",
};

function hash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").toUpperCase();
}

function initialStatus(): OcrComponentStatus {
  return {
    id: OCR_COMPONENT_MANIFEST.id,
    version: OCR_COMPONENT_MANIFEST.version,
    state: "not-installed",
    currentBytes: 0,
    totalBytes: OCR_COMPONENT_MANIFEST.extractedBytes,
    progress: 0,
  };
}

export class OcrComponentService {
  private static instance: OcrComponentService | null = null;
  private initialized = false;
  private controller: AbortController | null = null;
  private status: OcrComponentStatus = initialStatus();
  private readonly listeners = new Set<(status: OcrComponentStatus) => void>();
  private root = "";

  private constructor() {}

  static getInstance(): OcrComponentService {
    if (!OcrComponentService.instance)
      OcrComponentService.instance = new OcrComponentService();
    return OcrComponentService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.root = path.join(
      app.getPath("userData"),
      "components",
      OCR_COMPONENT_MANIFEST.id,
      OCR_COMPONENT_MANIFEST.version,
    );
    this.refreshStatus();
    this.initialized = true;
  }

  getManifest(): OcrComponentManifest {
    return { ...OCR_COMPONENT_MANIFEST };
  }

  getStatus(): IpcResult<OcrComponentStatus> {
    this.ensureRoot();
    this.refreshStatus();
    return { ok: true, data: { ...this.status } };
  }

  getInstalledLanguagePath(): string | null {
    this.ensureRoot();
    const filePath = this.languagePath();
    return this.status.state === "ready" && fs.existsSync(filePath)
      ? filePath
      : null;
  }

  onStatusChange(callback: (status: OcrComponentStatus) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async install(): Promise<IpcResult<OcrComponentStatus>> {
    this.ensureRoot();
    if (this.controller)
      return { ok: false, error: "OCR 组件正在下载", errorCode: "BACKUP_BUSY" };
    this.controller = new AbortController();
    this.setStatus({
      state: "downloading",
      currentBytes: 0,
      progress: 0,
      error: undefined,
    });
    const partial = `${this.languagePath()}.${process.pid}.partial`;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      fs.rmSync(partial, { force: true });
      const response = await net.fetch(OCR_COMPONENT_MANIFEST.assetUrl, {
        signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      const compressed = await this.downloadCompressed(response, partial);
      this.verifyCompressed(compressed);
      const extracted = zlib.gunzipSync(compressed);
      this.verifyExtracted(extracted);
      this.installAtomically(extracted);
      this.setStatus({
        state: "ready",
        currentBytes: extracted.length,
        totalBytes: extracted.length,
        progress: 100,
        error: undefined,
      });
      return { ok: true, data: { ...this.status } };
    } catch (error) {
      fs.rmSync(partial, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      if ((error as { name?: string }).name === "AbortError") {
        this.setStatus({
          state: "not-installed",
          currentBytes: 0,
          progress: 0,
          error: undefined,
        });
        return {
          ok: false,
          error: "OCR 下载已取消",
          errorCode: "OCR_DOWNLOAD_FAILED",
        };
      }
      this.setStatus({ state: "error", error: message });
      return { ok: false, error: message, errorCode: "OCR_DOWNLOAD_FAILED" };
    } finally {
      this.controller = null;
    }
  }

  cancelInstall(): IpcResult<boolean> {
    if (!this.controller) return { ok: true, data: false };
    this.controller.abort();
    return { ok: true, data: true };
  }

  remove(): IpcResult<boolean> {
    this.ensureRoot();
    if (this.controller)
      return {
        ok: false,
        error: "请先取消正在进行的下载",
        errorCode: "BACKUP_BUSY",
      };
    fs.rmSync(this.root, { recursive: true, force: true });
    this.setStatus({
      state: "not-installed",
      currentBytes: 0,
      progress: 0,
      error: undefined,
    });
    return { ok: true, data: true };
  }

  async dispose(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    this.listeners.clear();
    this.initialized = false;
  }

  private languagePath(): string {
    return path.join(this.root, "chi_sim.traineddata");
  }

  private ensureRoot(): void {
    if (this.root) return;
    this.root = path.join(
      app.getPath("userData"),
      "components",
      OCR_COMPONENT_MANIFEST.id,
      OCR_COMPONENT_MANIFEST.version,
    );
  }

  private refreshStatus(): void {
    const filePath = this.languagePath();
    if (!fs.existsSync(filePath)) {
      this.status = initialStatus();
      return;
    }
    try {
      const data = fs.readFileSync(filePath);
      const valid =
        data.length === OCR_COMPONENT_MANIFEST.extractedBytes &&
        hash(data) === OCR_COMPONENT_MANIFEST.extractedSha256;
      this.status = valid
        ? {
            ...initialStatus(),
            state: "ready",
            currentBytes: data.length,
            totalBytes: data.length,
            progress: 100,
          }
        : {
            ...initialStatus(),
            state: "invalid",
            currentBytes: data.length,
            error: "组件哈希或大小不匹配",
          };
    } catch (error) {
      this.status = {
        ...initialStatus(),
        state: "invalid",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private setStatus(patch: Partial<OcrComponentStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) {
      try {
        listener({ ...this.status });
      } catch {
        /* 单个 UI 订阅者失败不应中断下载 */
      }
    }
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send(
        IPC_CHANNELS.OCR_COMPONENT_ON_STATUS_CHANGE,
        this.status,
      );
  }

  private async downloadCompressed(
    response: Response,
    target: string,
  ): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("下载响应没有可读内容");
    const output = fs.createWriteStream(target, { flags: "wx" });
    const finished = new Promise<void>((resolve, reject) => {
      output.once("finish", resolve);
      output.once("error", reject);
    });
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        total += chunk.length;
        if (total > OCR_COMPONENT_MANIFEST.compressedBytes + 1024 * 1024)
          throw new Error("OCR 下载响应超过大小限制");
        if (!output.write(chunk)) await once(output, "drain");
        this.setStatus({
          currentBytes: total,
          totalBytes: OCR_COMPONENT_MANIFEST.compressedBytes,
          progress: Math.min(
            99,
            (total / OCR_COMPONENT_MANIFEST.compressedBytes) * 100,
          ),
        });
      }
      output.end();
      await finished;
      return fs.readFileSync(target);
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error(String(error)));
      await finished.catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private verifyCompressed(data: Buffer): void {
    if (
      OCR_COMPONENT_MANIFEST.compressedBytes > 0 &&
      data.length !== OCR_COMPONENT_MANIFEST.compressedBytes
    )
      throw new Error("OCR 压缩包大小不匹配");
    if (hash(data) !== OCR_COMPONENT_MANIFEST.compressedSha256)
      throw new Error("OCR 压缩包 SHA-256 校验失败");
  }

  private verifyExtracted(data: Buffer): void {
    if (
      data.length !== OCR_COMPONENT_MANIFEST.extractedBytes ||
      hash(data) !== OCR_COMPONENT_MANIFEST.extractedSha256
    )
      throw new Error("OCR 解压文件 SHA-256 校验失败");
  }

  private installAtomically(data: Buffer): void {
    fs.mkdirSync(this.root, { recursive: true });
    const partial = `${this.languagePath()}.${process.pid}.partial`;
    const previous = `${this.languagePath()}.${process.pid}.previous`;
    fs.writeFileSync(partial, data);
    if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
    if (fs.existsSync(this.languagePath()))
      fs.renameSync(this.languagePath(), previous);
    try {
      fs.renameSync(partial, this.languagePath());
      fs.rmSync(previous, { force: true });
    } catch (error) {
      fs.rmSync(partial, { force: true });
      if (fs.existsSync(previous)) fs.renameSync(previous, this.languagePath());
      throw error;
    }
  }
}

export const ocrComponentService = OcrComponentService.getInstance();
