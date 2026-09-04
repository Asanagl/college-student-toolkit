import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const ATOMIC_RENAME_ATTEMPTS = 5;
const ATOMIC_RENAME_RETRY_DELAY_MS = 10;

function waitForRenameRetry(): void {
  // Windows antivirus and indexer handles are transient; a bounded wait
  // preserves atomic replacement without falling back to truncate-in-place.
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    ATOMIC_RENAME_RETRY_DELAY_MS,
  );
}

function isRetryableRenameError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["EPERM", "EACCES", "EBUSY"].includes(String(error.code));
}

/**
 * Writes a small JSON/text state file through a same-directory temporary file.
 * The finally block is intentional: a failed writeFileSync can leave a
 * partially-created temporary file even before rename is attempted.
 */
export function writeTextFileAtomically(target: string, data: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let lastError: unknown;
  try {
    fs.writeFileSync(temporary, data, { encoding: "utf8", flag: "wx" });
    for (let attempt = 0; attempt < ATOMIC_RENAME_ATTEMPTS; attempt += 1) {
      try {
        fs.renameSync(temporary, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isRetryableRenameError(error)) break;
        if (attempt + 1 < ATOMIC_RENAME_ATTEMPTS) waitForRenameRetry();
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("原子文件替换失败");
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Never mask the original write/rename error with best-effort cleanup.
    }
  }
}
