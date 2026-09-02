import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
  message,
  theme,
} from "antd";
import {
  ClearOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  StopOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type {
  AcmDiffEvent,
  AcmDiffProgramOutput,
  AcmDiffResult,
  AcmDocument,
  AcmPluginStatus,
  CompilerProbeResult,
  CompilerSelection,
} from "../../shared/types";
import CodeEditor from "../components/acm/CodeEditor";

type DiffSide = "reference" | "candidate";

interface SideState {
  document: AcmDocument;
  managed: boolean;
}

const SIDE_LABELS: Record<DiffSide, string> = {
  reference: "标准程序",
  candidate: "待测程序",
};

const RESULT_LABELS: Record<string, string> = {
  match: "AC：输出一致",
  mismatch: "WA：输出不一致",
  "reference-failed": "标准程序失败 / 对拍无效",
  "candidate-compile-failed": "待测程序编译失败",
  "candidate-runtime-failed": "待测程序运行失败",
  "candidate-timeout": "待测程序运行超时",
  "candidate-output-limit": "待测程序输出或临时目录超限",
  cancelled: "对拍已停止",
  unsupported: "当前系统不支持 ACM 对拍",
};

function emptyDocument(): AcmDocument {
  return {
    id: crypto.randomUUID(),
    name: "未命名.cpp",
    filePath: null,
    content: "",
    lineEnding: "lf",
    readOnly: false,
    dirty: false,
    savedFingerprint: null,
  };
}

function isUsable(status: AcmPluginStatus | null): boolean {
  return status?.state === "ready" || status?.state === "degraded";
}

function errorText(result: { error?: string; errorCode?: string }): string {
  return result.error ?? result.errorCode ?? "操作失败";
}

function showWarnings(warnings: string[] | undefined): void {
  for (const warning of warnings ?? []) message.warning(warning);
}

function resultWarnings(result: AcmDiffResult): string[] {
  return [
    ...(result.cleanupWarnings ?? []),
    ...(result.terminationError
      ? [`子进程终止未确认：${result.terminationError}`]
      : []),
    ...(result.cleanupBlocked ? ["相关临时资源将在进程退出后继续清理"] : []),
  ];
}

function uniqueWarnings(warnings: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const warning of warnings) {
    if (!warning || seen.has(warning)) continue;
    seen.add(warning);
    next.push(warning);
  }
  return next;
}

export function mergeDiffCleanupWarnings(
  current: string[],
  event: AcmDiffEvent,
): string[] {
  const extras = [
    ...(event.cleanupWarnings ?? []),
    ...(event.cleanupWarning ? [event.cleanupWarning] : []),
    ...(event.terminationError && !event.result
      ? [`子进程终止未确认：${event.terminationError}`]
      : []),
  ];
  const base = event.result ? resultWarnings(event.result) : current;
  return uniqueWarnings([...base, ...extras]);
}

export type DiffEventLifecycle = "none" | "pending-cleanup" | "finished";

export function diffEventLifecycle(event: AcmDiffEvent): DiffEventLifecycle {
  if (event.cleanupConfirmed) return "finished";
  if (
    event.cleanupBlocked ||
    event.terminationError ||
    event.result?.cleanupBlocked ||
    event.result?.terminationError
  )
    return "pending-cleanup";
  if (event.side === "comparison" && event.result) return "finished";
  return "none";
}

async function releaseDocument(documentId: string): Promise<void> {
  try {
    await window.api.acm.releaseDocument(documentId);
  } catch (error) {
    console.warn("释放对拍文档失败", error);
  }
}

async function stopDiffSafely(): Promise<void> {
  try {
    await window.api.acm.stopDiff();
  } catch (error) {
    console.warn("停止对拍失败", error);
  }
}

function resultType(
  result: AcmDiffResult | null,
): "success" | "error" | "warning" | "info" {
  if (!result) return "info";
  if (result.status === "match") return "success";
  if (result.status === "mismatch") return "error";
  if (result.status === "cancelled") return "warning";
  return "error";
}

function renderDifference(result: AcmDiffResult): JSX.Element | null {
  if (result.status !== "mismatch" || !result.difference) return null;
  const difference = result.difference;
  const reference = difference.referenceTokens.join(" ");
  const candidate = difference.candidateTokens.join(" ");
  return (
    <div className="acm-diff-difference">
      <Typography.Text strong>首个差异（前后各 3 个 token）</Typography.Text>
      <div>
        <Typography.Text type="secondary">标准程序：</Typography.Text>
        <code>{reference || "（缺失 token）"}</code>
      </div>
      <div>
        <Typography.Text type="secondary">待测程序：</Typography.Text>
        <code>{candidate || "（缺失 token）"}</code>
      </div>
      {difference.referenceMissing ? (
        <Typography.Text type="warning">
          标准程序少了 {difference.referenceMissing} 个
          token，待测程序多了同样数量
        </Typography.Text>
      ) : null}
      {difference.candidateMissing ? (
        <Typography.Text type="warning">
          待测程序少了 {difference.candidateMissing} 个
          token，标准程序多了同样数量
        </Typography.Text>
      ) : null}
    </div>
  );
}

function renderOutputStream(label: string, value: string): JSX.Element {
  return (
    <div className="acm-diff-output-stream">
      <Typography.Text type="secondary">{label}</Typography.Text>
      <pre>{value || `（无 ${label}）`}</pre>
    </div>
  );
}

function renderProgramOutput(
  label: string,
  output: AcmDiffProgramOutput,
): JSX.Element {
  return (
    <section className="acm-diff-output-panel" aria-label={`${label}输出`}>
      <Typography.Text strong>{label}输出</Typography.Text>
      {renderOutputStream("stdout", output.stdout)}
      {renderOutputStream("stderr", output.stderr)}
    </section>
  );
}

function renderOutputs(result: AcmDiffResult): JSX.Element | null {
  if (!result.referenceOutput && !result.candidateOutput) return null;
  return (
    <div className="acm-diff-outputs">
      {result.referenceOutput
        ? renderProgramOutput("标准程序", result.referenceOutput)
        : null}
      {result.candidateOutput
        ? renderProgramOutput("待测程序", result.candidateOutput)
        : null}
    </div>
  );
}

function documentRequest(document: AcmDocument, force: boolean) {
  return {
    documentId: document.id,
    filePath: document.filePath,
    content: document.content,
    lineEnding: document.lineEnding,
    expectedFingerprint: document.savedFingerprint,
    force,
  };
}

function updateSideDocument(current: SideState, value: string): SideState {
  return {
    ...current,
    document: { ...current.document, content: value, dirty: true },
  };
}

async function confirmReplaceUnsaved(side: DiffSide): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: `替换${SIDE_LABELS[side]}源码？`,
      content: "当前页面有未保存修改，打开文件会覆盖这些内容。",
      okText: "打开并覆盖",
      cancelText: "取消",
      okButtonProps: { danger: true },
      maskClosable: false,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
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

export default function AcmDiffPage() {
  const { token } = theme.useToken();
  const dark = useDarkTheme();
  const [pluginStatus, setPluginStatus] = useState<AcmPluginStatus | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [reference, setReference] = useState<SideState>(() => ({
    document: emptyDocument(),
    managed: false,
  }));
  const [candidate, setCandidate] = useState<SideState>(() => ({
    document: emptyDocument(),
    managed: false,
  }));
  const [stdin, setStdin] = useState("");
  const [compilerSelection, setCompilerSelection] =
    useState<CompilerSelection | null>(null);
  const [compilerProbe, setCompilerProbe] =
    useState<CompilerProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [result, setResult] = useState<AcmDiffResult | null>(null);
  const [cleanupWarnings, setCleanupWarnings] = useState<string[]>([]);
  const taskRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const pendingEventsRef = useRef<AcmDiffEvent[]>([]);
  const pageAliveRef = useRef(true);
  const sides = useMemo(
    () => ({ reference, candidate }),
    [reference, candidate],
  );
  const sidesRef = useRef(sides);
  useEffect(() => {
    sidesRef.current = sides;
  }, [sides]);

  useEffect(() => {
    let alive = true;
    const showNotice = () => setNoticeVisible(true);
    window.addEventListener("acm-notice-cleared", showNotice);
    const load = async (): Promise<void> => {
      try {
        const [status, notice, selection, probe] = await Promise.all([
          window.api.acm.getStatus(),
          window.api.acm.getNoticeState(),
          window.api.acm.getCompilerSelection(),
          window.api.acm.probeCompiler(),
        ]);
        if (!alive) return;
        if (!status.ok || !status.data) {
          const error = errorText(status);
          setLoadError(error);
          message.error(error);
          return;
        }
        setLoadError(null);
        setPluginStatus(status.data);
        if (notice.ok && notice.data) setNoticeVisible(notice.data.visible);
        if (selection.ok && selection.data)
          setCompilerSelection(selection.data);
        if (probe.ok && probe.data) setCompilerProbe(probe.data);
      } catch (error) {
        if (!alive) return;
        const messageText =
          error instanceof Error ? error.message : "ACM 状态读取失败";
        setLoadError(messageText);
        message.error(messageText);
      }
    };
    void load();
    const unsubscribe = window.api.acm.onDiffEvent((event) => {
      if (!taskRef.current) {
        if (busyRef.current) pendingEventsRef.current.push(event);
        return;
      }
      if (event.taskId !== taskRef.current) return;
      if (event.status === "started") setPhase(event.stage);
      if (event.result) setResult(event.result);
      setCleanupWarnings((items) => mergeDiffCleanupWarnings(items, event));
      const lifecycle = diffEventLifecycle(event);
      if (lifecycle === "pending-cleanup") setCleanupPending(true);
      if (lifecycle === "finished") {
        setCleanupPending(false);
        setBusy(false);
        busyRef.current = false;
        taskRef.current = null;
        setPhase(null);
      }
      if (event.side === "comparison" && event.result) {
        if (lifecycle === "finished") {
          setCleanupPending(false);
          setBusy(false);
          busyRef.current = false;
          taskRef.current = null;
          setPhase(null);
        }
      }
    });
    return () => {
      alive = false;
      pageAliveRef.current = false;
      window.removeEventListener("acm-notice-cleared", showNotice);
      unsubscribe();
      if (busyRef.current) void stopDiffSafely();
      const current = sidesRef.current;
      if (current.reference.managed)
        void releaseDocument(current.reference.document.id);
      if (current.candidate.managed)
        void releaseDocument(current.candidate.document.id);
    };
  }, []);

  const ensureManaged = useCallback(
    async (side: DiffSide): Promise<SideState> => {
      const current = sides[side];
      if (current.managed) return current;
      const scope = side === "candidate" ? "diff-candidate" : "diff-reference";
      const created = await window.api.acm.createDocument("blank", scope);
      if (!created.ok || !created.data) throw new Error(errorText(created));
      const next = {
        document: {
          ...created.data,
          content: current.document.content,
          lineEnding: current.document.lineEnding,
          dirty: current.document.dirty,
        },
        managed: true,
      };
      if (side === "reference") setReference(next);
      else setCandidate(next);
      return next;
    },
    [sides],
  );

  const openSide = useCallback(
    async (side: DiffSide) => {
      try {
        if (sides[side].document.dirty && !(await confirmReplaceUnsaved(side)))
          return;
        const scope =
          side === "candidate" ? "diff-candidate" : "diff-reference";
        const opened = await window.api.acm.openDocument(scope);
        if (!pageAliveRef.current) {
          if (opened.ok && opened.data) void releaseDocument(opened.data.id);
          return;
        }
        if (!opened.ok || !opened.data) {
          if (!opened.ok) message.error(errorText(opened));
          return;
        }
        const current = sides[side];
        if (current.managed) void releaseDocument(current.document.id);
        const next = { document: opened.data, managed: true };
        if (side === "reference") setReference(next);
        else setCandidate(next);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "打开文件失败");
      }
    },
    [sides],
  );

  const saveSide = useCallback(
    async (side: DiffSide, saveAs: boolean) => {
      try {
        const state = await ensureManaged(side);
        const request = documentRequest(state.document, saveAs);
        const saved = saveAs
          ? await window.api.acm.saveDocumentAs(request)
          : await window.api.acm.saveDocument(request);
        if (!saved.ok || !saved.data) {
          if (!saved.ok) message.error(errorText(saved));
          return;
        }
        const next = { document: saved.data, managed: true };
        if (side === "reference") setReference(next);
        else setCandidate(next);
        message.success(`${SIDE_LABELS[side]}已保存`);
        showWarnings(saved.warnings);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "保存文件失败");
      }
    },
    [ensureManaged],
  );

  const start = useCallback(async () => {
    if (!isUsable(pluginStatus) || busyRef.current) return;
    if (!reference.document.content || !candidate.document.content) {
      message.warning("请先输入标准程序和待测程序源码");
      return;
    }
    setBusy(true);
    setCleanupPending(false);
    busyRef.current = true;
    setResult(null);
    setCleanupWarnings([]);
    try {
      const started = await window.api.acm.startDiff({
        reference: reference.document.content,
        candidate: candidate.document.content,
        stdin,
      });
      if (!started.ok || !started.data) {
        setBusy(false);
        busyRef.current = false;
        message.error(errorText(started));
        return;
      }
      taskRef.current = started.data.taskId;
      for (const event of pendingEventsRef.current.splice(0)) {
        if (event.taskId !== started.data.taskId) continue;
        const lifecycle = diffEventLifecycle(event);
        if (event.side === "comparison" && event.result)
          setResult(event.result);
        setCleanupWarnings((items) => mergeDiffCleanupWarnings(items, event));
        if (lifecycle === "finished") {
          setCleanupPending(false);
          setBusy(false);
          busyRef.current = false;
          taskRef.current = null;
          setPhase(null);
        } else if (lifecycle === "pending-cleanup") setCleanupPending(true);
      }
    } catch (error) {
      setBusy(false);
      busyRef.current = false;
      message.error(error instanceof Error ? error.message : "启动对拍失败");
    }
  }, [
    candidate.document.content,
    pluginStatus,
    reference.document.content,
    stdin,
  ]);

  const stop = useCallback(async () => {
    if (!busyRef.current) return;
    try {
      const stopped = await window.api.acm.stopDiff();
      if (!stopped.ok) message.error(errorText(stopped));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "停止对拍失败");
    }
  }, []);

  const dismissNotice = useCallback(async () => {
    try {
      const dismissed = await window.api.acm.dismissNotice();
      if (dismissed.ok) setNoticeVisible(false);
      else message.error(errorText(dismissed));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "关闭提示失败");
    }
  }, []);

  const update = (side: DiffSide, value: string) => {
    if (side === "reference")
      setReference((current) => updateSideDocument(current, value));
    else setCandidate((current) => updateSideDocument(current, value));
  };

  if (!pluginStatus)
    return loadError ? (
      <Alert
        type="error"
        showIcon
        message="无法读取 ACM 工具状态"
        description={loadError}
      />
    ) : (
      <Empty description="正在检查 ACM 工具状态…" />
    );
  const forceNotice = ["disabled", "unsupported", "error"].includes(
    pluginStatus.state,
  );
  const showNotice = noticeVisible || forceNotice;
  const noticeMessage =
    pluginStatus.state === "disabled"
      ? "ACM 工具已禁用"
      : pluginStatus.state === "unsupported"
        ? "当前系统不支持 ACM 工具"
        : pluginStatus.state === "error"
          ? "ACM 工具初始化失败"
          : "ACM 工具已启用";
  const noticeDescription = forceNotice
    ? (pluginStatus.error ??
      (pluginStatus.state === "disabled"
        ? "启用插件后可使用对拍和 C++ 临时 IDE。"
        : "ACM 对拍仅支持 Windows 11 x64。"))
    : "对拍会在主进程中受限执行，源码和 stdin 只保留在当前页面。";
  return (
    <div
      className="acm-workbench acm-diff-page"
      style={
        {
          "--acm-primary": token.colorPrimary,
          "--acm-warning": token.colorWarning,
          "--acm-error": token.colorError,
          "--acm-success": token.colorSuccess,
          "--acm-editor-background": token.colorBgContainer,
          "--acm-editor-foreground": token.colorText,
          "--acm-editor-border": token.colorBorderSecondary,
          "--acm-editor-muted": token.colorTextTertiary,
        } as React.CSSProperties
      }
    >
      <div className="acm-workbench-header">
        <Typography.Title level={3} className="acm-page-title">
          ACM 对拍
        </Typography.Title>
        <Typography.Text type="secondary">
          C++17 · 顺序执行 · 空白 token 比较
        </Typography.Text>
      </div>
      {showNotice ? (
        <Alert
          className="acm-status-banner"
          type={forceNotice ? "warning" : "info"}
          showIcon
          icon={<WarningOutlined />}
          message={noticeMessage}
          description={noticeDescription}
          closable={!forceNotice}
          onClose={() => void dismissNotice()}
        />
      ) : null}
      <div className="acm-diff-toolbar">
        <Space wrap>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={
              !isUsable(pluginStatus) || !compilerProbe?.available || busy
            }
            onClick={() => void start()}
          >
            开始对拍
          </Button>
          <Button
            danger
            icon={<StopOutlined />}
            disabled={!busy}
            onClick={() => void stop()}
          >
            停止
          </Button>
          {busy ? (
            <Tag color="processing">
              {cleanupPending ? "等待进程退出/清理" : (phase ?? "准备中")}
            </Tag>
          ) : null}
          <Tag color={compilerProbe?.available ? "success" : "warning"}>
            {compilerProbe?.available
              ? `g++ ${compilerProbe.version ?? "已就绪"}`
              : "未检测到编译器"}
          </Tag>
          {compilerSelection ? (
            <Typography.Text type="secondary">
              {compilerSelection.mode === "auto"
                ? "自动工具链"
                : compilerSelection.mode === "builtin"
                  ? "内置工具链"
                  : "自定义工具链"}
            </Typography.Text>
          ) : null}
        </Space>
      </div>
      <div className="acm-diff-editors">
        {(["reference", "candidate"] as const).map((side) => {
          const state = sides[side];
          return (
            <Card
              key={side}
              size="small"
              title={SIDE_LABELS[side]}
              className="acm-diff-editor-card"
              extra={
                <Space size="small">
                  <Button
                    size="small"
                    icon={<FolderOpenOutlined />}
                    disabled={!isUsable(pluginStatus) || busy}
                    onClick={() => void openSide(side)}
                  >
                    打开
                  </Button>
                  <Button
                    size="small"
                    icon={<SaveOutlined />}
                    disabled={
                      !isUsable(pluginStatus) || busy || !state.document.dirty
                    }
                    onClick={() => void saveSide(side, false)}
                  >
                    保存
                  </Button>
                  <Button
                    size="small"
                    icon={<SaveOutlined />}
                    disabled={!isUsable(pluginStatus) || busy}
                    onClick={() => void saveSide(side, true)}
                  >
                    另存为
                  </Button>
                </Space>
              }
            >
              <div className="acm-editor-frame acm-diff-editor-frame">
                <CodeEditor
                  documentId={state.document.id}
                  value={state.document.content}
                  readOnly={
                    state.document.readOnly || !isUsable(pluginStatus) || busy
                  }
                  dark={dark}
                  onChange={(_, value) => update(side, value)}
                />
              </div>
              <Typography.Text type="secondary">
                {state.document.filePath ?? "未保存文件"}
                {state.document.dirty ? " · 未保存" : ""}
              </Typography.Text>
            </Card>
          );
        })}
      </div>
      <Card
        size="small"
        title="stdin（当前页面会话）"
        className="acm-diff-stdin-card"
      >
        <Input.TextArea
          value={stdin}
          onChange={(event) => setStdin(event.target.value)}
          disabled={busy || !isUsable(pluginStatus)}
          placeholder="输入将同时提供给标准程序和待测程序"
          autoSize={{ minRows: 4, maxRows: 10 }}
        />
      </Card>
      {result ? (
        <Alert
          type={resultType(result)}
          showIcon
          message={RESULT_LABELS[result.status] ?? result.status}
          description={renderDifference(result)}
          action={
            result.status === "mismatch" ? (
              <Button
                size="small"
                icon={<ClearOutlined />}
                onClick={() => setResult(null)}
              >
                清除
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {result ? renderOutputs(result) : null}
      {cleanupWarnings.length ? (
        <Alert
          type="warning"
          showIcon
          message="临时文件清理警告"
          description={
            <ul>
              {cleanupWarnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          }
        />
      ) : null}
    </div>
  );
}
