import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AcmDocumentExternalRequest,
  AcmDocumentExternalState,
  AcmDocumentSaveRequest,
  IpcResult,
} from "../../src/shared/types";
import { AcmFileService } from "../../src/main/services/AcmFileService";

vi.mock("electron", () => ({ dialog: {} }));

const directories: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-acm-file-"));
  directories.push(directory);
  return directory;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function request(
  documentId: string,
  filePath: string | null,
  content: string,
  expectedFingerprint: AcmDocumentSaveRequest["expectedFingerprint"] = null,
  force = false,
): AcmDocumentSaveRequest {
  return {
    documentId,
    filePath,
    content,
    lineEnding: "crlf",
    expectedFingerprint,
    force,
  };
}

type PrivateAcmFileService = {
  checkExternalOnce(
    document: AcmDocumentExternalRequest,
  ): Promise<IpcResult<AcmDocumentExternalState>>;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("AcmFileService", () => {
  it("reads BOM UTF-8, normalizes editor content, and releases document bytes", async () => {
    const directory = tempDirectory();
    const filePath = path.join(directory, "main.cpp");
    fs.writeFileSync(
      filePath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("int main() {\r\n  return 0;\r\n}\r\n", "utf8"),
      ]),
    );
    const service = new AcmFileService({
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [filePath],
      })),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    });

    const opened = await service.openDocument();
    expect(opened).toMatchObject({
      ok: true,
      data: {
        filePath,
        content: "int main() {\n  return 0;\n}\n",
        lineEnding: "crlf",
        dirty: false,
      },
    });
    const document = opened.data;
    if (!document) throw new Error("文档未打开");
    expect(service.releaseDocument(document.id)).toEqual({
      ok: true,
      data: true,
    });
    await service.dispose();
  });

  it("opens and saves oversized candidate documents without widening workbench limits", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "candidate.cpp");
    const savedPath = path.join(directory, "candidate-copy.cpp");
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    fs.writeFileSync(sourcePath, oversized, "utf8");
    const service = new AcmFileService({
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [sourcePath],
      })),
      showSaveDialog: vi.fn(async () => ({
        canceled: false,
        filePath: savedPath,
      })),
      showMessageBox: vi.fn(),
    });

    const opened = await service.openDocument(null, "diff-candidate");
    expect(opened).toMatchObject({
      ok: true,
      data: {
        content: oversized,
        savedFingerprint: { bytes: oversized.length },
      },
    });
    if (!opened.ok || !opened.data) throw new Error("待测源码未打开");
    const saved = await service.saveDocumentAs(
      request(opened.data.id, sourcePath, oversized),
    );
    expect(saved).toMatchObject({
      ok: true,
      data: { savedFingerprint: { bytes: oversized.length } },
    });
    expect(fs.statSync(savedPath).size).toBe(oversized.length);
    const external = await service.checkExternal({
      documentId: opened.data.id,
      filePath: saved.data?.filePath ?? savedPath,
      savedFingerprint: saved.data?.savedFingerprint ?? null,
    });
    expect(external).toMatchObject({ ok: true, data: { changed: false } });
  });

  it("does not charge unbounded candidate bytes against ordinary open capacity", async () => {
    const directory = tempDirectory();
    const candidatePath = path.join(directory, "candidate.cpp");
    const workbenchPath = path.join(directory, "workbench.cpp");
    fs.writeFileSync(candidatePath, "x".repeat(2 * 1024 * 1024 + 1), "utf8");
    fs.writeFileSync(workbenchPath, "int main() {}\n", "utf8");
    const dialogs = {
      showOpenDialog: vi
        .fn()
        .mockResolvedValueOnce({ canceled: false, filePaths: [candidatePath] })
        .mockResolvedValueOnce({ canceled: false, filePaths: [workbenchPath] }),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    };
    const service = new AcmFileService(dialogs);
    await expect(
      service.openDocument(null, "diff-candidate"),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.openDocument()).resolves.toMatchObject({
      ok: true,
      data: { filePath: workbenchPath },
    });
  });

  it("keeps the 2 MiB cap for ordinary workbench file opens", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "workbench.cpp");
    fs.writeFileSync(sourcePath, "x".repeat(2 * 1024 * 1024 + 1), "utf8");
    const service = new AcmFileService({
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [sourcePath],
      })),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    });

    await expect(service.openDocument()).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
    });
  });

  it("rejects malformed UTF-8 without retaining a document", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "invalid.cpp");
    fs.writeFileSync(sourcePath, Buffer.from([0xc3, 0x28]));
    const service = new AcmFileService({
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [sourcePath],
      })),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    });

    await expect(service.openDocument()).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
      error: "文件不是 UTF-8 编码，请先转换后再打开",
    });
  });

  it("serializes ordinary opens before enforcing the aggregate byte budget", async () => {
    const directory = tempDirectory();
    const sourcePath = path.join(directory, "large.cpp");
    fs.writeFileSync(sourcePath, "x".repeat(2 * 1024 * 1024), "utf8");
    const service = new AcmFileService({
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [sourcePath],
      })),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    });

    const results = await Promise.all(
      Array.from({ length: 33 }, () => service.openDocument()),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(32);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: "打开源码总量超过 64 MiB，请先关闭标签" },
    ]);
  });

  it("does not reuse an external check after the document fingerprint changes", async () => {
    const service = new AcmFileService({
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    });
    const firstFingerprint = { bytes: 1, mtimeMs: 1, sha256: "first" };
    const secondFingerprint = { bytes: 2, mtimeMs: 2, sha256: "second" };
    const firstResult = deferred<IpcResult<AcmDocumentExternalState>>();
    const secondResult = deferred<IpcResult<AcmDocumentExternalState>>();
    const checkOnce = vi
      .spyOn(service as unknown as PrivateAcmFileService, "checkExternalOnce")
      .mockImplementation(async (document) => {
        return document.savedFingerprint?.sha256 === "first"
          ? firstResult.promise
          : secondResult.promise;
      });
    const firstRequest: AcmDocumentExternalRequest = {
      documentId: "document",
      filePath: "document.cpp",
      savedFingerprint: firstFingerprint,
    };
    const first = service.checkExternal(firstRequest);
    await Promise.resolve();
    const second = service.checkExternal({
      ...firstRequest,
      savedFingerprint: secondFingerprint,
    });
    expect(checkOnce).toHaveBeenCalledTimes(2);
    firstResult.resolve({
      ok: true,
      data: { changed: false, fingerprint: firstFingerprint },
    });
    secondResult.resolve({
      ok: true,
      data: { changed: false, fingerprint: secondFingerprint },
    });
    await expect(first).resolves.toMatchObject({
      ok: true,
      data: { fingerprint: firstFingerprint },
    });
    await expect(second).resolves.toMatchObject({
      ok: true,
      data: { fingerprint: secondFingerprint },
    });
  });

  it("bounds admitted open dialogs before they can queue indefinitely", async () => {
    const pendingDialogs = Array.from({ length: 64 }, () =>
      deferred<{ canceled: boolean; filePaths: string[] }>(),
    );
    let dialogIndex = 0;
    const dialogs = {
      showOpenDialog: vi.fn(() => pendingDialogs[dialogIndex++].promise),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    };
    const service = new AcmFileService(dialogs);
    const opens = Array.from({ length: 65 }, () => service.openDocument());
    await expect(opens[64]).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_BUSY",
    });
    expect(dialogs.showOpenDialog).toHaveBeenCalledTimes(1);
    for (const pending of pendingDialogs)
      pending.resolve({ canceled: true, filePaths: [] });
    await expect(Promise.all(opens.slice(0, 64))).resolves.toHaveLength(64);
  });

  it("bounds admitted save dialogs independently from the write queue", async () => {
    const pendingDialogs = Array.from({ length: 4 }, () =>
      deferred<{ canceled: boolean; filePath?: string }>(),
    );
    let dialogIndex = 0;
    const dialogs = {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(() => pendingDialogs[dialogIndex++].promise),
      showMessageBox: vi.fn(),
    };
    const service = new AcmFileService(dialogs);
    const documents = Array.from({ length: 5 }, () => {
      const created = service.createDocument("blank");
      if (!created.ok || !created.data) throw new Error("文档创建失败");
      return created.data;
    });
    const saves = documents.map((document) =>
      service.saveDocumentAs(request(document.id, null, "content")),
    );
    await expect(saves[4]).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_BUSY",
    });
    expect(dialogs.showSaveDialog).toHaveBeenCalledTimes(1);
    for (const pending of pendingDialogs)
      pending.resolve({ canceled: true, filePath: undefined });
    await expect(Promise.all(saves.slice(0, 4))).resolves.toHaveLength(4);
  });

  it("saves with the selected line ending and rejects an external change", async () => {
    const directory = tempDirectory();
    const filePath = path.join(directory, "main.cpp");
    fs.writeFileSync(filePath, "old\n", "utf8");
    const service = new AcmFileService({
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [filePath],
      })),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    });
    const opened = await service.openDocument();
    if (!opened.ok || !opened.data) throw new Error("文档未打开");
    const saved = await service.saveDocument(
      request(
        opened.data.id,
        filePath,
        "new\nline\n",
        opened.data.savedFingerprint,
      ),
    );
    expect(saved).toMatchObject({ ok: true, data: { content: "new\nline\n" } });
    expect(fs.readFileSync(filePath, "utf8")).toBe("new\r\nline\r\n");

    fs.writeFileSync(filePath, "changed\n", "utf8");
    const rejected = await service.saveDocument(
      request(
        opened.data.id,
        filePath,
        "unsafe",
        saved.data?.savedFingerprint ?? null,
      ),
    );
    expect(rejected).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_CHANGED",
    });
    fs.rmSync(filePath);
    const deleted = await service.saveDocument(
      request(
        opened.data.id,
        filePath,
        "recreate",
        saved.data?.savedFingerprint ?? null,
      ),
    );
    expect(deleted).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_CHANGED",
    });
    expect(fs.existsSync(filePath)).toBe(false);
    const missingFingerprint = await service.saveDocument(
      request(opened.data.id, filePath, "unsafe", null),
    );
    expect(missingFingerprint).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_CHANGED",
    });
    const forced = await service.saveDocument(
      request(opened.data.id, filePath, "forced", null, true),
    );
    expect(forced).toMatchObject({ ok: true, data: { dirty: false } });
  });

  it("adds cpp extension, asks before overwrite, and rejects invalid paths/content", async () => {
    const directory = tempDirectory();
    const target = path.join(directory, "existing.cpp");
    fs.writeFileSync(target, "old", "utf8");
    const dialogs = {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(async () => ({
        canceled: false,
        filePath: path.join(directory, "existing"),
      })),
      showMessageBox: vi.fn(async () => ({
        response: 1,
        checkboxChecked: false,
      })),
    };
    const service = new AcmFileService(dialogs);
    const document = service.createDocument("blank");
    if (!document.ok || !document.data) throw new Error("文档创建失败");
    const cancelled = await service.saveDocumentAs(
      request(document.data.id, null, "new"),
    );
    expect(cancelled).toEqual({ ok: true, data: null });
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(
      await service.saveDocument({
        ...request(document.data.id, target, "should not overwrite"),
        force: true,
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
    });
    expect(fs.readFileSync(target, "utf8")).toBe("old");

    expect(
      await service.saveDocument({
        ...request(document.data.id, "bad.txt", "x"),
        force: true,
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
    });
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(
      await service.saveDocument({
        ...request(document.data.id, target, "x".repeat(2 * 1024 * 1024 + 1)),
        force: true,
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
    });
  });

  it("rejects duplicate saves and bounds the write queue", async () => {
    const directory = tempDirectory();
    const target = path.join(directory, "existing.cpp");
    fs.writeFileSync(target, "old", "utf8");
    const firstConfirmation = deferred<void>();
    const releaseConfirmation = deferred<void>();
    let messageCalls = 0;
    const dialogs = {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(async () => ({
        canceled: false,
        filePath: target,
      })),
      showMessageBox: vi.fn(async () => {
        messageCalls += 1;
        if (messageCalls === 1) {
          firstConfirmation.resolve();
          await releaseConfirmation.promise;
        }
        return { response: 1, checkboxChecked: false };
      }),
    };
    const service = new AcmFileService(dialogs);
    const documents = Array.from({ length: 5 }, () => {
      const created = service.createDocument("blank");
      if (!created.ok || !created.data) throw new Error("文档创建失败");
      return created.data;
    });
    const saves = documents.map((document, index) =>
      service.saveDocumentAs(request(document.id, null, `content-${index}`)),
    );
    await firstConfirmation.promise;
    await expect(saves[4]).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_BUSY",
    });
    releaseConfirmation.resolve();
    const results = await Promise.all(saves.slice(0, 4));
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.ok && result.data === null)).toBe(
      true,
    );
    expect(messageCalls).toBe(4);

    const duplicateReady = deferred<void>();
    const duplicateRelease = deferred<void>();
    dialogs.showMessageBox.mockImplementationOnce(async () => {
      duplicateReady.resolve();
      await duplicateRelease.promise;
      return { response: 1, checkboxChecked: false };
    });
    const duplicate = service.createDocument("blank");
    if (!duplicate.ok || !duplicate.data) throw new Error("文档创建失败");
    const first = service.saveDocumentAs(
      request(duplicate.data.id, null, "one"),
    );
    await duplicateReady.promise;
    const second = await service.saveDocumentAs(
      request(duplicate.data.id, null, "two"),
    );
    expect(second).toMatchObject({ ok: false, errorCode: "ACM_FILE_BUSY" });
    duplicateRelease.resolve();
    await expect(first).resolves.toMatchObject({ ok: true, data: null });
  });

  it("waits for admitted operations during dispose and does not retain released documents", async () => {
    const directory = tempDirectory();
    const target = path.join(directory, "existing.cpp");
    fs.writeFileSync(target, "old", "utf8");
    const confirmationReady = deferred<void>();
    const releaseConfirmation = deferred<void>();
    const dialogs = {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(async () => ({
        canceled: false,
        filePath: target,
      })),
      showMessageBox: vi.fn(async () => {
        confirmationReady.resolve();
        await releaseConfirmation.promise;
        return { response: 0, checkboxChecked: false };
      }),
    };
    const service = new AcmFileService(dialogs);
    const created = service.createDocument("blank");
    if (!created.ok || !created.data) throw new Error("文档创建失败");
    const saving = service.saveDocumentAs(
      request(created.data.id, null, "new content"),
    );
    await confirmationReady.promise;
    expect(service.releaseDocument(created.data.id)).toMatchObject({
      ok: true,
    });
    let disposed = false;
    const disposing = service.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    releaseConfirmation.resolve();
    await expect(saving).resolves.toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_BUSY",
    });
    await disposing;
    expect(disposed).toBe(true);
    expect(service.createDocument("blank")).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_BUSY",
    });
    expect(fs.readFileSync(target, "utf8")).toBe("old");
  });
});
