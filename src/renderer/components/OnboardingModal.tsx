import { useEffect, useState } from "react";
import { Alert, Button, Modal, Space, Steps, theme, Typography } from "antd";
import {
  CalendarOutlined,
  CodeOutlined,
  DatabaseOutlined,
  RocketOutlined,
} from "@ant-design/icons";

const { Paragraph, Text, Title } = Typography;

const ITEMS = [
  {
    title: "安排学习节奏",
    icon: <CalendarOutlined />,
    body: "在日程、课程表、考试和实验中维护你的学习安排，提醒会在本机按设置运行。",
  },
  {
    title: "管理成绩与 GPA",
    icon: <DatabaseOutlined />,
    body: "记录课程成绩和学分，用加权 GPA 公式快速查看学期表现。",
  },
  {
    title: "开始 ACM 练习",
    icon: <CodeOutlined />,
    body: "打开 ACM 临时 IDE 编译运行 C++，或在对拍页比较标准程序与待测程序的输出。",
  },
  {
    title: "从空白工作区开始",
    icon: <RocketOutlined />,
    body: "数据默认保存在本机。你可以手动录入，也可以在需要时从教务系统导入。",
  },
] as const;

interface Props {
  open: boolean;
  onComplete: () => void;
}

export default function OnboardingModal({ open, onComplete }: Props) {
  const [current, setCurrent] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    token: { colorPrimary },
  } = theme.useToken();

  useEffect(() => {
    if (open) {
      setCurrent(0);
      setError(null);
    }
  }, [open]);

  const finish = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.api.onboarding.complete();
      if (result.ok) {
        onComplete();
      } else {
        setError(result.error ?? "暂时无法保存引导状态，请稍后重试。");
      }
    } catch (value) {
      setError(
        value instanceof Error
          ? value.message
          : "暂时无法保存引导状态，请稍后重试。",
      );
    } finally {
      setSaving(false);
    }
  };
  const item = ITEMS[current];

  return (
    <Modal
      open={open}
      title="欢迎使用大学生工具组"
      centered
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={null}
      width={620}
    >
      <Space direction="vertical" size={24} style={{ width: "100%" }}>
        <div>
          <Title level={4} style={{ marginTop: 0 }}>
            为学习和 ACM 训练准备的本地工作区
          </Title>
          <Paragraph type="secondary">
            这是一份快速概览。跳过后会直接进入空白首页，之后可以从左侧导航进入任意工具。
          </Paragraph>
        </div>
        <Steps
          current={current}
          items={ITEMS.map(({ title, icon }) => ({ title, icon }))}
          onChange={(value) => {
            if (!saving) setCurrent(value);
          }}
          responsive
        />
        <div className="onboarding-step-content" aria-live="polite">
          <div
            className="onboarding-step-icon"
            style={{
              background: `color-mix(in srgb, ${colorPrimary} 12%, transparent)`,
              color: colorPrimary,
            }}
          >
            {item.icon}
          </div>
          <Title level={3} style={{ margin: 0 }}>
            {item.title}
          </Title>
          <Text type="secondary">{item.body}</Text>
        </div>
        {error && <Alert type="error" showIcon message={error} />}
        <div className="onboarding-actions">
          <Button type="text" loading={saving} onClick={() => void finish()}>
            跳过引导
          </Button>
          <Space>
            {current > 0 && (
              <Button
                disabled={saving}
                onClick={() => setCurrent((value) => value - 1)}
              >
                上一步
              </Button>
            )}
            {current < ITEMS.length - 1 ? (
              <Button
                type="primary"
                disabled={saving}
                onClick={() => setCurrent((value) => value + 1)}
              >
                下一步
              </Button>
            ) : (
              <Button
                type="primary"
                loading={saving}
                onClick={() => void finish()}
              >
                开始使用
              </Button>
            )}
          </Space>
        </div>
      </Space>
    </Modal>
  );
}
