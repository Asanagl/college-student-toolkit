import type { AcmDocumentScope } from "../../shared/types";

/**
 * Scope is a product policy, but diff-only scopes also need a page boundary so
 * an unrelated renderer route cannot opt into the unbounded candidate policy.
 */
export function canUseAcmDocumentScope(
  scope: AcmDocumentScope,
  senderUrl: string,
): boolean {
  if (scope === "workbench") return true;
  try {
    const hash = new URL(senderUrl).hash;
    const route = hash.slice(1).split("?", 1)[0];
    return route === "/acm-diff";
  } catch {
    return false;
  }
}
