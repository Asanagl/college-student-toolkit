// React 渲染进程入口
// 职责：挂载根组件、注入 Ant Design 中文 locale、管理主题（跟随系统 + 手动切换）+ 外观（材质/背景图）
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import type { ResolvedTheme, AppearanceConfig } from '../shared/types';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到根挂载节点 #root');
}

/** 可读性遮罩的浓度下限：clarity=100 时也留薄薄一层，否则页面标题直接压在照片上读不清 */
const OVERLAY_MIN_ALPHA = 0.15;
/** 可读性遮罩的浓度浮动区间：clarity 从 100 降到 0，浓度在下限基础上再叠加这么多 */
const OVERLAY_ALPHA_RANGE = 0.6;

/**
 * 构造 antd 主题配置。
 * 启用亚克力或背景图时必须把 Layout 的 bodyBg 置空——antd 默认给 .ant-layout 刷一层
 * 不透明的 colorBgLayout，它会把底层的背景图与原生亚克力整块盖住，功能因此完全看不到效果。
 * 侧栏配色（siderBg）与主色刻意不动，保持既有设计语言。
 */
function buildThemeConfig(resolved: ResolvedTheme, transparent: boolean): ThemeConfig {
  const algorithm = resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm;
  if (!transparent) {
    return { algorithm };
  }
  const dark = resolved === 'dark';
  return {
    algorithm,
    token: {
      colorBgContainer: dark ? 'rgba(20,20,20,0.72)' : 'rgba(255,255,255,0.72)',
      colorBgElevated: dark ? 'rgba(20,20,20,0.85)' : 'rgba(255,255,255,0.85)',
    },
    components: { Layout: { bodyBg: 'transparent' } },
  };
}

/**
 * 把当前主题挂到 body 上。
 * 自定义滚动条的颜色写死在 global.css 里，暗色主题下若不换色几乎看不见；
 * 而主题可被用户手动强制，不能靠 prefers-color-scheme 判断。
 */
function useThemeBodyClass(resolved: ResolvedTheme) {
  useEffect(() => {
    document.body.classList.toggle('theme-dark', resolved === 'dark');
  }, [resolved]);
}

/**
 * 外观层组件：三层固定定位的兄弟节点垫在所有内容之下，自下而上依次是
 * 底色层 / 背景图层（含模糊度与清晰度）/ 可读性遮罩层。
 * 亚克力材质由主进程 setBackgroundMaterial 提供，这里只负责让 body 透明别挡住它。
 */
function AppearanceBackground({
  config,
  resolved,
}: {
  config: AppearanceConfig | null;
  resolved: ResolvedTheme;
}) {
  const { token } = theme.useToken();
  const isAcrylic = config?.material === 'acrylic';

  useEffect(() => {
    // 亚克力模式下让 body 背景透明，透出原生亚克力效果
    if (isAcrylic) {
      document.body.classList.add('acrylic-mode');
    } else {
      document.body.classList.remove('acrylic-mode');
    }
    return () => {
      document.body.classList.remove('acrylic-mode');
    };
  }, [isAcrylic]);

  // 无背景图时不渲染背景层（亚克力模式由 body 透明 + 原生 API 处理）
  if (!config?.backgroundImage) {
    return null;
  }

  const blurRadius = config.blurRadius ?? 0;
  const clarity = config.clarity ?? 100;
  // 遮罩浓度与清晰度反向：clarity 越高遮罩越淡；亮色主题压白、暗色主题压黑
  const alpha = OVERLAY_MIN_ALPHA + (1 - clarity / 100) * OVERLAY_ALPHA_RANGE;
  const overlay =
    resolved === 'dark' ? `rgba(0, 0, 0, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;

  return (
    <>
      {/* 底色层：Layout 已透明，clarity<100 的半透明背景图需要一个跟随主题的不透明底，
          否则会与窗口画布混合，暗色主题下整体发灰。亚克力模式不铺，否则挡住原生材质 */}
      {!isAcrylic && (
        <div className="appearance-base" style={{ background: token.colorBgLayout }} />
      )}
      <div
        className="appearance-background"
        style={{
          backgroundImage: `url("${config.backgroundImage}")`,
          filter: blurRadius > 0 ? `blur(${blurRadius}px)` : undefined,
          // 模糊会采样到元素边界之外，四周会透出底色，故向外扩一圈把虚边推出视口
          inset: blurRadius > 0 ? `${-blurRadius * 2}px` : undefined,
          opacity: clarity / 100,
        }}
      />
      <div className="appearance-overlay" style={{ background: overlay }} />
    </>
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
    let alive = true;
    // 启动时获取当前实际主题
    window.api.theme.getResolved().then((result) => {
      if (alive && result.ok && result.data) {
        setResolved(result.data);
      }
    });
    // 订阅主题变更广播（系统主题切换或用户手动切换均触发）。
    // 根组件目前不会卸载，但仍按契约解绑：一旦启用 StrictMode，
    // effect 会被双调用，不解绑就会立刻叠加出重复监听器
    const off = window.api.theme.onChange((next) => setResolved(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // 启动时获取当前外观配置
    window.api.appearance.get().then((result) => {
      if (alive && result.ok && result.data) {
        setAppearance(result.data);
      }
    });
    // 订阅外观变更广播（材质/背景图/模糊度/清晰度变化均触发）
    const off = window.api.appearance.onChange((next) => setAppearance(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useThemeBodyClass(resolved);

  // 当启用亚克力材质或有背景图时，让 antd 容器背景半透明，让效果透出
  const isTransparent = appearance?.material === 'acrylic' || !!appearance?.backgroundImage;

  return (
    <ConfigProvider locale={zhCN} theme={buildThemeConfig(resolved, isTransparent)}>
      <AppearanceBackground config={appearance} resolved={resolved} />
      <App />
    </ConfigProvider>
  );
}

createRoot(container).render(<ThemedApp />);
