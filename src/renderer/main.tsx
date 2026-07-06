// React 渲染进程入口
// 职责：挂载根组件、注入 Ant Design 中文 locale、管理主题（跟随系统 + 手动切换）+ 外观（材质/背景图）
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import type { ResolvedTheme, AppearanceConfig } from '../shared/types';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到根挂载节点 #root');
}

/**
 * 背景图层组件：渲染用户上传的背景图，应用模糊度与清晰度滤镜。
 * 固定定位覆盖整个窗口，z-index: -1 位于所有内容之下。
 * 当材质为 acrylic 时，给 body 添加 .acrylic-mode class 让背景透明。
 */
function AppearanceBackground({ config }: { config: AppearanceConfig | null }) {
  useEffect(() => {
    // 亚克力模式下让 body 背景透明，透出原生亚克力效果
    if (config?.material === 'acrylic') {
      document.body.classList.add('acrylic-mode');
    } else {
      document.body.classList.remove('acrylic-mode');
    }
    return () => {
      document.body.classList.remove('acrylic-mode');
    };
  }, [config?.material]);

  // 无背景图时不渲染背景层（亚克力模式由 body 透明 + 原生 API 处理）
  if (!config?.backgroundImage) {
    return null;
  }

  const blurRadius = config.blurRadius ?? 0;
  const opacity = (config.clarity ?? 100) / 100;

  return (
    <div
      className="appearance-background"
      style={{
        backgroundImage: `url("${config.backgroundImage}")`,
        filter: blurRadius > 0 ? `blur(${blurRadius}px)` : undefined,
        opacity,
      }}
    />
  );
}

/**
 * 主题包装组件：监听主进程主题变更，动态切换 Ant Design 算法。
 * 初始主题从 ThemeService 读取（已解析 system 模式为 light/dark），
 * 后续通过 onChange 回调接收系统主题变化或用户手动切换的广播。
 * 同时管理外观配置，当亚克力或背景图启用时让 antd 容器半透明。
 */
function ThemedApp() {
  const [resolved, setResolved] = useState<ResolvedTheme>('light');
  const [appearance, setAppearance] = useState<AppearanceConfig | null>(null);

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

  useEffect(() => {
    // 启动时获取当前外观配置
    window.api.appearance.get().then((result) => {
      if (result.ok && result.data) {
        setAppearance(result.data);
      }
    });
    // 订阅外观变更广播（材质/背景图/模糊度/清晰度变化均触发）
    window.api.appearance.onChange((next) => setAppearance(next));
  }, []);

  const algorithm = resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm;

  // 当启用亚克力材质或有背景图时，让 antd 容器背景半透明，让效果透出
  const isTransparent = appearance?.material === 'acrylic' || !!appearance?.backgroundImage;
  const tokenOverride = isTransparent
    ? {
        colorBgContainer: resolved === 'dark' ? 'rgba(20,20,20,0.72)' : 'rgba(255,255,255,0.72)',
        colorBgElevated: resolved === 'dark' ? 'rgba(20,20,20,0.85)' : 'rgba(255,255,255,0.85)',
      }
    : {};

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm, token: tokenOverride }}>
      <AppearanceBackground config={appearance} />
      <App />
    </ConfigProvider>
  );
}

createRoot(container).render(<ThemedApp />);
