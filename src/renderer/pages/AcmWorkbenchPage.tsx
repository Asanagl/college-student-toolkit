import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
  type MenuProps,
  type TabsProps,
} from "antd";
import {
  CheckCircleOutlined,
  ClearOutlined,
  CloudServerOutlined,
  CodeOutlined,
  DownOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  LockOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  StopOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type {
  AcmDocument,
  AcmPluginStatus,
  AcmTemplateId,
  CompilerProbeResult,
  CompilerSelection,
  CompilerSelectionMode,
  RunnerEvent,
} from "../../shared/types";
import CodeEditor from "../components/acm/CodeEditor";
import { registerAcmNavigationGuard } from "../services/AcmNavigationGuard";

const TEMPLATE_LABELS: Record<AcmTemplateId, string> = {
  blank: "空白文件",
  "basic-io": "基础 I/O 模板",
  stl: "STL 模板",
};

const PLUGIN_STATE_LABELS: Record<AcmPluginStatus["state"], string> = {
  unsupported: "当前系统不支持",
  disabled: "插件已禁用",
  initializing: "正在初始化",
  ready: "插件就绪",
  degraded: "降级运行",
  error: "插件故障",
};

const RUNNER_STATUS_LABELS: Record<RunnerEvent["status"], string> = {
  started: "已开始",
  data: "输出",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  timeout: "超时",
  "output-limit": "输出超限",
};

interface AcmTabState {
  document: AcmDocument;
  stdin: string;
  savedContent: string;
}

type RunnerEventsByDocument = Record<string, RunnerEvent[]>;
type ExternalChanges = Record<string, boolean>;

const MAX_RENDERED_OUTPUT_BYTES = 8 * 1024 * 1024;

function isPluginUsable(status: AcmPluginStatus | null): boolean {
  return status?.state === "ready" || status?.state === "degraded";
}

function errorText(result: { error?: string; errorCode?: string }): string {
  return result.error ?? result.errorCode ?? "操作失败";
}

function showWarnings(warnings: string[] | undefined): void {
  for (const warning of warnings ?? []) message.warning(warning);
}

async function releaseAcmDocument(documentId: string): Promise<void> {
  try {
    await window.api.acm.releaseDocument(documentId);
  } catch (error) {
    console.warn("释放 ACM 文档失败", error);
  }
}

function buildSaveRequest(document: AcmDocument, force: boolean) {
  return {
    documentId: document.id,
    filePath: document.filePath,
    content: document.content,
    lineEnding: document.lineEnding,
    expectedFingerprint: document.savedFingerprint,
    force,
  };
}

function eventClass(event: RunnerEvent): string {
  if (event.cleanupWarning || event.cleanupWarnings?.length) return "warning";
  if (event.status === "data" && event.stream === "stderr") return "error";
  if (event.status === "failed" || event.status === "timeout") return "error";
  if (event.status === "completed") return "success";
  return "info";
}

function eventText(event: RunnerEvent): string {
  if (event.status === "data") return event.text ?? "";
  const cleanup = event.cleanupWarnings?.length
    ? `，${event.cleanupWarnings.join("；")}`
    : event.cleanupWarning
      ? `，${event.cleanupWarning}`
      : "";
  const duration = event.durationMs == null ? "" : ` (${event.durationMs} ms)`;
  const exitCode = event.exitCode == null ? "" : `，退出码 ${event.exitCode}`;
  const errorCode = event.errorCode == null ? "" : `，${event.errorCode}`;
  const termination = event.terminationError
    ? `，终止未确认：${event.terminationError}`
    : event.cleanupBlocked
      ? "，资源清理暂缓"
      : "";
  const confirmed = event.cleanupConfirmed ? "，清理已确认" : "";
  return `[${RUNNER_STATUS_LABELS[event.status]}]${exitCode}${errorCode}${termination}${confirmed}${cleanup}${duration}`;
}

function eventBytes(event: RunnerEvent): number {
  return new TextEncoder().encode(event.text ?? "").byteLength;
}

export function appendRunnerEvent(
  events: RunnerEvent[],
  event: RunnerEvent,
): { events: RunnerEvent[]; truncated: boolean } {
  const countTruncated = events.length >= 500;
  const next = [...events, event].slice(-500);
  let remaining = MAX_RENDERED_OUTPUT_BYTES;
  let truncated = false;
  const kept: RunnerEvent[] = [];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const candidate = next[index];
    const bytes = eventBytes(candidate);
    if (bytes <= remaining) {
      kept.unshift(candidate);
      remaining -= bytes;
      continue;
    }
    truncated = true;
    if (candidate.status === "data" && remaining > 0) {
      const encoded = new TextEncoder().encode(candidate.text ?? "");
      const text = new TextDecoder().decode(encoded.subarray(0, remaining));
      kept.unshift({ ...candidate, text });
      remaining = 0;
    }
    if (remaining === 0) break;
  }
  return { events: kept, truncated: truncated || countTruncated };
}

function confirmDiscardDocuments(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: "离开 ACM 临时 IDE？",
      content:
        count === 1
          ? "有一个文件包含未保存修改，离开后修改会丢失。"
          : `有 ${count} 个文件包含未保存修改，离开后修改会丢失。`,
      okText: "离开并丢弃",
      cancelText: "留在此页",
      okButtonProps: { danger: true },
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function isTerminalRunnerEvent(
  event: RunnerEvent,
  mode: "compile" | "run" | null,
): boolean {
  if (
    !["completed", "failed", "cancelled", "timeout", "output-limit"].includes(
      event.status,
    )
  )
    return false;
  if (event.status !== "completed") return true;
  if (mode === "run") return event.stage === "run-finished";
  if (mode === "compile") return event.stage === "compile-finished";
  return event.stage === "compile-finished" || event.stage === "run-finished";
}

export type RunnerEventLifecycle = "none" | "pending-cleanup" | "finished";

export function runnerEventLifecycle(
  event: RunnerEvent,
  mode: "compile" | "run" | null,
): RunnerEventLifecycle {
  if (event.cleanupConfirmed) return "finished";
  if (!isTerminalRunnerEvent(event, mode)) return "none";
  if (event.cleanupBlocked || event.terminationError) return "pending-cleanup";
  return "finished";
}

function pluginAlertType(
  status: AcmPluginStatus | null,
): "info" | "warning" | "error" {
  if (!status) return "info";
  if (status.state === "error" || status.state === "unsupported")
    return "error";
  if (status.state === "degraded" || status.state === "disabled")
    return "warning";
  return "info";
}

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() =>
    document.body.classList.contains("theme-dark"),
  );

  useEffect(() => {
    const update = () =>
      setDark(document.body.classList.contains("theme-dark"));
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    update();
    return () => observer.disconnect();
  }, []);

  return dark;
}

function PluginBanner({
  status,
  busy,
  onRetry,
  onToggle,
  visible,
  onDismiss,
}: {
  status: AcmPluginStatus | null;
  busy: boolean;
  onRetry: () => void;
  onToggle: () => void;
  visible: boolean;
  onDismiss: () => void;
}) {
  if (!status) {
    return <Alert type="info" showIcon message="正在检查 ACM 工具状态…" />;
  }

  const forceVisible = ["disabled", "unsupported", "error"].includes(
    status.state,
  );
  if (!visible && !forceVisible) return null;

  const canToggle = status.state !== "unsupported" && status.state !== "error";
  const description = status.error
    ? status.error
    : status.state === "unsupported"
      ? "ACM 临时 IDE 仅支持 Windows 11 x64。"
      : status.state === "disabled"
        ? "启用插件后可编辑 C++ 文件。"
        : status.state === "degraded"
          ? "文件编辑可用，但编译器或 Runner 尚未就绪。"
          : "文件、编译器和本地 Runner 均可用。";

  return (
    <Alert
      className="acm-status-banner"
      type={pluginAlertType(status)}
      showIcon
      icon={
        status.state === "ready" ? <CheckCircleOutlined /> : <WarningOutlined />
      }
      message={
        <Space size="small" wrap>
          <span>{status.manifest.name}</span>
          <Tag color={status.state === "ready" ? "success" : "default"}>
            {PLUGIN_STATE_LABELS[status.state]}
          </Tag>
          <Typography.Text type="secondary">
            API v{status.manifest.pluginApiVersion}
          </Typography.Text>
        </Space>
      }
      description={description}
      closable={!forceVisible}
      onClose={onDismiss}
      action={
        <Space>
          {status.state === "error" && (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={busy}
              onClick={onRetry}
            >
              重试
            </Button>
          )}
          {canToggle && (
            <Button
              size="small"
              icon={<SettingOutlined />}
              loading={busy}
              onClick={onToggle}
            >
              {status.enabled ? "禁用" : "启用"}
            </Button>
          )}
        </Space>
      }
    />
  );
}

function IoPanels({
  stdin,
  stdinOpen,
  terminalOpen,
  events,
  truncated,
  onStdinChange,
  onToggleStdin,
  onToggleTerminal,
  onClearTerminal,
}: {
  stdin: string;
  stdinOpen: boolean;
  terminalOpen: boolean;
  events: RunnerEvent[];
  truncated: boolean;
  onStdinChange: (value: string) => void;
  onToggleStdin: () => void;
  onToggleTerminal: () => void;
  onClearTerminal: () => void;
}) {
  return (
    <div className="acm-io-grid">
      <section className={`acm-io-panel${stdinOpen ? " is-open" : ""}`}>
        <button
          className="acm-panel-toggle"
          type="button"
          onClick={onToggleStdin}
          aria-expanded={stdinOpen}
        >
          <span>标准输入</span>
          <DownOutlined rotate={stdinOpen ? 180 : 0} />
        </button>
        {stdinOpen && (
          <Input.TextArea
            className="acm-stdin-input"
            value={stdin}
            onChange={(event) => onStdinChange(event.target.value)}
            placeholder="运行时传给程序的输入…"
            spellCheck={false}
            aria-label="程序标准输入"
          />
        )}
      </section>
      <section
        className={`acm-io-panel acm-terminal-panel${terminalOpen ? " is-open" : ""}`}
      >
        <div className="acm-panel-heading">
          <button
            className="acm-panel-toggle"
            type="button"
            onClick={onToggleTerminal}
            aria-expanded={terminalOpen}
          >
            <span>终端输出</span>
            <DownOutlined rotate={terminalOpen ? 180 : 0} />
          </button>
          <Tooltip title="清空终端">
            <Button
              type="text"
              size="small"
              icon={<ClearOutlined />}
              aria-label="清空终端"
              onClick={onClearTerminal}
            />
          </Tooltip>
        </div>
        {terminalOpen && (
          <div
            className="acm-terminal-output"
            role="log"
            aria-live="polite"
            aria-label="编译和运行输出"
          >
            {events.length === 0 ? (
              <Typography.Text type="secondary">
                运行或编译后，输出会显示在这里。
              </Typography.Text>
            ) : (
              <>
                {truncated && (
                  <Typography.Text type="warning">
                    较早输出已截断
                  </Typography.Text>
                )}
                {events.map((event, index) => (
                  <div
                    key={`${event.taskId}-${index}`}
                    className={`acm-terminal-line ${eventClass(event)}`}
                  >
                    {eventText(event)}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function CompilerToolbar({
  selection,
  probe,
  loading,
  disabled,
  onProbe,
  onSelectPath,
  onSelectionChange,
}: {
  selection: CompilerSelection | null;
  probe: CompilerProbeResult | null;
  loading: boolean;
  disabled: boolean;
  onProbe: () => void;
  onSelectPath: () => void;
  onSelectionChange: (mode: CompilerSelectionMode) => void;
}) {
  const compilerLabel = probe?.available
    ? `g++ ${probe.version ?? "已就绪"}`
    : (probe?.reason ?? "未检测到编译器");
  return (
    <div className="acm-compiler-tools">
      <Tag
        color={probe?.available ? "success" : "warning"}
        icon={<CloudServerOutlined />}
      >
        {compilerLabel}
      </Tag>
      <Select
        size="small"
        value={selection?.mode ?? "auto"}
        disabled={disabled}
        aria-label="编译器来源"
        onChange={onSelectionChange}
        options={[
          { value: "auto", label: "自动选择" },
          { value: "builtin", label: "内置工具链" },
          { value: "user", label: "自定义工具链" },
        ]}
      />
      <Tooltip title="选择本机 g++.exe">
        <Button
          size="small"
          type="text"
          icon={<FolderOpenOutlined />}
          aria-label="选择本机 g++.exe"
          disabled={disabled}
          onClick={onSelectPath}
        />
      </Tooltip>
      <Tooltip title="重新探测编译器">
        <Button
          size="small"
          type="text"
          icon={<ReloadOutlined spin={loading} />}
          aria-label="重新探测编译器"
          disabled={disabled}
          onClick={onProbe}
        />
      </Tooltip>
    </div>
  );
}

export default function AcmWorkbenchPage() {
  const { token } = theme.useToken();
  const dark = useDarkTheme();
  const [tabs, setTabs] = useState<AcmTabState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pluginStatus, setPluginStatus] = useState<AcmPluginStatus | null>(
    null,
  );
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stdinOpen, setStdinOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [eventsByDocument, setEventsByDocument] =
    useState<RunnerEventsByDocument>({});
  const [truncatedByDocument, setTruncatedByDocument] = useState<
    Record<string, boolean>
  >({});
  const [externalChanges, setExternalChanges] = useState<ExternalChanges>({});
  const [compilerSelection, setCompilerSelection] =
    useState<CompilerSelection | null>(null);
  const [compilerProbe, setCompilerProbe] =
    useState<CompilerProbeResult | null>(null);
  const [compilerLoading, setCompilerLoading] = useState(false);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [runnerCleanupPending, setRunnerCleanupPending] = useState(false);
  const [runnerDocumentId, setRunnerDocumentId] = useState<string | null>(null);
  const [runnerTaskId, setRunnerTaskId] = useState<string | null>(null);
  const [runnerPhase, setRunnerPhase] = useState<"compile" | "run" | null>(
    null,
  );
  const activeDocument = useMemo(
    () => tabs.find((tab) => tab.document.id === activeId)?.document ?? null,
    [activeId, tabs],
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.document.id === activeId) ?? null,
    [activeId, tabs],
  );
  const activeDocumentRef = useRef<AcmDocument | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const runnerTaskRef = useRef<string | null>(null);
  const pendingRunnerEventsRef = useRef<RunnerEvent[]>([]);
  const runnerBusyRef = useRef(false);
  const runnerCleanupPendingRef = useRef(false);
  const runnerDocumentIdRef = useRef<string | null>(null);
  const tabsRef = useRef<AcmTabState[]>([]);
  const eventsByDocumentRef = useRef<RunnerEventsByDocument>({});
  const truncatedByDocumentRef = useRef<Record<string, boolean>>({});
  const openingRef = useRef(false);
  const pageAliveRef = useRef(true);
  const runnerModeRef = useRef<"compile" | "run" | null>(null);

  useEffect(() => {
    activeDocumentRef.current = activeDocument;
  }, [activeDocument]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    runnerBusyRef.current = runnerBusy;
    runnerDocumentIdRef.current = runnerDocumentId;
  }, [runnerBusy, runnerDocumentId]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    pageAliveRef.current = true;
    return () => {
      pageAliveRef.current = false;
      if (runnerBusyRef.current) {
        void window.api.acm.stopRunner().catch((error: unknown) => {
          console.warn("释放 ACM Runner 失败", error);
        });
      }
      tabsRef.current.forEach((tab) => {
        void releaseAcmDocument(tab.document.id);
      });
    };
  }, []);

  const finishRunner = useCallback((taskId?: string) => {
    runnerTaskRef.current = null;
    runnerModeRef.current = null;
    runnerBusyRef.current = false;
    runnerCleanupPendingRef.current = false;
    runnerDocumentIdRef.current = null;
    pendingRunnerEventsRef.current = taskId
      ? pendingRunnerEventsRef.current.filter(
          (pending) => pending.taskId !== taskId,
        )
      : [];
    setRunnerBusy(false);
    setRunnerTaskId(null);
    setRunnerDocumentId(null);
    setRunnerPhase(null);
    setRunnerCleanupPending(false);
  }, []);

  const applySavedDocument = useCallback((document: AcmDocument) => {
    const nextTabs = tabsRef.current.map((tab) =>
      tab.document.id === document.id
        ? { ...tab, document, savedContent: document.content }
        : tab,
    );
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
  }, []);

  const addDocumentTab = useCallback((document: AcmDocument) => {
    const currentTabs = tabsRef.current;
    const duplicate = document.filePath
      ? currentTabs.find((tab) => tab.document.filePath === document.filePath)
      : undefined;
    if (duplicate) {
      void releaseAcmDocument(document.id);
      setActiveId(duplicate.document.id);
      message.info("该文件已经打开");
      return;
    }
    const nextTabs = [
      ...currentTabs,
      { document, stdin: "", savedContent: document.content },
    ];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveId(document.id);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const [result, notice] = await Promise.all([
        window.api.acm.getStatus(),
        window.api.acm.getNoticeState(),
      ]);
      if (result.ok && result.data) setPluginStatus(result.data);
      else message.error(errorText(result));
      if (notice.ok && notice.data) setNoticeVisible(notice.data.visible);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "无法读取 ACM 工具状态",
      );
    }
  }, []);

  const probeCompiler = useCallback(async () => {
    setCompilerLoading(true);
    try {
      const [selectionResult, probeResult] = await Promise.all([
        window.api.acm.getCompilerSelection(),
        window.api.acm.probeCompiler(),
      ]);
      if (selectionResult.ok && selectionResult.data)
        setCompilerSelection(selectionResult.data);
      if (probeResult.ok && probeResult.data) {
        setCompilerProbe(probeResult.data);
      } else if (!probeResult.ok) {
        setCompilerProbe({
          available: false,
          path: null,
          version: null,
          target: null,
          reason: errorText(probeResult),
        });
      }
    } catch (error) {
      setCompilerProbe({
        available: false,
        path: null,
        version: null,
        target: null,
        reason: error instanceof Error ? error.message : "编译器探测失败",
      });
    } finally {
      setCompilerLoading(false);
    }
  }, []);

  useEffect(() => {
    const showNotice = () => setNoticeVisible(true);
    window.addEventListener("acm-notice-cleared", showNotice);
    void loadStatus();
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = window.api.acm.onRunnerEvent((event) => {
        const previous = eventsByDocumentRef.current[event.documentId] ?? [];
        const appended = appendRunnerEvent(previous, event);
        const nextEvents = {
          ...eventsByDocumentRef.current,
          [event.documentId]: appended.events,
        };
        eventsByDocumentRef.current = nextEvents;
        setEventsByDocument(nextEvents);
        if (appended.truncated) {
          const nextTruncated = {
            ...truncatedByDocumentRef.current,
            [event.documentId]: true,
          };
          truncatedByDocumentRef.current = nextTruncated;
          setTruncatedByDocument(nextTruncated);
        }
        const currentTaskId = runnerTaskRef.current;
        const currentDocumentId = runnerDocumentIdRef.current;
        const hasCleanupWarning = Boolean(
          event.cleanupWarning || event.cleanupWarnings?.length,
        );
        const isCurrentEvent = currentTaskId
          ? event.taskId === currentTaskId
          : runnerBusyRef.current && event.documentId === currentDocumentId;
        const isLateCleanupWarning =
          hasCleanupWarning && event.documentId === activeIdRef.current;
        if (isLateCleanupWarning) {
          showWarnings([
            ...(event.cleanupWarnings ?? []),
            ...(event.cleanupWarning ? [event.cleanupWarning] : []),
          ]);
        }
        if (!isCurrentEvent) return;
        if (event.stage === "compile-started") setRunnerPhase("compile");
        if (event.stage === "run-started") setRunnerPhase("run");
        if (!currentTaskId) {
          if (
            event.cleanupConfirmed ||
            isTerminalRunnerEvent(event, runnerModeRef.current)
          )
            pendingRunnerEventsRef.current.push(event);
          return;
        }
        const lifecycle = runnerEventLifecycle(event, runnerModeRef.current);
        if (lifecycle === "finished") {
          finishRunner(event.taskId);
        } else if (lifecycle === "pending-cleanup") {
          runnerCleanupPendingRef.current = true;
          setRunnerCleanupPending(true);
          setRunnerPhase(null);
        }
      });
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "Runner 事件订阅失败",
      );
    }
    return () => {
      window.removeEventListener("acm-notice-cleared", showNotice);
      unsubscribe?.();
    };
  }, [finishRunner, loadStatus]);

  const docsAvailable = isPluginUsable(pluginStatus);

  useEffect(() => {
    if (docsAvailable) void probeCompiler();
  }, [docsAvailable, probeCompiler]);

  const checkActiveDocument = useCallback(async () => {
    const document = activeDocumentRef.current;
    if (!document?.filePath || !document.savedFingerprint) return;
    try {
      const result = await window.api.acm.checkDocumentExternal({
        documentId: document.id,
        filePath: document.filePath,
        savedFingerprint: document.savedFingerprint,
      });
      if (result.ok && result.data) {
        const externalState = result.data;
        setExternalChanges((current) => ({
          ...current,
          [document.id]: externalState.changed,
        }));
      }
    } catch {
      setExternalChanges((current) => ({ ...current, [document.id]: true }));
    }
  }, []);

  useEffect(() => {
    window.addEventListener("focus", checkActiveDocument);
    return () => window.removeEventListener("focus", checkActiveDocument);
  }, [checkActiveDocument]);

  const createDocument = useCallback(
    async (template: AcmTemplateId) => {
      if (!docsAvailable) {
        message.warning("ACM 插件当前不可用");
        return;
      }
      setCreating(true);
      try {
        const result = await window.api.acm.createDocument(template);
        if (result.ok && result.data) {
          addDocumentTab(result.data);
        } else {
          message.error(errorText(result));
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : "新建文件失败");
      } finally {
        setCreating(false);
      }
    },
    [addDocumentTab, docsAvailable],
  );

  const openDocument = useCallback(async () => {
    if (!docsAvailable) {
      message.warning("ACM 插件当前不可用");
      return;
    }
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      const result = await window.api.acm.openDocument();
      if (!pageAliveRef.current) {
        if (result.ok && result.data) void releaseAcmDocument(result.data.id);
        return;
      }
      if (result.ok && result.data) {
        addDocumentTab(result.data);
      } else if (!result.ok) {
        message.error(errorText(result));
      }
    } catch (error) {
      if (!pageAliveRef.current) return;
      message.error(error instanceof Error ? error.message : "打开文件失败");
    } finally {
      openingRef.current = false;
      if (pageAliveRef.current) setOpening(false);
    }
  }, [addDocumentTab, docsAvailable]);

  const saveAsDocument = useCallback(async () => {
    const document = activeDocumentRef.current;
    if (!document || !docsAvailable) return;
    setSaving(true);
    try {
      const result = await window.api.acm.saveDocumentAs(
        buildSaveRequest(document, true),
      );
      if (!pageAliveRef.current) return;
      if (result.ok && result.data) {
        applySavedDocument(result.data);
        setExternalChanges((current) => ({ ...current, [document.id]: false }));
        message.success(`已保存 ${result.data.name}`);
        showWarnings(result.warnings);
      } else if (!result.ok) {
        message.error(errorText(result));
      }
    } catch (error) {
      if (!pageAliveRef.current) return;
      message.error(error instanceof Error ? error.message : "另存为失败");
    } finally {
      if (pageAliveRef.current) setSaving(false);
    }
  }, [applySavedDocument, docsAvailable]);

  const saveDocumentRequest = useCallback(
    async (
      documentId: string,
      force: boolean,
      expectedFingerprint?: AcmDocument["savedFingerprint"],
    ): Promise<void> => {
      const tab = tabsRef.current.find(
        (item) => item.document.id === documentId,
      );
      if (!tab) return;
      const document = tab.document;
      const request = buildSaveRequest(document, force);
      if (expectedFingerprint !== undefined)
        request.expectedFingerprint = expectedFingerprint;
      setSaving(true);
      try {
        const result = await window.api.acm.saveDocument(request);
        if (!pageAliveRef.current) return;
        if (result.ok && result.data) {
          applySavedDocument(result.data);
          setExternalChanges((current) => ({
            ...current,
            [document.id]: false,
          }));
          message.success(`已保存 ${result.data.name}`);
          showWarnings(result.warnings);
        } else if (result.errorCode === "ACM_FILE_CHANGED" && !force) {
          Modal.confirm({
            title: "文件已被外部修改",
            content: "覆盖保存会丢失磁盘上的外部修改，确定继续吗？",
            okText: "覆盖保存",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () =>
              void saveDocumentRequest(
                documentId,
                true,
                document.savedFingerprint,
              ),
          });
        } else if (!result.ok) {
          message.error(errorText(result));
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : "保存失败");
      } finally {
        setSaving(false);
      }
    },
    [applySavedDocument],
  );

  const saveDocument = useCallback(async () => {
    const document = activeDocumentRef.current;
    if (!document || !docsAvailable) return;
    if (document.readOnly || !document.filePath) {
      await saveAsDocument();
      return;
    }
    await saveDocumentRequest(document.id, false);
  }, [docsAvailable, saveAsDocument, saveDocumentRequest]);

  const closeDocument = useCallback((documentId: string) => {
    const tab = tabsRef.current.find((item) => item.document.id === documentId);
    if (!tab) return;
    if (runnerBusyRef.current && runnerDocumentIdRef.current === documentId) {
      message.warning("请先停止当前运行任务");
      return;
    }
    const commitClose = () => {
      const currentTabs = tabsRef.current;
      const nextTabs = currentTabs.filter(
        (item) => item.document.id !== documentId,
      );
      if (nextTabs.length === currentTabs.length) return;
      tabsRef.current = nextTabs;
      void releaseAcmDocument(documentId);
      setTabs(nextTabs);
      const nextEvents = { ...eventsByDocumentRef.current };
      delete nextEvents[documentId];
      eventsByDocumentRef.current = nextEvents;
      setEventsByDocument(nextEvents);
      const nextTruncated = { ...truncatedByDocumentRef.current };
      delete nextTruncated[documentId];
      truncatedByDocumentRef.current = nextTruncated;
      setTruncatedByDocument(nextTruncated);
      setExternalChanges((current) => {
        const next = { ...current };
        delete next[documentId];
        return next;
      });
      if (activeIdRef.current === documentId) {
        const nextActiveId = nextTabs[nextTabs.length - 1]?.document.id ?? null;
        activeIdRef.current = nextActiveId;
        setActiveId(nextActiveId);
      }
    };
    if (!tab.document.dirty) {
      commitClose();
      return;
    }
    Modal.confirm({
      title: `关闭 ${tab.document.name}？`,
      content: "该文件有未保存修改。关闭后修改会丢失。",
      okText: "关闭并丢弃",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: commitClose,
    });
  }, []);

  const startRunner = useCallback(
    async (mode: "compile" | "run") => {
      const document = activeDocumentRef.current;
      const stdin =
        tabs.find((tab) => tab.document.id === document?.id)?.stdin ?? "";
      if (
        !document ||
        !docsAvailable ||
        !compilerProbe?.available ||
        runnerBusyRef.current
      )
        return;
      setRunnerBusy(true);
      setRunnerCleanupPending(false);
      setRunnerDocumentId(document.id);
      setRunnerPhase("compile");
      runnerBusyRef.current = true;
      runnerDocumentIdRef.current = document.id;
      runnerModeRef.current = mode;
      setTerminalOpen(true);
      try {
        const result = await window.api.acm.startRunner({
          documentId: document.id,
          source: document.content,
          stdin,
          mode,
        });
        if (result.ok && result.data) {
          runnerTaskRef.current = result.data.taskId;
          setRunnerTaskId(result.data.taskId);
          const pendingEvents = pendingRunnerEventsRef.current.filter(
            (event) => event.taskId === result.data?.taskId,
          );
          for (const pending of pendingEvents) {
            const lifecycle = runnerEventLifecycle(pending, mode);
            if (lifecycle === "finished") {
              finishRunner(pending.taskId);
              break;
            }
            if (lifecycle === "pending-cleanup") {
              runnerCleanupPendingRef.current = true;
              setRunnerCleanupPending(true);
              setRunnerPhase(null);
            }
          }
        } else {
          finishRunner();
          message.error(errorText(result));
        }
      } catch (error) {
        finishRunner();
        message.error(
          error instanceof Error ? error.message : "启动 Runner 失败",
        );
      }
    },
    [compilerProbe?.available, docsAvailable, finishRunner, tabs],
  );

  const stopRunner = useCallback(async () => {
    if (!runnerBusy) return;
    try {
      const result = await window.api.acm.stopRunner();
      if (!result.ok) message.error(errorText(result));
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "停止 Runner 失败",
      );
    }
  }, [runnerBusy]);

  const confirmLeave = useCallback(async (): Promise<boolean> => {
    const dirtyCount = tabsRef.current.filter(
      (tab) => tab.document.dirty,
    ).length;
    if (dirtyCount > 0 && !(await confirmDiscardDocuments(dirtyCount)))
      return false;
    if (!runnerBusyRef.current) return true;
    try {
      const result = await window.api.acm.stopRunner();
      if (!result.ok) {
        message.error(errorText(result));
        return false;
      }
      return true;
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "停止 Runner 失败",
      );
      return false;
    }
  }, []);

  useEffect(() => registerAcmNavigationGuard(confirmLeave), [confirmLeave]);

  const selectCompilerPath = useCallback(async () => {
    try {
      const result = await window.api.acm.selectCompilerPath();
      if (result.ok && result.data) {
        setCompilerSelection(result.data);
        await probeCompiler();
      } else if (!result.ok) {
        message.error(errorText(result));
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "选择编译器失败");
    }
  }, [probeCompiler]);

  const handleCompilerSelection = useCallback(
    async (mode: CompilerSelectionMode) => {
      const current = compilerSelection;
      if (mode === "user" && !current?.path) {
        await selectCompilerPath();
        return;
      }
      try {
        const result = await window.api.acm.setCompilerSelection({
          mode,
          path: mode === "user" ? (current?.path ?? null) : null,
        });
        if (result.ok && result.data) {
          setCompilerSelection(result.data);
          await probeCompiler();
        } else {
          message.error(errorText(result));
        }
      } catch (error) {
        message.error(
          error instanceof Error ? error.message : "保存编译器设置失败",
        );
      }
    },
    [compilerSelection, probeCompiler, selectCompilerPath],
  );

  const retryPlugin = useCallback(async () => {
    setPluginBusy(true);
    try {
      const result = await window.api.acm.retry();
      if (result.ok && result.data) setPluginStatus(result.data);
      else message.error(errorText(result));
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "重试 ACM 插件失败",
      );
    } finally {
      setPluginBusy(false);
    }
  }, []);

  const togglePlugin = useCallback(async () => {
    if (!pluginStatus || runnerBusy) return;
    setPluginBusy(true);
    try {
      const result = await window.api.acm.setEnabled(!pluginStatus.enabled);
      if (result.ok && result.data) setPluginStatus(result.data);
      else message.error(errorText(result));
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "更新 ACM 插件状态失败",
      );
    } finally {
      setPluginBusy(false);
    }
  }, [pluginStatus, runnerBusy]);

  const updateStdin = useCallback((value: string) => {
    const documentId = activeDocumentRef.current?.id;
    if (!documentId) return;
    const nextTabs = tabsRef.current.map((tab) =>
      tab.document.id === documentId ? { ...tab, stdin: value } : tab,
    );
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
  }, []);

  const updateContent = useCallback((documentId: string, value: string) => {
    const nextTabs = tabsRef.current.map((tab) =>
      tab.document.id === documentId
        ? {
            ...tab,
            document: {
              ...tab.document,
              content: value,
              dirty: value !== tab.savedContent,
            },
          }
        : tab,
    );
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
  }, []);

  const shortcutHandlers = useMemo(
    () => ({
      newDocument: () => void createDocument("blank"),
      openDocument: () => void openDocument(),
      saveDocument: () => void saveDocument(),
      saveAsDocument: () => void saveAsDocument(),
    }),
    [createDocument, openDocument, saveAsDocument, saveDocument],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        shortcutHandlers.newDocument();
      } else if (key === "o") {
        event.preventDefault();
        shortcutHandlers.openDocument();
      } else if (key === "s" && event.shiftKey) {
        event.preventDefault();
        shortcutHandlers.saveAsDocument();
      } else if (key === "s") {
        event.preventDefault();
        shortcutHandlers.saveDocument();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [shortcutHandlers]);

  const newMenu: MenuProps = {
    items: (Object.keys(TEMPLATE_LABELS) as AcmTemplateId[]).map(
      (template) => ({
        key: template,
        label: TEMPLATE_LABELS[template],
        icon: <FileAddOutlined />,
      }),
    ),
    onClick: ({ key }) => void createDocument(key as AcmTemplateId),
  };
  const tabItems: TabsProps["items"] = tabs.map((tab) => ({
    key: tab.document.id,
    label: (
      <span className="acm-tab-label">
        {tab.document.readOnly && <LockOutlined />}
        <span>{tab.document.name}</span>
        {tab.document.dirty && (
          <span className="acm-dirty-dot" aria-label="有未保存修改" />
        )}
      </span>
    ),
    closable: !(runnerBusy && runnerDocumentId === tab.document.id),
  }));
  const activeEvents = activeId ? (eventsByDocument[activeId] ?? []) : [];
  const compilerReady = compilerProbe?.available === true;
  const runnerForActive = runnerBusy && runnerDocumentId === activeId;
  const rootStyle = {
    "--acm-primary": token.colorPrimary,
    "--acm-warning": token.colorWarning,
    "--acm-error": token.colorError,
    "--acm-success": token.colorSuccess,
    "--acm-editor-background": token.colorBgContainer,
    "--acm-editor-foreground": token.colorText,
    "--acm-editor-border": token.colorBorderSecondary,
    "--acm-editor-muted": token.colorTextTertiary,
    "--acm-editor-active-line": dark
      ? "rgba(255,255,255,0.06)"
      : "rgba(0,0,0,0.035)",
    "--acm-editor-selection": dark
      ? "rgba(80,140,220,0.45)"
      : "rgba(30,100,190,0.22)",
  } as CSSProperties;

  return (
    <div className="acm-workbench" style={rootStyle}>
      <div className="acm-workbench-header">
        <div>
          <Typography.Title level={3} className="acm-page-title">
            <CodeOutlined /> ACM 临时 IDE
          </Typography.Title>
          <Typography.Text type="secondary">
            单文件 C++ 快速编译与运行
          </Typography.Text>
        </div>
        <Space wrap>
          <Dropdown
            menu={newMenu}
            trigger={["click"]}
            disabled={!docsAvailable || creating}
          >
            <Button
              type="primary"
              icon={<FileAddOutlined />}
              loading={creating}
            >
              新建 <DownOutlined />
            </Button>
          </Dropdown>
          <Button
            icon={<FolderOpenOutlined />}
            loading={opening}
            disabled={!docsAvailable}
            onClick={() => void openDocument()}
          >
            打开
          </Button>
          <Button
            icon={<SaveOutlined />}
            disabled={
              !activeDocument ||
              !docsAvailable ||
              !activeDocument.dirty ||
              saving
            }
            loading={saving}
            onClick={() => void saveDocument()}
          >
            保存
          </Button>
          <Button
            icon={<SaveOutlined />}
            disabled={!activeDocument || !docsAvailable || saving}
            onClick={() => void saveAsDocument()}
          >
            另存为
          </Button>
        </Space>
      </div>

      <PluginBanner
        status={pluginStatus}
        busy={pluginBusy}
        onRetry={() => void retryPlugin()}
        onToggle={() => void togglePlugin()}
        visible={noticeVisible}
        onDismiss={() => {
          void window.api.acm
            .dismissNotice()
            .then((result) => {
              if (result.ok) setNoticeVisible(false);
              else message.error(errorText(result));
            })
            .catch((error: unknown) => {
              message.error(
                error instanceof Error ? error.message : "关闭提示失败",
              );
            });
        }}
      />

      <div className="acm-command-bar">
        <Space wrap>
          <Button
            type="primary"
            icon={<CodeOutlined />}
            disabled={
              !activeDocument || !docsAvailable || !compilerReady || runnerBusy
            }
            onClick={() => void startRunner("compile")}
          >
            编译
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={
              !activeDocument || !docsAvailable || !compilerReady || runnerBusy
            }
            onClick={() => void startRunner("run")}
          >
            编译并运行
          </Button>
          <Button
            danger
            icon={<StopOutlined />}
            disabled={!runnerBusy}
            onClick={() => void stopRunner()}
          >
            停止
          </Button>
          {runnerForActive && (
            <Tag color="processing">
              {runnerCleanupPending
                ? "等待进程退出/清理"
                : runnerPhase === "compile"
                  ? "编译中"
                  : "运行中"}
            </Tag>
          )}
          {runnerBusy && runnerDocumentId !== activeId && (
            <Tag color="processing">其他标签页任务运行中</Tag>
          )}
        </Space>
        <CompilerToolbar
          selection={compilerSelection}
          probe={compilerProbe}
          loading={compilerLoading}
          disabled={!docsAvailable || runnerBusy}
          onProbe={() => void probeCompiler()}
          onSelectPath={() => void selectCompilerPath()}
          onSelectionChange={(mode) => void handleCompilerSelection(mode)}
        />
      </div>

      <div className="acm-tab-strip">
        <Tabs
          type="editable-card"
          hideAdd={!docsAvailable}
          addIcon={
            <Tooltip title="新建空白文件">
              <FileAddOutlined />
            </Tooltip>
          }
          activeKey={activeId ?? undefined}
          items={tabItems}
          onChange={setActiveId}
          onEdit={(targetKey, action) => {
            if (action === "add") void createDocument("blank");
            else closeDocument(String(targetKey));
          }}
        />
      </div>

      {activeDocument && activeTab ? (
        <div className="acm-editor-area">
          {externalChanges[activeDocument.id] && (
            <Alert
              className="acm-external-alert"
              type="warning"
              showIcon
              message="磁盘文件已被外部修改"
              description="保存将覆盖磁盘上的最新内容；也可以使用另存为保留外部文件。"
            />
          )}
          <div className="acm-editor-meta">
            <Space size="small">
              {activeDocument.readOnly && (
                <Tag icon={<LockOutlined />}>只读</Tag>
              )}
              <Typography.Text type="secondary">
                {activeDocument.filePath ?? "未保存文件"}
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary">
              C++17 · UTF-8 · {activeDocument.lineEnding.toUpperCase()}
            </Typography.Text>
          </div>
          <div className="acm-editor-frame">
            <CodeEditor
              key={activeDocument.id}
              documentId={activeDocument.id}
              value={activeDocument.content}
              readOnly={activeDocument.readOnly || !docsAvailable}
              dark={dark}
              onChange={updateContent}
            />
          </div>
        </div>
      ) : (
        <div className="acm-empty-editor">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有打开 C++ 文件"
          >
            <Space>
              <Button
                type="primary"
                icon={<FileAddOutlined />}
                disabled={!docsAvailable}
                onClick={() => void createDocument("basic-io")}
              >
                新建基础 I/O 文件
              </Button>
              <Button
                icon={<FolderOpenOutlined />}
                disabled={!docsAvailable}
                onClick={() => void openDocument()}
              >
                打开文件
              </Button>
            </Space>
          </Empty>
        </div>
      )}

      <IoPanels
        stdin={activeTab?.stdin ?? ""}
        stdinOpen={stdinOpen}
        terminalOpen={terminalOpen}
        events={activeEvents}
        truncated={activeId ? truncatedByDocument[activeId] === true : false}
        onStdinChange={updateStdin}
        onToggleStdin={() => setStdinOpen((value) => !value)}
        onToggleTerminal={() => setTerminalOpen((value) => !value)}
        onClearTerminal={() => {
          if (!activeId) return;
          const nextEvents = {
            ...eventsByDocumentRef.current,
            [activeId]: [],
          };
          eventsByDocumentRef.current = nextEvents;
          setEventsByDocument(nextEvents);
          const nextTruncated = {
            ...truncatedByDocumentRef.current,
            [activeId]: false,
          };
          truncatedByDocumentRef.current = nextTruncated;
          setTruncatedByDocument(nextTruncated);
        }}
      />

      {runnerTaskId && runnerForActive && (
        <Typography.Text className="acm-task-id" type="secondary">
          任务 {runnerTaskId}
        </Typography.Text>
      )}
    </div>
  );
}
