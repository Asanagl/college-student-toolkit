import type { AcmDiffDifference } from "../../shared/types";

/**
 * A compact, renderer-safe description of the first token mismatch.
 * The complete program output stays in the main process; only these bounded
 * context arrays cross the IPC boundary.
 */
export type AcmTokenDifference = AcmDiffDifference;

export interface AcmTokenCompareMatch {
  status: "match";
}

export interface AcmTokenCompareMismatch {
  status: "mismatch";
  difference: AcmTokenDifference;
}

export type AcmTokenCompareResult =
  | AcmTokenCompareMatch
  | AcmTokenCompareMismatch;

export const ACM_TOKEN_CONTEXT = 3;
export const ACM_TOKEN_DISPLAY_BYTES = 64 * 1024;
export const ACM_DIFF_CONTEXT_BYTES = 256 * 1024;

function tokenize(output: string): string[] {
  // String#split with \s also treats CRLF, tabs and all Unicode whitespace as
  // separators, which is the comparison contract for ACM output.
  const trimmed = output.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/u);
}

function context(
  tokens: string[],
  mismatchIndex: number,
): {
  values: string[];
  start: number;
} {
  const start = Math.max(0, mismatchIndex - ACM_TOKEN_CONTEXT);
  const end = Math.min(tokens.length, mismatchIndex + ACM_TOKEN_CONTEXT + 1);
  return { values: tokens.slice(start, end), start };
}

function displayToken(token: string): string {
  const value = Buffer.from(token, "utf8");
  if (value.byteLength <= ACM_TOKEN_DISPLAY_BYTES) return token;
  const suffix = Buffer.from("…", "utf8");
  return `${value
    .subarray(0, ACM_TOKEN_DISPLAY_BYTES - suffix.byteLength)
    .toString("utf8")}…`;
}

function boundedContext(tokens: string[]): string[] {
  const result: string[] = [];
  let total = 0;
  for (const token of tokens) {
    const displayed = displayToken(token);
    const size = Buffer.byteLength(displayed, "utf8");
    if (result.length > 0 && total + size > ACM_DIFF_CONTEXT_BYTES) break;
    result.push(displayed);
    total += size;
  }
  return result;
}

/**
 * Compares two outputs token-by-token and returns only the first mismatch.
 * Deliberately avoids a line diff: formatting differences must not affect ACM
 * judging while token contents remain exact.
 */
export function compareAcmTokens(
  referenceOutput: string,
  candidateOutput: string,
): AcmTokenCompareResult {
  const reference = tokenize(referenceOutput);
  const candidate = tokenize(candidateOutput);
  const limit = Math.max(reference.length, candidate.length);
  let mismatchIndex = -1;
  for (let index = 0; index < limit; index += 1) {
    if (reference[index] !== candidate[index]) {
      mismatchIndex = index;
      break;
    }
  }
  if (mismatchIndex < 0) return { status: "match" };

  const referenceContext = context(reference, mismatchIndex);
  const candidateContext = context(candidate, mismatchIndex);
  const difference: AcmTokenDifference = {
    referenceTokens: boundedContext(referenceContext.values),
    candidateTokens: boundedContext(candidateContext.values),
    referenceStart: referenceContext.start,
    candidateStart: candidateContext.start,
  };
  if (mismatchIndex >= candidate.length)
    difference.candidateMissing = reference.length - mismatchIndex;
  if (mismatchIndex >= reference.length)
    difference.referenceMissing = candidate.length - mismatchIndex;
  return { status: "mismatch", difference };
}

export const AcmTokenComparator = {
  compare: compareAcmTokens,
};
