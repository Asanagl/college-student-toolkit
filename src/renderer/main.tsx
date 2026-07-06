// React 渲染进程入口
// 职责：挂载根组件、注入 Ant Design 中文 locale、管理主题（跟随系统 + 手动切换）
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import type { ResolvedTheme } from '../shared/types';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到根挂载节点 #root');
}

/**
 * 主题包装组件：监听主进程主题变更，动态切换 Ant Design 算法。
 * 初始主题从 ThemeService 读取（已解析 system 模式为 light/dark），
 * 后续通过 onChange 回调接收系统主题变化或用户手动切换的广播。
 */
function ThemedApp() {
  const [resolved, setResolved] = useState<ResolvedTheme>('light');

  useEffect(() => {
    // 启动时获取当前实际主题
    window.api.theme.getResolved().then((result) => {
      if (result.ok && result.data) {
        setResolved(result.data);
      }
    });
    // 订阅主题变更广播（系统主题切换或用户手动切换均触发）
    window.api.theme.onChange((next) => setResolved(next));
  }, []);

  const algorithm = resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm;

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm }}>
      <App />
    </ConfigProvider>
  );
}

createRoot(container).render(<ThemedApp />);
