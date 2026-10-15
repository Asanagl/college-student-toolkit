// 外观设置弹窗
// 职责：提供材质模式切换、背景图上传、模糊度/清晰度调节的 UI
// 状态由主进程 AppearanceService 持久化，本组件通过 IPC 同步配置变更
import { useState, useEffect, useRef } from 'react';
import { Modal, Radio, Button, Slider, Space, Typography, message, Tag } from 'antd';
import { UploadOutlined, DeleteOutlined, PictureOutlined } from '@ant-design/icons';
import type { AppearanceConfig, MaterialMode } from '../../shared/types';

const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AppearanceSettingsModal({ open, onClose }: Props) {
  const [config, setConfig] = useState<AppearanceConfig | null>(null);
  const [uploading, setUploading] = useState(false);
  // 滑块本地值：拖动期间以本地值为准，避免每格都走 IPC 落盘
  const [blur, setBlur] = useState(0);
  const [clarity, setClarity] = useState(100);
  // 拖动中标记：此时远端广播不得回灌滑块，否则手感会被"拽回去"
  const draggingRef = useRef(false);

  // 打开时获取当前外观配置，并订阅广播
  useEffect(() => {
    if (!open) return;
    // 本组件由 MainLayout 常驻渲染不会卸载，弹窗快速开关时 get() 回包可能迟到，
    // 用 alive 标记丢弃过期回包，避免覆盖新一轮的状态
    let alive = true;
    const applyConfig = (next: AppearanceConfig) => {
      if (!alive) return;
      setConfig(next);
      if (!draggingRef.current) {
        setBlur(next.blurRadius);
        setClarity(next.clarity);
      }
    };
    window.api.appearance.get().then((result) => {
      if (result.ok && result.data) {
        applyConfig(result.data);
      }
    });
    const off = window.api.appearance.onChange(applyConfig);
    return () => {
      alive = false;
      off();
    };
  }, [open]);

  // 切换材质模式
  const handleMaterialChange = async (mode: MaterialMode) => {
    const result = await window.api.appearance.setMaterial(mode);
    if (!result.ok) {
      message.error(`切换材质失败: ${result.error}`);
    }
  };

  // 上传背景图：由主进程弹出文件对话框，渲染层不接触任意本地路径。
  const handleChooseBackground = async (): Promise<void> => {
    setUploading(true);
    try {
      const result = await window.api.appearance.chooseBackground();
      if (!result.ok) {
        message.error(`上传失败: ${result.error ?? '未知错误'}`);
      } else {
        if (result.data) message.success('背景图已应用');
      }
    } finally {
      setUploading(false);
    }
  };

  // 清除背景图
  const handleClearBackground = async () => {
    const result = await window.api.appearance.clearBackground();
    if (!result.ok) {
      message.error(`清除失败: ${result.error}`);
    } else {
      message.success('已清除背景图');
    }
  };

  // 拖动中只更新本地值：每格都发 IPC 会触发主进程同步写盘 + 全应用重渲染，明显卡顿
  const handleBlurChange = (value: number) => {
    draggingRef.current = true;
    setBlur(value);
  };

  // 松手时才落盘一次
  const handleBlurComplete = async (value: number) => {
    draggingRef.current = false;
    const res = await window.api.appearance.setBlur(value);
    if (!res.ok) {
      message.error(res.error ?? '设置模糊度失败');
    }
  };

  const handleClarityChange = (value: number) => {
    draggingRef.current = true;
    setClarity(value);
  };

  const handleClarityComplete = async (value: number) => {
    draggingRef.current = false;
    const res = await window.api.appearance.setClarity(value);
    if (!res.ok) {
      message.error(res.error ?? '设置清晰度失败');
    }
  };

  const hasBackground = !!config?.backgroundImage;
  const acrylicSupported = config?.acrylicSupported ?? false;

  return (
    <Modal
      title="外观设置"
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
      ]}
      width={520}
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* 区块 1：材质模式 */}
        <div>
          <Paragraph strong style={{ marginBottom: 8 }}>
            材质风格
          </Paragraph>
          <Radio.Group
            value={config?.material ?? 'none'}
            onChange={(e) => handleMaterialChange(e.target.value as MaterialMode)}
          >
            <Space direction="vertical">
              <Radio value="none">标准</Radio>
              <Radio value="acrylic" disabled={!acrylicSupported}>
                <Space size={4}>
                  <span>亚克力</span>
                  {!acrylicSupported && (
                    <Tag color="default" style={{ fontSize: 11 }}>
                      需要 Win11 22H2+
                    </Tag>
                  )}
                </Space>
              </Radio>
            </Space>
          </Radio.Group>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
            亚克力材质让窗口背景半透明，透出桌面壁纸。仅 Windows 11 22H2+ 支持。
          </Text>
        </div>

        {/* 区块 2：背景图 */}
        <div>
          <Paragraph strong style={{ marginBottom: 8 }}>
            背景图片
          </Paragraph>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Button icon={<UploadOutlined />} loading={uploading} onClick={() => void handleChooseBackground()}>
                  选择图片
              </Button>
              {hasBackground && (
                <Button icon={<DeleteOutlined />} danger onClick={handleClearBackground}>
                  清除背景
                </Button>
              )}
            </Space>
            {hasBackground ? (
              <div
                style={{
                  width: '100%',
                  height: 120,
                  backgroundImage: `url(${config?.backgroundImage})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  borderRadius: 6,
                  border: '1px solid rgba(128,128,128,0.3)',
                }}
              />
            ) : (
              <div
                style={{
                  width: '100%',
                  height: 80,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(128,128,128,0.08)',
                  borderRadius: 6,
                  color: 'rgba(128,128,128,0.6)',
                }}
              >
                <PictureOutlined style={{ marginRight: 8 }} />
                <Text type="secondary">暂无背景图</Text>
              </div>
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              支持 JPG/PNG/WEBP/BMP/GIF，最大 10MB
            </Text>
          </Space>
        </div>

        {/* 区块 3、4：模糊度与清晰度（仅在有背景图时显示） */}
        {hasBackground && (
          <>
            <div>
              <Paragraph strong style={{ marginBottom: 8 }}>
                模糊度: {blur}px
              </Paragraph>
              <Slider
                min={0}
                max={50}
                step={1}
                value={blur}
                onChange={handleBlurChange}
                onChangeComplete={handleBlurComplete}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                数值越大背景图越模糊
              </Text>
            </div>
            <div>
              <Paragraph strong style={{ marginBottom: 8 }}>
                清晰度: {clarity}%
              </Paragraph>
              <Slider
                min={0}
                max={100}
                step={1}
                value={clarity}
                onChange={handleClarityChange}
                onChangeComplete={handleClarityComplete}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                控制背景图透明度，100% 完全不透明
              </Text>
            </div>
          </>
        )}
      </Space>
    </Modal>
  );
}
