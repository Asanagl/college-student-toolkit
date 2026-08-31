import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcmDocumentSaveRequest } from "../../src/shared/types";
import { AcmFileService } from "../../src/main/services/AcmFileService";

vi.mock("electron", () => ({ dialog: {} }));

const directories: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-acm-file-"));
  directories.push(directory);
  return directory;
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
    const saved = service.saveDocument(
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
    const rejected = service.saveDocument(
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
    const missingFingerprint = service.saveDocument(
      request(opened.data.id, filePath, "unsafe", null),
    );
    expect(missingFingerprint).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_CHANGED",
    });
    const forced = service.saveDocument(
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
      service.saveDocument({
        ...request(document.data.id, target, "should not overwrite"),
        force: true,
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
    });
    expect(fs.readFileSync(target, "utf8")).toBe("old");

    expect(
      service.saveDocument({
        ...request(document.data.id, "bad.txt", "x"),
        force: true,
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
    });
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(
      service.saveDocument({
        ...request(document.data.id, target, "x".repeat(2 * 1024 * 1024 + 1)),
        force: true,
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "ACM_FILE_INVALID",
    });
  });
});
