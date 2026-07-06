// 更新通知组件：监听主进程推送的更新状态，通过 Ant Design 反馈给用户。
// 职责：1) 监听 update:status 通道，按状态显示 message/notification/Modal；
//      2) 提供手动检查按钮（固定在右下角，最小化对布局的影响）。
// 由 App.tsx 在根节点引入，整个应用生命周期常驻。
import { useEffect, useRef } from 'react';
import { Button, message, notification, Modal } from 'antd';

/**
 * 主进程推送的更新状态载荷。
 * 与 main/services/UpdateService.ts 中 UpdateStatusPayload 保持一致；
 * 此处重复定义以避免渲染进程跨进程导入主进程模块（含 electron-updater 依赖）。
 */
interface UpdateStatusPayload {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  data?: {
    version?: string;
    percent?: number;
    transferred?: number;
    total?: number;
    error?: string;
  };
}

/** 下载进度通知固定 key，复用同一实例刷新进度，避免反复弹出 */
const PROGRESS_KEY = 'update-download-progress';

/**
 * 弹出安装确认对话框，用户确认后退出应用并安装。
 * 独立为模块级函数：不依赖组件状态，仅调用 window.api 与 Modal。
 */
function showInstallConfirm(): void {
  Modal.confirm({
    title: '更新就绪',
    content: '更新已下载完成，是否立即重启并安装？',
    okText: '立即重启安装',
    cancelText: '稍后',
    maskClosable: false,
    onOk: async () => {
      await window.api.update.installUpdate();
      // quitAndInstaller 会退出应用，正常不会执行到这里
    },
  });
}

export default function UpdateNotifier() {
  // 使用 hook 形式获取 notification api，支持按 key 销毁单条通知
  // （antd v5 静态 notification 无 close/destroy(key) 方法）
  const [notificationApi, notificationContextHolder] = notification.useNotification();
  // 标记当前检查是否由用户手动触发；not-available 时仅手动检查才提示
  const manualCheckRef = useRef(false);
  // 防止 update-downloaded 事件多次触发确认框
  const downloadedHandledRef = useRef(false);
  // 持有 notificationApi 的最新引用，供 effect 内部使用而不触发重注册
  const notificationApiRef = useRef(notificationApi);
  notificationApiRef.current = notificationApi;

  useEffect(() => {
    /** 处理主进程推送的更新状态 */
    const handleStatus = (payload: UpdateStatusPayload): void => {
      const api = notificationApiRef.current;
      switch (payload.status) {
        case 'checking':
          // 检查中不打扰用户
          break;

        case 'available':
          message.info(`发现新版本 v${payload.data?.version ?? '未知'}，开始下载...`);
          manualCheckRef.current = false;
          downloadedHandledRef.current = false;
          break;

        case 'not-available':
          // 仅手动检查时提示，避免启动时自动检查打扰用户
          if (manualCheckRef.current) {
            message.success('当前已是最新版本');
          }
          manualCheckRef.current = false;
          break;

        case 'downloading': {
          const percent = Math.round(payload.data?.percent ?? 0);
          // 复用同一 key 刷新通知，避免反复弹出
          api.info({
            key: PROGRESS_KEY,
            message: '正在下载更新',
            description: `进度：${percent}%`,
            duration: 0,
          });
          break;
        }

        case 'downloaded':
          api.destroy(PROGRESS_KEY);
          if (!downloadedHandledRef.current) {
            downloadedHandledRef.current = true;
            showInstallConfirm();
          }
          break;

        case 'error':
          api.destroy(PROGRESS_KEY);
          message.error(`更新失败：${payload.data?.error ?? '未知错误'}`);
          manualCheckRef.current = false;
          break;
      }
    };

    // preload 的 onUpdateStatus 回调签名是 (status: string) => void，
    // 但运行时主进程通过 webContents.send 发送的是结构化对象，这里做类型还原
    window.api.update.onUpdateStatus((raw: string) => {
      handleStatus(raw as unknown as UpdateStatusPayload);
    });
    // preload 未提供取消监听的方法；本组件常驻根节点不会卸载，无需清理
  }, []);

  /** 手动检查更新按钮点击 */
  const handleManualCheck = async (): Promise<void> => {
    manualCheckRef.current = true;
    const result = await window.api.update.checkManual();
    if (!result.ok) {
      manualCheckRef.current = false;
      // 生产环境错误由 error 事件推送（避免重复提示）；
      // 开发模式下无 error 事件，这里直接提示
      if (result.error?.includes('开发模式')) {
        message.info(result.error);
      }
    }
  };

  return (
    <>
      {/* notification contextHolder 必须渲染，否则 hook 通知不显示 */}
      {notificationContextHolder}
      <Button
        size="small"
        type="text"
        onClick={handleManualCheck}
        style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, opacity: 0.6 }}
      >
        检查更新
      </Button>
    </>
  );
}
