import {
  app,
  BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type {
  AcmDocument,
  AcmDocumentExternalRequest,
  AcmDocumentExternalState,
  AcmDocumentSaveRequest,
  AcmDocumentScope,
  AcmLineEnding,
  AcmTemplateId,
  DocumentFingerprint,
  IpcResult,
} from "../../shared/types";

export const ACM_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const ACM_MAX_OPEN_BYTES = 64 * 1024 * 1024;
export const ACM_MAX_PENDING_WRITES = 4;
export const ACM_MAX_PENDING_OPEN_OPERATIONS = 64;
export const ACM_MAX_PENDING_SAVE_DIALOGS = 4;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const BACKUP_CLEANUP_RETRIES = 3;
const BACKUP_CLEANUP_DELAY_MS = 250;
const STALE_BACKUP_SUFFIX = ".bak";
const BACKUP_DIRECTORY_INDEX = "acm-file-backups.json";
const MAX_BACKUP_DIRECTORIES = 64;
const STALE_BACKUP_NAME =
  /^(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bak$/i;

const TEMPLATES: Record<AcmTemplateId, string> = {
  blank: "",
  "basic-io":
    "#include <iostream>\n\nint main() {\n    std::ios::sync_with_stdio(false);\n    std::cin.tie(nullptr);\n\n    return 0;\n}\n",
  stl: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    return 0;\n}\n",
};

interface DialogAccess {
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  showOpenDialog(
    parent: BrowserWindow,
    options: OpenDialogOptions,
  ): Promise<OpenDialogReturnValue>;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  showSaveDialog(
    parent: BrowserWindow,
    options: SaveDialogOptions,
  ): Promise<SaveDialogReturnValue>;
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showMessageBox(
    parent: BrowserWindow,
    options: MessageBoxOptions,
  ): Promise<MessageBoxReturnValue>;
}

interface OpenDocumentState {
  bytes: number;
  filePath: string | null;
  scope: AcmDocumentScope;
}

interface PersistedFileState {
  stat: fs.Stats;
  fingerprint: DocumentFingerprint;
  warnings: string[];
}

class RecoveryRequiredError extends Error {
  constructor(readonly backupPath: string) {
    super(`保存失败，原文件已保留在恢复副本：${backupPath}`);
    this.name = "RecoveryRequiredError";
  }
}

class AcmFileBusyError extends Error {
  constructor() {
    super("文件操作正在关闭或繁忙，请稍后重试");
    this.name = "AcmFileBusyError";
  }
}

function errorResult<T>(
  errorCode: IpcResult<T>["errorCode"],
  error: string,
): IpcResult<T> {
  return { ok: false, errorCode, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withWarnings<T>(
  result: IpcResult<T>,
  warnings: string[],
): IpcResult<T> {
  return warnings.length ? { ...result, warnings } : result;
}

function fileErrorCode(
  error: unknown,
  fallback: IpcResult<unknown>["errorCode"] = "ACM_FILE_INVALID",
): IpcResult<unknown>["errorCode"] {
  const message = errorMessage(error);
  if (error instanceof AcmFileBusyError) return "ACM_FILE_BUSY";
  if (error instanceof RecoveryRequiredError)
    return "ACM_FILE_RECOVERY_REQUIRED";
  if (message.includes("只读")) return "ACM_FILE_READONLY";
  if (message.includes("外部")) return "ACM_FILE_CHANGED";
  return fallback;
}

function isDevicePath(filePath: string): boolean {
  return /^(?:\\\\[.?]\\|\\\\\?\\)/.test(filePath);
}

function isUncPath(filePath: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(filePath);
}

function comparablePath(filePath: string): string {
  return path
    .resolve(filePath)
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isReparsePoint(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return true;
    if (process.platform !== "win32") return false;
    return (
      comparablePath(fs.realpathSync.native(filePath)) !==
      comparablePath(filePath)
    );
  } catch {
    return true;
  }
}

function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function ensureCppPath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.trim().length === 0)
    throw new Error("源文件路径不能为空");
  const resolved = path.resolve(filePath);
  if (
    isDevicePath(resolved) ||
    isUncPath(resolved) ||
    path.extname(resolved).toLowerCase() !== ".cpp"
  )
    throw new Error("仅支持 .cpp 源文件和普通 Windows 路径");
  return resolved;
}

function assertRegularPath(filePath: string, allowMissing: boolean): void {
  const resolved = path.resolve(filePath);
  if (isDevicePath(resolved) || isUncPath(resolved))
    throw new Error("不允许设备路径或 UNC 路径");

  const parsed = path.parse(resolved);
  const segments = parsed.dir
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  for (const segment of [...segments, parsed.base]) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (!stat) continue;
    if (isReparsePoint(current)) throw new Error("不允许符号链接或联接点");
    if (current === resolved && !stat.isFile())
      throw new Error("目标不是普通文件");
    if (current !== resolved && !stat.isDirectory())
      throw new Error("源文件父路径不是普通目录");
  }
  if (!allowMissing && !lstatOrNull(resolved)) throw new Error("文件不存在");
}

function detectLineEnding(content: string): AcmLineEnding {
  if (content.includes("\r\n")) return "crlf";
  if (content.includes("\r")) return "cr";
  return "lf";
}

function normalizeLineEnding(
  content: string,
  lineEnding: AcmLineEnding,
): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (lineEnding === "crlf") return normalized.replace(/\n/g, "\r\n");
  if (lineEnding === "cr") return normalized.replace(/\n/g, "\r");
  return normalized;
}

function documentLimit(scope: AcmDocumentScope): number | null {
  return scope === "diff-candidate" ? null : ACM_MAX_DOCUMENT_BYTES;
}

function assertDocumentBytes(bytes: number, scope: AcmDocumentScope): void {
  const limit = documentLimit(scope);
  if (limit !== null && bytes > limit) throw new Error("源文件超过 2 MiB 限制");
}

function fingerprintFromContent(
  stat: fs.Stats,
  content: string,
  lineEnding: AcmLineEnding,
  scope: AcmDocumentScope,
): DocumentFingerprint {
  const normalized = normalizeLineEnding(content, lineEnding);
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (!stat.isFile() || stat.size !== bytes)
    throw new Error("保存后的文件大小不一致");
  assertDocumentBytes(bytes, scope);
  return {
    bytes,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
  };
}

async function isReadOnly(filePath: string, stat: fs.Stats): Promise<boolean> {
  if ((stat.mode & 0o200) === 0) return true;
  try {
    await fs.promises.access(filePath, fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

function sameFingerprint(
  left: DocumentFingerprint,
  right: DocumentFingerprint,
): boolean {
  return (
    left.bytes === right.bytes &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

function externalCheckKey(document: AcmDocumentExternalRequest): string {
  const fingerprint = document.savedFingerprint;
  return JSON.stringify([
    document.documentId,
    document.filePath,
    fingerprint?.bytes ?? null,
    fingerprint?.mtimeMs ?? null,
    fingerprint?.sha256 ?? null,
  ]);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.dev === 0 && left.ino === 0)
    return (
      right.dev === 0 &&
      right.ino === 0 &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
    );
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function defaultUserDataPath(): string {
  try {
    return app.getPath("userData");
  } catch {
    return "";
  }
}

export class AcmFileService {
  private readonly openDocuments = new Map<string, OpenDocumentState>();
  private openGate: Promise<void> = Promise.resolve();
  private writeGate: Promise<void> = Promise.resolve();
  private saveDialogGate: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private readonly pendingWriteDocuments = new Set<string>();
  private pendingOpenOperations = 0;
  private pendingSaveDialogs = 0;
  private readonly pendingExternalChecks = new Map<
    string,
    Promise<IpcResult<AcmDocumentExternalState>>
  >();
  private readonly pendingCleanupRetries = new Set<Promise<void>>();
  private readonly scannedBackupDirectories = new Set<string>();
  private disposing = false;
  private openGeneration = 0;
  private saveGeneration = 0;
  private readonly userDataPath: string;

  constructor(
    private readonly dialogs: DialogAccess = dialog,
    userDataPath?: string,
  ) {
    this.userDataPath = userDataPath ?? defaultUserDataPath();
  }

  async init(): Promise<void> {
    if (this.disposing) return;
    this.loadBackupDirectories();
    await this.scanOpenDocumentBackupDirectories();
    this.persistBackupDirectories();
  }

  createDocument(
    template: AcmTemplateId,
    scope: AcmDocumentScope = "workbench",
  ): IpcResult<AcmDocument> {
    if (this.disposing) return errorResult("ACM_FILE_BUSY", "文件服务正在关闭");
    if (!Object.prototype.hasOwnProperty.call(TEMPLATES, template))
      return errorResult("ACM_FILE_INVALID", "模板不存在");
    const content = TEMPLATES[template];
    const id = randomUUID();
    this.openDocuments.set(id, {
      bytes: Buffer.byteLength(content, "utf8"),
      filePath: null,
      scope,
    });
    return {
      ok: true,
      data: {
        id,
        name: "未命名.cpp",
        filePath: null,
        content,
        lineEnding: "crlf",
        readOnly: false,
        dirty: content.length > 0,
        savedFingerprint: null,
      },
    };
  }

  async openDocument(
    parent: BrowserWindow | null = null,
    scope: AcmDocumentScope = "workbench",
  ): Promise<IpcResult<AcmDocument | null>> {
    const generation = this.openGeneration;
    try {
      return await this.withOpenGate(async () => {
        const result = parent
          ? await this.dialogs.showOpenDialog(parent, this.openOptions())
          : await this.dialogs.showOpenDialog(this.openOptions());
        if (result.canceled || !result.filePaths[0])
          return { ok: true, data: null };
        if (this.disposing || generation !== this.openGeneration)
          return { ok: true, data: null };
        return {
          ok: true,
          data: await this.readDocumentUnlocked(
            result.filePaths[0],
            scope,
            generation,
          ),
        };
      });
    } catch (error) {
      return errorResult(
        fileErrorCode(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async saveDocument(
    request: AcmDocumentSaveRequest,
  ): Promise<IpcResult<AcmDocument>> {
    try {
      if (this.disposing)
        return errorResult("ACM_FILE_BUSY", "文件服务正在关闭");
      const tracked = this.openDocuments.get(request.documentId);
      if (!tracked || !tracked.filePath)
        return errorResult("ACM_FILE_INVALID", "保存路径与已打开文档不匹配");
      const filePath = ensureCppPath(request.filePath ?? "");
      return await this.enqueueWrite(request.documentId, () =>
        this.saveDocumentUnlocked(request, filePath, tracked),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(fileErrorCode(error), message);
    }
  }

  async saveDocumentAs(
    request: AcmDocumentSaveRequest,
    parent: BrowserWindow | null = null,
  ): Promise<IpcResult<AcmDocument | null>> {
    const generation = this.saveGeneration;
    try {
      if (this.disposing)
        return errorResult("ACM_FILE_BUSY", "文件服务正在关闭");
      const tracked = this.openDocuments.get(request.documentId);
      if (!tracked) return errorResult("ACM_FILE_INVALID", "文档未打开");
      const result = parent
        ? await this.withSaveDialog(() =>
            this.dialogs.showSaveDialog(
              parent,
              this.saveOptions(request.filePath),
            ),
          )
        : await this.withSaveDialog(() =>
            this.dialogs.showSaveDialog(this.saveOptions(request.filePath)),
          );
      if (result.canceled || !result.filePath) return { ok: true, data: null };
      if (this.disposing || generation !== this.saveGeneration)
        return { ok: true, data: null };
      const filePath = ensureCppPath(this.withCppExtension(result.filePath));
      return await this.enqueueWrite(request.documentId, async () => {
        if (
          this.disposing ||
          generation !== this.saveGeneration ||
          this.openDocuments.get(request.documentId) !== tracked
        )
          return errorResult("ACM_FILE_BUSY", "文档已关闭，无法继续保存");
        if (!(await this.confirmOverwrite(filePath, parent)))
          return { ok: true, data: null };
        if (
          this.disposing ||
          generation !== this.saveGeneration ||
          this.openDocuments.get(request.documentId) !== tracked
        )
          return errorResult("ACM_FILE_BUSY", "文档已关闭，无法继续保存");
        return this.saveDocumentAsUnlocked(request, filePath, tracked);
      });
    } catch (error) {
      return errorResult(
        fileErrorCode(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async checkExternal(
    document: AcmDocumentExternalRequest,
  ): Promise<IpcResult<AcmDocumentExternalState>> {
    if (this.disposing) return errorResult("ACM_FILE_BUSY", "文件服务正在关闭");
    if (!document.filePath || !document.savedFingerprint)
      return { ok: true, data: { changed: false, fingerprint: null } };
    const key = externalCheckKey(document);
    const inFlight = this.pendingExternalChecks.get(key);
    if (inFlight) return inFlight;
    const operation = this.checkExternalOnce(document);
    this.pendingExternalChecks.set(key, operation);
    try {
      return await operation;
    } catch (error) {
      return errorResult(
        fileErrorCode(error, "ACM_FILE_CHANGED"),
        errorMessage(error),
      );
    } finally {
      if (this.pendingExternalChecks.get(key) === operation)
        this.pendingExternalChecks.delete(key);
    }
  }

  releaseDocument(documentId: string): IpcResult<boolean> {
    if (typeof documentId !== "string" || documentId.trim().length === 0)
      return errorResult("ACM_FILE_INVALID", "文档标识无效");
    this.openDocuments.delete(documentId);
    return { ok: true, data: true };
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.openGeneration += 1;
    this.saveGeneration += 1;
    await Promise.all([this.openGate, this.writeGate, this.saveDialogGate]);
    await Promise.allSettled([...this.pendingCleanupRetries]);
    this.pendingExternalChecks.clear();
    this.openDocuments.clear();
    this.scannedBackupDirectories.clear();
  }

  async scanBackupDirectory(directory: string): Promise<string[]> {
    return this.cleanupStaleBackupsInDirectory(directory);
  }

  private async readDocumentUnlocked(
    filePath: string,
    scope: AcmDocumentScope,
    generation = this.openGeneration,
  ): Promise<AcmDocument> {
    const resolved = ensureCppPath(filePath);
    assertRegularPath(resolved, false);
    const streamed = await this.streamFile(
      resolved,
      scope,
      true,
      () => this.disposing || generation !== this.openGeneration,
    );
    if (this.disposing || generation !== this.openGeneration)
      throw new AcmFileBusyError();
    const openBytes = [...this.openDocuments.values()].reduce(
      (total, state) =>
        state.scope === "diff-candidate" ? total : total + state.bytes,
      0,
    );
    if (
      scope !== "diff-candidate" &&
      openBytes + streamed.fingerprint.bytes > ACM_MAX_OPEN_BYTES
    )
      throw new Error("打开源码总量超过 64 MiB，请先关闭标签");
    const rawContent = streamed.content;
    if (rawContent === undefined) throw new Error("文件读取失败，请重试");
    const content = normalizeLineEnding(rawContent, "lf");
    const document: AcmDocument = {
      id: randomUUID(),
      name: path.basename(resolved),
      filePath: resolved,
      content,
      lineEnding: detectLineEnding(rawContent),
      readOnly: await isReadOnly(resolved, streamed.stat),
      dirty: false,
      savedFingerprint: streamed.fingerprint,
    };
    this.openDocuments.set(document.id, {
      bytes: streamed.fingerprint.bytes,
      filePath: resolved,
      scope,
    });
    return document;
  }

  private async withOpenGate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposing) throw new AcmFileBusyError();
    if (this.pendingOpenOperations >= ACM_MAX_PENDING_OPEN_OPERATIONS)
      throw new AcmFileBusyError();
    this.pendingOpenOperations += 1;
    const previous = this.openGate;
    let release!: () => void;
    this.openGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      this.pendingOpenOperations -= 1;
      release();
    }
  }

  private async withSaveDialog<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposing) throw new AcmFileBusyError();
    if (this.pendingSaveDialogs >= ACM_MAX_PENDING_SAVE_DIALOGS)
      throw new AcmFileBusyError();
    this.pendingSaveDialogs += 1;
    const previous = this.saveDialogGate;
    let release!: () => void;
    this.saveDialogGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      this.pendingSaveDialogs -= 1;
      release();
    }
  }

  private async withWriteGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeGate;
    let release!: () => void;
    this.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async enqueueWrite<T>(
    documentId: string,
    operation: () => Promise<IpcResult<T>>,
  ): Promise<IpcResult<T>> {
    const admission = this.admitWrite(documentId);
    if (admission) return errorResult("ACM_FILE_BUSY", admission);
    try {
      return await this.withWriteGate(operation);
    } finally {
      this.pendingWrites -= 1;
      this.pendingWriteDocuments.delete(documentId);
    }
  }

  private admitWrite(documentId: string): string | null {
    if (this.disposing) return "文件服务正在关闭，请稍后重试";
    if (this.pendingWriteDocuments.has(documentId))
      return "同一文档已有保存操作，请等待完成";
    if (this.pendingWrites >= ACM_MAX_PENDING_WRITES)
      return "待处理保存操作过多，请稍后重试";
    this.pendingWrites += 1;
    this.pendingWriteDocuments.add(documentId);
    return null;
  }

  private async saveDocumentUnlocked(
    request: AcmDocumentSaveRequest,
    filePath: string,
    tracked: OpenDocumentState,
  ): Promise<IpcResult<AcmDocument>> {
    if (this.openDocuments.get(request.documentId) !== tracked)
      return errorResult("ACM_FILE_BUSY", "文档已关闭，无法继续保存");
    if (!tracked.filePath || !samePath(tracked.filePath, filePath))
      return errorResult("ACM_FILE_INVALID", "保存路径与已打开文档不匹配");
    const persisted = await this.writeDocument(
      filePath,
      request,
      tracked.scope,
    );
    if (this.openDocuments.get(request.documentId) !== tracked)
      return errorResult("ACM_FILE_BUSY", "文档已关闭，保存结果未重新登记");
    const document = await this.savedDocument(request, filePath, persisted);
    this.trackDocument(document, tracked.scope);
    return withWarnings({ ok: true, data: document }, persisted.warnings);
  }

  private async saveDocumentAsUnlocked(
    request: AcmDocumentSaveRequest,
    filePath: string,
    tracked: OpenDocumentState,
  ): Promise<IpcResult<AcmDocument>> {
    if (this.openDocuments.get(request.documentId) !== tracked)
      return errorResult("ACM_FILE_BUSY", "文档已关闭，无法继续保存");
    const persisted = await this.writeDocument(
      filePath,
      { ...request, filePath, force: true },
      tracked.scope,
    );
    if (this.openDocuments.get(request.documentId) !== tracked)
      return errorResult("ACM_FILE_BUSY", "文档已关闭，保存结果未重新登记");
    const document = await this.savedDocument(request, filePath, persisted);
    this.trackDocument(document, tracked.scope);
    return withWarnings({ ok: true, data: document }, persisted.warnings);
  }

  private async checkExternalUnlocked(
    document: AcmDocumentExternalRequest,
  ): Promise<IpcResult<AcmDocumentExternalState>> {
    if (!document.filePath || !document.savedFingerprint)
      return { ok: true, data: { changed: false, fingerprint: null } };
    const filePath = ensureCppPath(document.filePath);
    const tracked = this.openDocuments.get(document.documentId);
    if (!tracked || !tracked.filePath || !samePath(tracked.filePath, filePath))
      return errorResult("ACM_FILE_INVALID", "文档未打开");
    assertRegularPath(filePath, false);
    const current = await this.readFingerprint(filePath, tracked.scope);
    return {
      ok: true,
      data: {
        changed: !sameFingerprint(current, document.savedFingerprint),
        fingerprint: current,
      },
    };
  }

  private async checkExternalOnce(
    document: AcmDocumentExternalRequest,
  ): Promise<IpcResult<AcmDocumentExternalState>> {
    try {
      return await this.withOpenGate(() =>
        this.checkExternalUnlocked(document),
      );
    } catch (error) {
      return errorResult(
        fileErrorCode(error, "ACM_FILE_CHANGED"),
        errorMessage(error),
      );
    }
  }

  private async confirmOverwrite(
    filePath: string,
    parent: BrowserWindow | null,
  ): Promise<boolean> {
    if (!(await this.pathExists(filePath))) return true;
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: ["覆盖", "取消"],
      defaultId: 1,
      cancelId: 1,
      title: "确认覆盖",
      message: "目标文件已存在，是否覆盖？",
    };
    const confirmation = parent
      ? await this.dialogs.showMessageBox(parent, options)
      : await this.dialogs.showMessageBox(options);
    return confirmation.response === 0;
  }

  private async readFingerprint(
    filePath: string,
    scope: AcmDocumentScope,
  ): Promise<DocumentFingerprint> {
    const streamed = await this.streamFile(filePath, scope, false);
    return streamed.fingerprint;
  }

  private async streamFile(
    filePath: string,
    scope: AcmDocumentScope,
    includeContent: boolean,
    shouldCancel?: () => boolean,
  ): Promise<{
    content?: string;
    fingerprint: DocumentFingerprint;
    stat: fs.Stats;
  }> {
    const pathBeforeOpen = await fs.promises.stat(filePath);
    const handle = await fs.promises.open(filePath, "r");
    try {
      const initial = await handle.stat();
      if (!initial.isFile()) throw new Error("源文件不是普通文件");
      if (!sameFileIdentity(pathBeforeOpen, initial))
        throw new Error("文件在打开时发生变化，请重新打开");
      assertDocumentBytes(initial.size, scope);
      const read = await this.readFileChunks(
        handle,
        initial.size,
        includeContent,
        shouldCancel,
      );
      const afterRead = await fs.promises.stat(filePath);
      if (
        !sameFileIdentity(initial, afterRead) ||
        afterRead.size !== initial.size ||
        afterRead.mtimeMs !== initial.mtimeMs
      )
        throw new Error("文件在读取时发生变化，请重新打开");
      return {
        content: read.content,
        fingerprint: {
          bytes: afterRead.size,
          mtimeMs: afterRead.mtimeMs,
          sha256: read.sha256,
        },
        stat: afterRead,
      };
    } finally {
      await handle.close();
    }
  }

  private async readFileChunks(
    handle: FileHandle,
    size: number,
    includeContent: boolean,
    shouldCancel?: () => boolean,
  ): Promise<{ content?: string; sha256: string }> {
    const hash = createHash("sha256");
    const decoder = includeContent
      ? new TextDecoder("utf-8", { fatal: true })
      : null;
    const chunks: string[] = [];
    const buffer = Buffer.allocUnsafe(FILE_READ_CHUNK_BYTES);
    let position = 0;
    try {
      while (position < size) {
        if (shouldCancel?.()) throw new AcmFileBusyError();
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, size - position),
          position,
        );
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (decoder) chunks.push(decoder.decode(chunk, { stream: true }));
        position += bytesRead;
      }
      if (position !== size) throw new Error("文件读取不完整，请重试");
      if (decoder) chunks.push(decoder.decode());
    } catch (error) {
      if (decoder && error instanceof TypeError)
        throw new Error("文件不是 UTF-8 编码，请先转换后再打开");
      throw error;
    }
    return {
      content: decoder ? chunks.join("") : undefined,
      sha256: hash.digest("hex"),
    };
  }

  private async writeDocument(
    filePath: string,
    request: AcmDocumentSaveRequest,
    scope: AcmDocumentScope,
  ): Promise<PersistedFileState> {
    const normalizedContent = normalizeLineEnding(
      request.content,
      request.lineEnding,
    );
    const bytes = Buffer.byteLength(normalizedContent, "utf8");
    assertDocumentBytes(bytes, scope);
    assertRegularPath(filePath, true);
    await this.assertWritableTarget(filePath, request, scope);
    const warnings = await this.replaceFile(filePath, normalizedContent, () =>
      this.revalidateWritableTarget(filePath, request, scope),
    );
    const stat = await fs.promises.stat(filePath);
    return {
      stat,
      fingerprint: fingerprintFromContent(
        stat,
        request.content,
        request.lineEnding,
        scope,
      ),
      warnings,
    };
  }

  private async assertWritableTarget(
    filePath: string,
    request: AcmDocumentSaveRequest,
    scope: AcmDocumentScope,
  ): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (request.force) return;
        throw new Error("文件已被外部删除，请重新加载、另存为或确认覆盖");
      }
      throw error;
    }
    if (await isReadOnly(filePath, stat))
      throw new Error("目标文件是只读文件，请使用另存为");
    if (request.force) return;
    if (!request.expectedFingerprint)
      throw new Error("缺少文件指纹，文件可能已被外部修改，请重新加载后再保存");
    const current = await this.readFingerprint(filePath, scope);
    if (!sameFingerprint(current, request.expectedFingerprint))
      throw new Error("文件已被外部修改，请重新加载、另存为或确认覆盖");
  }

  private async revalidateWritableTarget(
    filePath: string,
    request: AcmDocumentSaveRequest,
    scope: AcmDocumentScope,
  ): Promise<void> {
    assertRegularPath(filePath, true);
    await this.assertWritableTarget(filePath, request, scope);
  }

  private async replaceFile(
    filePath: string,
    content: string,
    beforeReplace?: () => Promise<void>,
  ): Promise<string[]> {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${filePath}.${process.pid}.${randomUUID()}.bak`;
    this.rememberBackupDirectory(filePath);
    let backupRetained = false;
    try {
      await fs.promises.writeFile(tempPath, content, "utf8");
      if (beforeReplace) await beforeReplace();
      if (await this.pathExists(filePath)) {
        await fs.promises.rename(filePath, backupPath);
        try {
          await fs.promises.rename(tempPath, filePath);
        } catch (error) {
          try {
            await fs.promises.rename(backupPath, filePath);
          } catch {
            backupRetained = true;
            throw new RecoveryRequiredError(backupPath);
          }
          throw error;
        }
        const warning = await this.cleanupBackupAfterReplace(backupPath);
        return warning ? [warning] : [];
      } else {
        await fs.promises.rename(tempPath, filePath);
        return [];
      }
    } catch (error) {
      await this.removeQuietly(tempPath);
      if (!backupRetained) await this.removeQuietly(backupPath);
      throw error;
    }
  }

  private async cleanupBackupAfterReplace(
    backupPath: string,
  ): Promise<string | null> {
    if (await this.removeBackupFile(backupPath)) return null;
    this.scheduleBackupCleanup(backupPath);
    return `保存成功，但清理恢复副本失败：${backupPath}`;
  }

  private async removeBackupFile(backupPath: string): Promise<boolean> {
    try {
      assertRegularPath(backupPath, true);
      await fs.promises.rm(backupPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private scheduleBackupCleanup(backupPath: string): void {
    const retry = this.retryBackupCleanup(backupPath);
    this.pendingCleanupRetries.add(retry);
    void retry.then(
      () => this.pendingCleanupRetries.delete(retry),
      () => this.pendingCleanupRetries.delete(retry),
    );
  }

  private rememberBackupDirectory(filePath: string): void {
    const directory = path.resolve(path.dirname(filePath));
    this.scannedBackupDirectories.add(directory);
    if (this.scannedBackupDirectories.size > MAX_BACKUP_DIRECTORIES) {
      const first = this.scannedBackupDirectories.values().next().value;
      if (first && first !== directory)
        this.scannedBackupDirectories.delete(first);
    }
    this.persistBackupDirectories();
  }

  private backupIndexPath(): string {
    return path.join(this.userDataPath, BACKUP_DIRECTORY_INDEX);
  }

  private loadBackupDirectories(): void {
    if (!this.userDataPath) return;
    try {
      const value = JSON.parse(
        fs.readFileSync(this.backupIndexPath(), "utf8"),
      ) as Record<string, unknown>;
      if (
        value.formatVersion !== 1 ||
        value.kind !== "acm-file-backup-directories" ||
        !Array.isArray(value.directories)
      )
        return;
      for (const entry of value.directories) {
        if (typeof entry !== "string" || !entry.trim()) continue;
        const resolved = path.resolve(entry);
        if (
          isDevicePath(resolved) ||
          isUncPath(resolved) ||
          isReparsePoint(resolved)
        )
          continue;
        this.scannedBackupDirectories.add(resolved);
        if (this.scannedBackupDirectories.size >= MAX_BACKUP_DIRECTORIES) break;
      }
    } catch {
      // A missing or corrupt index is non-fatal; the next save recreates it.
    }
  }

  private persistBackupDirectories(): void {
    if (!this.userDataPath) return;
    try {
      fs.mkdirSync(this.userDataPath, { recursive: true });
      const target = this.backupIndexPath();
      const tempPath = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(
        tempPath,
        `${JSON.stringify({
          formatVersion: 1,
          kind: "acm-file-backup-directories",
          directories: [...this.scannedBackupDirectories],
        })}\n`,
        "utf8",
      );
      fs.renameSync(tempPath, target);
    } catch (error) {
      console.warn(
        `[acm-file] 保存备份扫描目录失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async scanOpenDocumentBackupDirectories(): Promise<void> {
    const directories = new Set<string>();
    for (const state of this.openDocuments.values()) {
      if (!state.filePath) continue;
      directories.add(path.resolve(path.dirname(state.filePath)));
    }
    for (const directory of this.scannedBackupDirectories)
      directories.add(directory);
    const remaining = new Set<string>();
    for (const directory of directories) {
      const warnings = await this.cleanupStaleBackupsInDirectory(directory);
      if (warnings.length > 0) remaining.add(directory);
    }
    this.scannedBackupDirectories.clear();
    for (const directory of remaining)
      this.scannedBackupDirectories.add(directory);
  }

  private async cleanupStaleBackupsInDirectory(
    directory: string,
  ): Promise<string[]> {
    const resolved = path.resolve(directory);
    const warnings: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(STALE_BACKUP_SUFFIX))
        continue;
      const match = STALE_BACKUP_NAME.exec(entry.name);
      if (!match) continue;
      const backupPath = path.join(resolved, entry.name);
      try {
        assertRegularPath(backupPath, true);
        if (isReparsePoint(backupPath)) continue;
        if (!(await this.removeBackupFile(backupPath)))
          warnings.push(`启动扫描未能删除遗留备份：${backupPath}`);
      } catch {
        warnings.push(`启动扫描跳过不安全备份：${backupPath}`);
      }
    }
    return warnings;
  }

  private async retryBackupCleanup(backupPath: string): Promise<void> {
    for (let attempt = 1; attempt <= BACKUP_CLEANUP_RETRIES; attempt += 1) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, attempt * BACKUP_CLEANUP_DELAY_MS),
      );
      if (await this.removeBackupFile(backupPath)) return;
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async removeQuietly(filePath: string): Promise<void> {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {
      // Preserve the primary write error; the recovery path reports its backup.
    }
  }

  private async savedDocument(
    request: AcmDocumentSaveRequest,
    filePath: string,
    persisted: PersistedFileState,
  ): Promise<AcmDocument> {
    const { stat, fingerprint } = persisted;
    return {
      id: request.documentId,
      name: path.basename(filePath),
      filePath,
      content: normalizeLineEnding(request.content, "lf"),
      lineEnding: request.lineEnding,
      readOnly: await isReadOnly(filePath, stat),
      dirty: false,
      savedFingerprint: fingerprint,
    };
  }

  private trackDocument(document: AcmDocument, scope: AcmDocumentScope): void {
    this.openDocuments.set(document.id, {
      bytes:
        document.savedFingerprint?.bytes ??
        Buffer.byteLength(document.content, "utf8"),
      filePath: document.filePath,
      scope,
    });
  }

  private withCppExtension(filePath: string): string {
    return path.extname(filePath) ? filePath : `${filePath}.cpp`;
  }

  private openOptions(): OpenDialogOptions {
    return {
      properties: ["openFile"],
      filters: [{ name: "C++ 源文件", extensions: ["cpp"] }],
    };
  }

  private saveOptions(filePath: string | null): SaveDialogOptions {
    return {
      defaultPath: filePath ? path.basename(filePath) : "未命名.cpp",
      filters: [{ name: "C++ 源文件", extensions: ["cpp"] }],
    };
  }
}

export const acmFileService = new AcmFileService();
