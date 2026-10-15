/** 更新渠道只描述更新责任方，不携带任何账号或发布凭据。 */
export type UpdateChannel = "development" | "github" | "microsoft-store";

/**
 * 根据运行时环境选择更新责任方。
 * Windows Store 包不能再启动 electron-updater，否则会与 Store 的更新事务冲突。
 */
export function resolveUpdateChannel(
  isPackaged: boolean,
  isWindowsStore: boolean,
): UpdateChannel {
  if (!isPackaged) return "development";
  return isWindowsStore ? "microsoft-store" : "github";
}
