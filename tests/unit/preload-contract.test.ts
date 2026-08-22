import { beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => {
  const exposed: {
    api?: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  } = {};
  return {
    exposed,
    invoke: vi.fn(async () => ({ ok: true, data: true })),
    on: vi.fn(),
    removeListener: vi.fn(),
    exposeInMainWorld: vi.fn((_: string, api: typeof exposed.api) => {
      exposed.api = api;
    }),
  };
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronState.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronState.invoke,
    on: electronState.on,
    removeListener: electronState.removeListener,
  },
}));

import "../../src/main/preload";

function api(): Record<
  string,
  Record<string, (...args: unknown[]) => unknown>
> {
  if (!electronState.exposed.api) throw new Error("preload 未暴露 API");
  return electronState.exposed.api;
}

async function call(
  group: string,
  method: string,
  ...args: unknown[]
): Promise<void> {
  await api()[group][method](...args);
}

describe("preload RendererApi contract", () => {
  beforeEach(() => {
    electronState.invoke.mockClear();
    electronState.on.mockClear();
    electronState.removeListener.mockClear();
  });

  it("exposes only the declared grouped API", () => {
    expect(electronState.exposed.api).toBeDefined();
    expect(Object.keys(api())).toEqual([
      "schedule",
      "timetable",
      "exam",
      "lab",
      "grade",
      "formula",
      "periodConfig",
      "importBrowser",
      "examImport",
      "labImport",
      "notify",
      "data",
      "update",
      "window",
      "theme",
      "appearance",
      "ocrComponent",
    ]);
  });

  it("routes CRUD, import, settings and update calls through ipcRenderer.invoke", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await call("schedule", "list");
    await call("schedule", "add", {});
    await call("schedule", "update", id, {});
    await call("schedule", "remove", id);
    await call("timetable", "list");
    await call("timetable", "add", {});
    await call("timetable", "update", id, {});
    await call("timetable", "remove", id);
    await call("timetable", "getPreferences");
    await call("timetable", "setSemesterStart", null);
    await call("exam", "list");
    await call("exam", "add", {});
    await call("exam", "update", id, {});
    await call("exam", "remove", id);
    await call("lab", "list");
    await call("lab", "add", {});
    await call("lab", "update", id, {});
    await call("lab", "remove", id);
    await call("grade", "list");
    await call("grade", "listPage", { page: 1, pageSize: 20 });
    await call("grade", "getDashboard");
    await call("grade", "add", {});
    await call("grade", "update", id, {});
    await call("grade", "remove", id);
    await call("formula", "get", "default");
    await call("formula", "save", {});
    await call("formula", "list");
    await call("periodConfig", "get");
    await call("periodConfig", "save", []);
    await call("importBrowser", "openBrowser");
    await call("importBrowser", "closeBrowser");
    await call("importBrowser", "extractDom");
    await call("importBrowser", "capturePage");
    await call("importBrowser", "parseDom", "<html></html>");
    await call("importBrowser", "runOcr", "aGVsbG8=");
    await call("examImport", "parseDomForExams", "<html></html>");
    await call("examImport", "runOcrForExams", "aGVsbG8=");
    await call("labImport", "parseDomForLabs", "<html></html>");
    await call("labImport", "runOcrForLabs", "aGVsbG8=");
    await call("notify", "send", {});
    await call("notify", "setDnd", {});
    await call("notify", "getDnd");
    await call("notify", "getHistory");
    await call("notify", "clearHistory");
    await call("data", "exportBackup");
    await call("data", "prepareImport");
    await call("data", "commitImport", id);
    await call("data", "cancelImport", id);
    await call("update", "checkManual");
    await call("update", "installUpdate");
    await call("update", "getCurrentVersion");
    await call("update", "getChannel");
    await call("window", "minimize");
    await call("window", "maximize");
    await call("window", "close");
    await call("window", "isMaximized");
    await call("theme", "get");
    await call("theme", "set", "system");
    await call("theme", "getResolved");
    await call("appearance", "get");
    await call("appearance", "chooseBackground");
    await call("appearance", "setMaterial", "none");
    await call("appearance", "clearBackground");
    await call("appearance", "setBlur", 0);
    await call("appearance", "setClarity", 100);
    await call("ocrComponent", "getStatus");
    await call("ocrComponent", "install");
    await call("ocrComponent", "cancelInstall");
    await call("ocrComponent", "remove");
    expect(electronState.invoke.mock.calls.length).toBeGreaterThan(60);
  });

  it("returns unsubscribe functions for every event subscription", () => {
    const callback = vi.fn();
    const unsubscribers = [
      api().data.onRestoreCompleted(callback),
      api().update.onUpdateStatus(callback),
      api().window.onMaximizeChange(callback),
      api().theme.onChange(callback),
      api().appearance.onChange(callback),
      api().ocrComponent.onStatusChange(callback),
    ];
    expect(electronState.on).toHaveBeenCalledTimes(6);
    for (const unsubscribe of unsubscribers) unsubscribe();
    expect(electronState.removeListener).toHaveBeenCalledTimes(6);
  });
});
