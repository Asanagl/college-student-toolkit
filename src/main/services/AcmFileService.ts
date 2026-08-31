import {
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

class RecoveryRequiredError extends Error {
  constructor(readonly backupPath: string) {
    super(`保存失败，原文件已保留在恢复副本：${backupPath}`);
    this.name = "RecoveryRequiredError";
  }
}

function errorResult<T>(
  errorCode: IpcResult<T>["errorCode"],
  error: string,
): IpcResult<T> {
  return { ok: false, errorCode, error };
}

function fileErrorCode(error: unknown): IpcResult<unknown>["errorCode"] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RecoveryRequiredError)
    return "ACM_FILE_RECOVERY_REQUIRED";
  if (message.includes("只读")) return "ACM_FILE_READONLY";
  if (message.includes("外部")) return "ACM_FILE_CHANGED";
  return "ACM_FILE_INVALID";
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
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (isReparsePoint(current)) throw new Error("不允许符号链接或联接点");
    if (current === resolved && !stat.isFile())
      throw new Error("目标不是普通文件");
    if (current !== resolved && !stat.isDirectory())
      throw new Error("源文件父路径不是普通目录");
  }
  if (!allowMissing && !fs.existsSync(resolved)) throw new Error("文件不存在");
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

function readUtf8(buffer: Buffer): string {
  const value =
    buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function documentLimit(scope: AcmDocumentScope): number | null {
  return scope === "diff-candidate" ? null : ACM_MAX_DOCUMENT_BYTES;
}

function assertDocumentBytes(bytes: number, scope: AcmDocumentScope): void {
  const limit = documentLimit(scope);
  if (limit !== null && bytes > limit) throw new Error("源文件超过 2 MiB 限制");
}

function fingerprint(
  filePath: string,
  scope: AcmDocumentScope = "workbench",
): DocumentFingerprint {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("源文件不是普通文件");
  assertDocumentBytes(stat.size, scope);
  return {
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex"),
  };
}

function fingerprintFromBuffer(
  stat: fs.Stats,
  buffer: Buffer,
  scope: AcmDocumentScope,
): DocumentFingerprint {
  assertDocumentBytes(buffer.byteLength, scope);
  return {
    bytes: buffer.byteLength,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function fingerprintFromContent(
  filePath: string,
  content: string,
  lineEnding: AcmLineEnding,
  scope: AcmDocumentScope,
): DocumentFingerprint {
  const buffer = Buffer.from(normalizeLineEnding(content, lineEnding), "utf8");
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size !== buffer.byteLength)
    throw new Error("保存后的文件大小不一致");
  assertDocumentBytes(stat.size, scope);
  return fingerprintFromBuffer(stat, buffer, scope);
}

function isReadOnly(filePath: string, stat: fs.Stats): boolean {
  if ((stat.mode & 0o200) === 0) return true;
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
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

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export class AcmFileService {
  private readonly openDocuments = new Map<string, OpenDocumentState>();

  constructor(private readonly dialogs: DialogAccess = dialog) {}

  async init(): Promise<void> {}

  createDocument(
    template: AcmTemplateId,
    scope: AcmDocumentScope = "workbench",
  ): IpcResult<AcmDocument> {
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
    try {
      const result = parent
        ? await this.dialogs.showOpenDialog(parent, this.openOptions())
        : await this.dialogs.showOpenDialog(this.openOptions());
      if (result.canceled || !result.filePaths[0])
        return { ok: true, data: null };
      return {
        ok: true,
        data: this.readDocument(result.filePaths[0], scope),
      };
    } catch (error) {
      return errorResult(
        "ACM_FILE_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  saveDocument(request: AcmDocumentSaveRequest): IpcResult<AcmDocument> {
    try {
      if (!request.filePath)
        return errorResult("ACM_FILE_INVALID", "没有保存路径，请使用另存为");
      const filePath = ensureCppPath(request.filePath);
      const tracked = this.openDocuments.get(request.documentId);
      if (
        !tracked ||
        !tracked.filePath ||
        !samePath(tracked.filePath, filePath)
      )
        return errorResult("ACM_FILE_INVALID", "保存路径与已打开文档不匹配");
      this.writeDocument(filePath, request, tracked.scope);
      const document = this.savedDocument(request, filePath, tracked.scope);
      this.trackDocument(document, tracked.scope);
      return { ok: true, data: document };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(fileErrorCode(error), message);
    }
  }

  async saveDocumentAs(
    request: AcmDocumentSaveRequest,
    parent: BrowserWindow | null = null,
  ): Promise<IpcResult<AcmDocument | null>> {
    try {
      const tracked = this.openDocuments.get(request.documentId);
      if (!tracked) return errorResult("ACM_FILE_INVALID", "文档未打开");
      const result = parent
        ? await this.dialogs.showSaveDialog(
            parent,
            this.saveOptions(request.filePath),
          )
        : await this.dialogs.showSaveDialog(this.saveOptions(request.filePath));
      if (result.canceled || !result.filePath) return { ok: true, data: null };
      const filePath = ensureCppPath(this.withCppExtension(result.filePath));
      if (fs.existsSync(filePath)) {
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
        if (confirmation.response !== 0) return { ok: true, data: null };
      }
      this.writeDocument(
        filePath,
        { ...request, filePath, force: true },
        tracked.scope,
      );
      const document = this.savedDocument(request, filePath, tracked.scope);
      this.trackDocument(document, tracked.scope);
      return { ok: true, data: document };
    } catch (error) {
      return errorResult(
        fileErrorCode(error),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  checkExternal(
    document: AcmDocumentExternalRequest,
  ): IpcResult<AcmDocumentExternalState> {
    try {
      if (!document.filePath || !document.savedFingerprint)
        return { ok: true, data: { changed: false, fingerprint: null } };
      const filePath = ensureCppPath(document.filePath);
      const tracked = this.openDocuments.get(document.documentId);
      if (
        !tracked ||
        !tracked.filePath ||
        !samePath(tracked.filePath, filePath)
      )
        return errorResult("ACM_FILE_INVALID", "文档未打开");
      assertRegularPath(filePath, false);
      const current = fingerprint(filePath, tracked.scope);
      return {
        ok: true,
        data: {
          changed: !sameFingerprint(current, document.savedFingerprint),
          fingerprint: current,
        },
      };
    } catch (error) {
      return errorResult(
        "ACM_FILE_CHANGED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  releaseDocument(documentId: string): IpcResult<boolean> {
    if (typeof documentId !== "string" || documentId.trim().length === 0)
      return errorResult("ACM_FILE_INVALID", "文档标识无效");
    this.openDocuments.delete(documentId);
    return { ok: true, data: true };
  }

  async dispose(): Promise<void> {
    this.openDocuments.clear();
  }

  private readDocument(filePath: string, scope: AcmDocumentScope): AcmDocument {
    const resolved = ensureCppPath(filePath);
    assertRegularPath(resolved, false);
    const stat = fs.statSync(resolved);
    assertDocumentBytes(stat.size, scope);
    const buffer = fs.readFileSync(resolved);
    const afterRead = fs.statSync(resolved);
    if (afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs)
      throw new Error("文件在读取时发生变化，请重新打开");
    const savedFingerprint = fingerprintFromBuffer(afterRead, buffer, scope);
    const openBytes = [...this.openDocuments.values()].reduce(
      (total, state) => total + state.bytes,
      0,
    );
    if (
      scope !== "diff-candidate" &&
      openBytes + buffer.byteLength > ACM_MAX_OPEN_BYTES
    )
      throw new Error("打开源码总量超过 64 MiB，请先关闭标签");
    let rawContent: string;
    try {
      rawContent = readUtf8(buffer);
    } catch {
      throw new Error("文件不是 UTF-8 编码，请先转换后再打开");
    }
    const content = normalizeLineEnding(rawContent, "lf");
    const document: AcmDocument = {
      id: randomUUID(),
      name: path.basename(resolved),
      filePath: resolved,
      content,
      lineEnding: detectLineEnding(rawContent),
      readOnly: isReadOnly(resolved, stat),
      dirty: false,
      savedFingerprint,
    };
    this.openDocuments.set(document.id, {
      bytes: buffer.byteLength,
      filePath: resolved,
      scope,
    });
    return document;
  }

  private writeDocument(
    filePath: string,
    request: AcmDocumentSaveRequest,
    scope: AcmDocumentScope,
  ): void {
    const bytes = Buffer.byteLength(request.content, "utf8");
    assertDocumentBytes(bytes, scope);
    assertRegularPath(filePath, true);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (isReadOnly(filePath, stat))
        throw new Error("目标文件是只读文件，请使用另存为");
      if (!request.force) {
        if (!request.expectedFingerprint)
          throw new Error(
            "缺少文件指纹，文件可能已被外部修改，请重新加载后再保存",
          );
        if (
          !sameFingerprint(
            fingerprint(filePath, scope),
            request.expectedFingerprint,
          )
        )
          throw new Error("文件已被外部修改，请重新加载、另存为或确认覆盖");
      }
    }
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${filePath}.${process.pid}.${randomUUID()}.bak`;
    fs.writeFileSync(
      tempPath,
      normalizeLineEnding(request.content, request.lineEnding),
      "utf8",
    );
    let backupRetained = false;
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, backupPath);
        try {
          fs.renameSync(tempPath, filePath);
        } catch (error) {
          try {
            fs.renameSync(backupPath, filePath);
          } catch {
            backupRetained = true;
            throw new RecoveryRequiredError(backupPath);
          }
          throw error;
        }
        fs.rmSync(backupPath, { force: true });
      } else {
        fs.renameSync(tempPath, filePath);
      }
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if (!backupRetained) fs.rmSync(backupPath, { force: true });
      throw error;
    }
  }

  private savedDocument(
    request: AcmDocumentSaveRequest,
    filePath: string,
    scope: AcmDocumentScope,
  ): AcmDocument {
    const stat = fs.statSync(filePath);
    return {
      id: request.documentId,
      name: path.basename(filePath),
      filePath,
      content: normalizeLineEnding(request.content, "lf"),
      lineEnding: request.lineEnding,
      readOnly: isReadOnly(filePath, stat),
      dirty: false,
      savedFingerprint: fingerprintFromContent(
        filePath,
        request.content,
        request.lineEnding,
        scope,
      ),
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
