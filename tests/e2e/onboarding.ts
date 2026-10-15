import { expect, type Page } from "@playwright/test";

/**
 * Packaged tests use isolated profiles, so a new profile normally opens the
 * welcome dialog.  Tests skip it through the same user-facing action instead
 * of adding a production-only bypass that could hide onboarding for users.
 */
export async function skipOnboarding(page: Page): Promise<void> {
  const modal = page
    .locator(".ant-modal")
    .filter({ hasText: "欢迎使用大学生工具组" })
    .last();
  if (!(await modal.isVisible().catch(() => false))) return;
  await modal.getByRole("button", { name: "跳过引导" }).click();
  await expect(modal).toBeHidden();
}
