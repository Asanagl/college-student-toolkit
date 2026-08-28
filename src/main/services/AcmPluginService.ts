import { app } from "electron";
import * as os from "node:os";
import type {
  AcmPluginState,
  AcmPluginStatus,
  IpcResult,
  TrustedPluginManifest,
} from "../../shared/types";
import { RELEASE_CONFIG } from "../../shared/releaseConfig";
import { portableSettingsService } from "./PortableSettingsService";

const MANIFEST: TrustedPluginManifest = {
  id: "acm-code-workbench",
  name: "ACM 临时 IDE",
  pluginApiVersion: RELEASE_CONFIG.pluginApiVersion,
  capabilities: ["acm.documents", "acm.compiler", "acm.runner"],
};

export class AcmPluginService {
  private state: AcmPluginState = "initializing";
  private error: string | undefined;
  private errorCode: AcmPluginStatus["errorCode"];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    const enabled = portableSettingsService.get().acm.enabled;
    if (!this.isSupportedPlatform()) {
      this.state = "unsupported";
      this.initialized = true;
      return;
    }
    if (!enabled) {
      this.state = "disabled";
      this.initialized = true;
      return;
    }
    if (!this.validateManifest()) {
      this.state = "error";
      this.errorCode = "ACM_PLUGIN_INVALID";
      this.initialized = true;
      return;
    }
    this.state = "ready";
    this.initialized = true;
  }

  getStatus(): IpcResult<AcmPluginStatus> {
    try {
      return { ok: true, data: this.status() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "ACM_PLUGIN_INVALID",
      };
    }
  }

  setEnabled(enabled: boolean): IpcResult<AcmPluginStatus> {
    try {
      portableSettingsService.update({ acm: { enabled } });
      this.error = undefined;
      this.errorCode = undefined;
      this.state = enabled
        ? this.isSupportedPlatform()
          ? "ready"
          : "unsupported"
        : "disabled";
      return { ok: true, data: this.status() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "ACM_PLUGIN_INVALID",
      };
    }
  }

  retry(): IpcResult<AcmPluginStatus> {
    this.initialized = false;
    this.state = "initializing";
    this.error = undefined;
    this.errorCode = undefined;
    try {
      // init is synchronous in all current plugin checks; keep the public
      // retry API async-safe at the IPC layer without spawning a second init.
      const enabled = portableSettingsService.get().acm.enabled;
      if (!this.isSupportedPlatform()) this.state = "unsupported";
      else if (!enabled) this.state = "disabled";
      else if (!this.validateManifest()) {
        this.state = "error";
        this.errorCode = "ACM_PLUGIN_INVALID";
      } else this.state = "ready";
      this.initialized = true;
      return { ok: true, data: this.status() };
    } catch (error) {
      this.state = "error";
      this.errorCode = "ACM_PLUGIN_INVALID";
      this.error = error instanceof Error ? error.message : String(error);
      this.initialized = true;
      return { ok: true, data: this.status() };
    }
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.state = "disabled";
  }

  isEnabled(): boolean {
    return this.state === "ready" || this.state === "degraded";
  }

  setCompilerHealth(available: boolean, reason?: string): void {
    if (!this.isEnabled()) return;
    if (available) {
      this.state = "ready";
      this.error = undefined;
      this.errorCode = undefined;
      return;
    }
    this.state = "degraded";
    this.errorCode = "ACM_COMPILER_MISSING";
    this.error = reason ?? "没有找到可用的 C++ 编译器";
  }

  private status(): AcmPluginStatus {
    return {
      manifest: { ...MANIFEST, capabilities: [...MANIFEST.capabilities] },
      enabled: portableSettingsService.get().acm.enabled,
      state: this.state,
      platform: process.platform,
      errorCode: this.errorCode,
      error: this.error,
    };
  }

  private validateManifest(): boolean {
    if (MANIFEST.pluginApiVersion !== RELEASE_CONFIG.pluginApiVersion) {
      this.error = "ACM 插件 API 版本不受支持";
      return false;
    }
    if (!app.isPackaged && process.env.NODE_ENV !== "test") return true;
    return MANIFEST.capabilities.length === 3;
  }

  private isSupportedPlatform(): boolean {
    if (process.platform !== "win32" || process.arch !== "x64") return false;
    const build = Number.parseInt(os.release().split(".")[2] ?? "0", 10);
    return Number.isInteger(build) && build >= 22621;
  }
}

export const acmPluginService = new AcmPluginService();
