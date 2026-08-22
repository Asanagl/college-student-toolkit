// 0.3.0 统一设置：把课程、通知、外观、OCR、备份和更新放入同一入口。
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Input,
  List,
  Modal,
  Progress,
  Radio,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  PictureOutlined,
  ReloadOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type {
  AppearanceConfig,
  BackupInspection,
  DndConfig,
  NotificationRecord,
  OcrComponentStatus,
  TimetablePreferences,
  UpdateChannel,
} from "../../shared/types";

const { Paragraph, Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatTime(value: string): string {
  return /^\d{2}:\d{2}$/.test(value) ? value : "00:00";
}

function inspectionText(
  value: Pick<BackupInspection, "recordCounts" | "warnings">,
): string {
  const counts = Object.entries(value.recordCounts)
    .map(([key, count]) => `${key}:${count}`)
    .join("，");
  return `将恢复 ${counts}${value.warnings.length ? `。提示：${value.warnings.join("；")}` : ""}`;
}

function updateChannelText(channel: UpdateChannel): string {
  if (channel === "microsoft-store")
    return "Microsoft Store（由 Store 管理更新）";
  if (channel === "github") return "GitHub Stable（备用 NSIS 渠道）";
  return "开发模式（不检查更新）";
}

export default function SettingsModal({ open, onClose }: Props) {
  const [preferences, setPreferences] = useState<TimetablePreferences>({
    semesterStart: null,
  });
  const [dnd, setDnd] = useState<DndConfig>({
    enabled: false,
    startTime: "22:00",
    endTime: "08:00",
  });
  const [history, setHistory] = useState<NotificationRecord[]>([]);
  const [appearance, setAppearance] = useState<AppearanceConfig | null>(null);
  const [ocr, setOcr] = useState<OcrComponentStatus | null>(null);
  const [version, setVersion] = useState("");
  const [updateChannel, setUpdateChannel] =
    useState<UpdateChannel>("development");
  const [savingSemester, setSavingSemester] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async (): Promise<void> => {
      const results = await Promise.all([
        window.api.timetable.getPreferences(),
        window.api.notify.getDnd(),
        window.api.notify.getHistory(),
        window.api.appearance.get(),
        window.api.ocrComponent.getStatus(),
        window.api.update.getCurrentVersion(),
        window.api.update.getChannel(),
      ]);
      if (!alive) return;
      if (results[0].ok && results[0].data) setPreferences(results[0].data);
      if (results[1].ok && results[1].data) setDnd(results[1].data);
      if (results[2].ok && results[2].data) setHistory(results[2].data);
      if (results[3].ok && results[3].data) setAppearance(results[3].data);
      if (results[4].ok && results[4].data) setOcr(results[4].data);
      if (results[5].ok && results[5].data) setVersion(results[5].data);
      if (results[6].ok && results[6].data) setUpdateChannel(results[6].data);
    };
    void load();
    const offAppearance = window.api.appearance.onChange(setAppearance);
    const offOcr = window.api.ocrComponent.onStatusChange(setOcr);
    const offRestore = window.api.data.onRestoreCompleted(() => void load());
    return () => {
      alive = false;
      offAppearance();
      offOcr();
      offRestore();
    };
  }, [open]);

  const saveSemester = async (): Promise<void> => {
    setSavingSemester(true);
    const result = await window.api.timetable.setSemesterStart(
      preferences.semesterStart || null,
    );
    setSavingSemester(false);
    if (!result.ok) message.error(result.error ?? "保存学期设置失败");
    else
      message.success(
        preferences.semesterStart ? "学期起始日期已保存" : "已暂停课程提醒",
      );
  };

  const saveDnd = async (): Promise<void> => {
    const result = await window.api.notify.setDnd(dnd);
    if (!result.ok) message.error(result.error ?? "保存免打扰设置失败");
    else message.success("通知设置已保存");
  };

  const clearHistory = async (): Promise<void> => {
    const result = await window.api.notify.clearHistory();
    if (result.ok) setHistory([]);
    else message.error(result.error ?? "清空通知历史失败");
  };

  const exportBackup = async (): Promise<void> => {
    const result = await window.api.data.exportBackup();
    if (result.ok && result.data)
      message.success(`备份已导出：${result.data.filePath}`);
    else if (!result.ok)
      message.error(
        `${result.error ?? "导出备份失败"}${result.errorCode ? `（${result.errorCode}）` : ""}`,
      );
  };

  const prepareImport = async (): Promise<void> => {
    const result = await window.api.data.prepareImport();
    if (!result.ok || !result.data) {
      if (!result.ok)
        message.error(
          `${result.error ?? "备份预检失败"}${result.errorCode ? `（${result.errorCode}）` : ""}`,
        );
      return;
    }
    const { inspection } = result.data;
    Modal.confirm({
      title: "确认覆盖当前数据？",
      content: <Paragraph>{inspectionText(inspection)}</Paragraph>,
      okText: "确认恢复",
      cancelText: "取消",
      okButtonProps: { danger: true },
      maskClosable: false,
      onCancel: () => {
        void window.api.data.cancelImport(inspection.token);
      },
      onOk: async () => {
        const committed = await window.api.data.commitImport(inspection.token);
        if (!committed.ok) {
          message.error(
            `${committed.error ?? "恢复失败"}${committed.errorCode ? `（${committed.errorCode}）` : ""}`,
          );
          return;
        }
        message.success("数据恢复完成，提醒和设置已重新加载");
      },
    });
  };

  const installOcr = async (): Promise<void> => {
    const result = await window.api.ocrComponent.install();
    if (!result.ok)
      message.error(
        `${result.error ?? "OCR 组件安装失败"}${result.errorCode ? `（${result.errorCode}）` : ""}`,
      );
    else if (result.data) setOcr(result.data);
  };

  const cancelOcr = async (): Promise<void> => {
    await window.api.ocrComponent.cancelInstall();
  };

  const removeOcr = async (): Promise<void> => {
    const result = await window.api.ocrComponent.remove();
    if (result.ok) setOcr(null);
    else message.error(result.error ?? "删除 OCR 组件失败");
  };

  const appearancePanel = appearance ? (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Radio.Group
        value={appearance.material}
        onChange={(event) => {
          void window.api.appearance.setMaterial(event.target.value);
        }}
      >
        <Radio value="none">标准</Radio>
        <Radio value="acrylic" disabled={!appearance.acrylicSupported}>
          亚克力
        </Radio>
      </Radio.Group>
      <Space>
        <Button
          icon={<UploadOutlined />}
          onClick={() => {
            void window.api.appearance.chooseBackground();
          }}
        >
          选择背景图片
        </Button>
        <Button
          icon={<DeleteOutlined />}
          danger
          disabled={!appearance.backgroundImage}
          onClick={() => {
            void window.api.appearance.clearBackground();
          }}
        >
          清除背景
        </Button>
      </Space>
      {appearance.backgroundImage ? (
        <div
          style={{
            height: 140,
            borderRadius: 8,
            backgroundImage: `url(${appearance.backgroundImage})`,
            backgroundSize: "cover",
          }}
        />
      ) : (
        <Card size="small">
          <PictureOutlined /> 暂无背景图片
        </Card>
      )}
      <Text type="secondary">
        支持 JPG/PNG/WEBP/BMP/GIF，最大 10 MiB。文件由主进程复制并校验。
      </Text>
      <div>
        <Text>模糊度：{appearance.blurRadius}px</Text>
        <Slider
          min={0}
          max={50}
          value={appearance.blurRadius}
          onChange={(value) => {
            void window.api.appearance.setBlur(value);
          }}
        />
      </div>
      <div>
        <Text>清晰度：{appearance.clarity}%</Text>
        <Slider
          min={0}
          max={100}
          value={appearance.clarity}
          onChange={(value) => {
            void window.api.appearance.setClarity(value);
          }}
        />
      </div>
    </Space>
  ) : (
    <Text type="secondary">正在加载外观设置…</Text>
  );

  const notificationPanel = (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Space>
        <Text>免打扰</Text>
        <Switch
          checked={dnd.enabled}
          onChange={(enabled) => setDnd((current) => ({ ...current, enabled }))}
        />
      </Space>
      <Space wrap>
        <Text>开始</Text>
        <Input
          type="time"
          value={formatTime(dnd.startTime)}
          onChange={(event) =>
            setDnd((current) => ({ ...current, startTime: event.target.value }))
          }
        />
        <Text>结束</Text>
        <Input
          type="time"
          value={formatTime(dnd.endTime)}
          onChange={(event) =>
            setDnd((current) => ({ ...current, endTime: event.target.value }))
          }
        />
        <Button type="primary" onClick={() => void saveDnd()}>
          保存
        </Button>
      </Space>
      <Text type="secondary">
        起止时间相同表示全天静默；免打扰期间提醒仍会记录，结束后汇总。
      </Text>
      <Space>
        <Text strong>通知历史（最近 {history.length} 条）</Text>
        <Button
          size="small"
          icon={<DeleteOutlined />}
          onClick={() => void clearHistory()}
        >
          清空
        </Button>
      </Space>
      <List
        size="small"
        dataSource={history.slice(0, 20)}
        locale={{ emptyText: "暂无通知记录" }}
        renderItem={(item) => (
          <List.Item>
            <List.Item.Meta
              title={item.title}
              description={`${item.body} · ${new Date(item.timestamp).toLocaleString()}`}
            />
            <Tag color={item.delivered ? "green" : "orange"}>
              {item.delivered ? "已送达" : "免打扰"}
            </Tag>
          </List.Item>
        )}
      />
    </Space>
  );

  const ocrPanel = (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Space>
        <Tag color={ocr?.state === "ready" ? "green" : "default"}>
          {ocr?.state ?? "not-installed"}
        </Tag>
        <Text>ocr-chi-sim 1.0.0</Text>
      </Space>
      {ocr?.state === "downloading" && (
        <Progress percent={Math.round(ocr.progress)} status="active" />
      )}
      {ocr?.error && <Text type="danger">{ocr.error}</Text>}
      <Space>
        {ocr?.state === "downloading" ? (
          <Button onClick={() => void cancelOcr()}>取消下载</Button>
        ) : (
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => void installOcr()}
            disabled={ocr?.state === "ready"}
          >
            下载 OCR 组件
          </Button>
        )}
        <Button
          icon={<DeleteOutlined />}
          danger
          disabled={!ocr || ocr.state === "not-installed"}
          onClick={() => void removeOcr()}
        >
          删除组件
        </Button>
      </Space>
      <Text type="secondary">
        未安装时 DOM 导入和手动录入仍可用；组件只在你点击下载后访问固定 Release
        地址。
      </Text>
    </Space>
  );

  const tabs = [
    {
      key: "timetable",
      label: "课程与学期",
      children: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>学期起始日期</Text>
          <Input
            type="date"
            value={preferences.semesterStart ?? ""}
            onChange={(event) =>
              setPreferences({ semesterStart: event.target.value || null })
            }
          />
          <Text type="secondary">
            未设置时暂停课程提醒；设置后课程表会按当前周定位。
          </Text>
          <Button
            type="primary"
            loading={savingSemester}
            onClick={() => void saveSemester()}
          >
            保存学期设置
          </Button>
        </Space>
      ),
    },
    { key: "notification", label: "通知", children: notificationPanel },
    { key: "appearance", label: "外观", children: appearancePanel },
    { key: "ocr", label: "OCR 识别组件", children: ocrPanel },
    {
      key: "data",
      label: "数据与备份",
      children: (
        <Space direction="vertical">
          <Paragraph>
            备份包含课程、考试、实验、成绩、公式、学期、通知历史、主题和背景图，不包含密码、Cookie、登录会话、窗口坐标或
            OCR 组件。
          </Paragraph>
          <Space>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => void exportBackup()}
            >
              导出完整备份
            </Button>
            <Button
              icon={<ReloadOutlined />}
              danger
              onClick={() => void prepareImport()}
            >
              预检并恢复备份
            </Button>
          </Space>
        </Space>
      ),
    },
    {
      key: "about",
      label: "关于与更新",
      children: (
        <Space direction="vertical">
          <Text>当前版本：v{version || "…"}</Text>
          <Text>更新通道：{updateChannelText(updateChannel)}</Text>
          {updateChannel === "microsoft-store" ? (
            <Text type="secondary">
              此版本由 Microsoft Store 负责分发和更新，请在 Microsoft Store
              中查看更新。
            </Text>
          ) : (
            <Button onClick={() => void window.api.update.checkManual()}>
              手动检查更新
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Modal
      title="设置"
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={720}
      destroyOnClose={false}
    >
      <Tabs items={tabs} />
    </Modal>
  );
}
