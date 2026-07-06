// 外观设置弹窗
// 职责：提供材质模式切换、背景图上传、模糊度/清晰度调节的 UI
// 状态由主进程 AppearanceService 持久化，本组件通过 IPC 同步配置变更
import { useState, useEffect } from 'react';
import { Modal, Radio, Upload, Button, Slider, Space, Typography, message, Tag } from 'antd';
import { UploadOutlined, DeleteOutlined, PictureOutlined } from '@ant-design/icons';
import type { AppearanceConfig, MaterialMode } from '../../shared/types';

const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Electron 在 File 对象上扩展了 path 属性（指向磁盘文件绝对路径）。
 * 浏览器标准 File 无此属性，需通过类型断言访问。
 */
interface ElectronFile extends File {
  path: string;
}

export default function AppearanceSettingsModal({ open, onClose }: Props) {
  const [config, setConfig] = useState<AppearanceConfig | null>(null);
  const [uploading, setUploading] = useState(false);

  // 启动时获取当前外观配置，并订阅广播
  useEffect(() => {
    if (!open) return;
    window.api.appearance.get().then((result) => {
      if (result.ok && result.data) {
        setConfig(result.data);
      }
    });
    window.api.appearance.onChange((next) => setConfig(next));
  }, [open]);

  // 切换材质模式
  const handleMaterialChange = async (mode: MaterialMode) => {
    const result = await window.api.appearance.setMaterial(mode);
    if (!result.ok) {
      message.error(`切换材质失败: ${result.error}`);
    }
  };

  // 上传背景图：拦截 antd Upload 的 beforeUpload，用 File.path 调用主进程
  const handleBeforeUpload = async (file: File): Promise<boolean> => {
    const electronFile = file as ElectronFile;
    if (!electronFile.path) {
      message.error('无法获取文件路径，请重试');
      return false;
    }
    setUploading(true);
    try {
      const result = await window.api.appearance.uploadBackground(electronFile.path);
      if (!result.ok) {
        message.error(`上传失败: ${result.error}`);
      } else {
        message.success('背景图已应用');
      }
    } finally {
      setUploading(false);
    }
    // 返回 false 阻止 antd Upload 的默认上传行为
    return false;
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

  // 模糊度滑块变化（实时调用主进程）
  const handleBlurChange = (value: number) => {
    window.api.appearance.setBlur(value);
  };

  // 清晰度滑块变化（实时调用主进程）
  const handleClarityChange = (value: number) => {
    window.api.appearance.setClarity(value);
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
              <Upload
                accept=".jpg,.jpeg,.png,.webp,.bmp,.gif"
                showUploadList={false}
                beforeUpload={handleBeforeUpload}
                disabled={uploading}
              >
                <Button icon={<UploadOutlined />} loading={uploading}>
                  选择图片
                </Button>
              </Upload>
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
                模糊度: {config?.blurRadius ?? 0}px
              </Paragraph>
              <Slider
                min={0}
                max={50}
                step={1}
                value={config?.blurRadius ?? 0}
                onChange={handleBlurChange}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                数值越大背景图越模糊
              </Text>
            </div>
            <div>
              <Paragraph strong style={{ marginBottom: 8 }}>
                清晰度: {config?.clarity ?? 100}%
              </Paragraph>
              <Slider
                min={0}
                max={100}
                step={1}
                value={config?.clarity ?? 100}
                onChange={handleClarityChange}
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
