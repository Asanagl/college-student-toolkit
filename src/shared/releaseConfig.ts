import packageJson from "../../package.json";

/** 集中维护跨运行时、备份和打包脚本使用的版本维度。 */
export const RELEASE_CONFIG = {
  productVersion: packageJson.version,
  databaseSchemaVersion: 2,
  backupFormatVersion: 3,
  portableSettingsVersion: 2,
  pluginApiVersion: 1,
  windowsMinVersion: "10.0.22621.0",
  msixIdentityVersion: "0.5.0.0",
} as const;

export type ReleaseConfig = typeof RELEASE_CONFIG;
