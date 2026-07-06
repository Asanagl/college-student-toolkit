// 主布局组件
// 职责：左侧可折叠 Sider 导航 + 自定义标题栏 Header（拖拽区 + 主题切换）+ Content 渲染子路由
import { useState, useEffect, useMemo } from 'react';
import { Layout, Menu, theme, Dropdown, Button, Space, type MenuProps } from 'antd';
import {
  CalendarOutlined,
  TableOutlined,
  FileProtectOutlined,
  ExperimentOutlined,
  TrophyOutlined,
  DesktopOutlined,
  BulbOutlined,
  BulbFilled,
  DownOutlined,
  BgColorsOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { ThemeMode } from '../../shared/types';
import AppearanceSettingsModal from './AppearanceSettingsModal';

const { Header, Sider, Content } = Layout;

// 菜单项配置：key 与路由 path 保持一致，便于联动
const MENU_ITEMS = [
  { key: '/schedule', icon: <CalendarOutlined />, label: '日程' },
  { key: '/timetable', icon: <TableOutlined />, label: '课程表' },
  { key: '/exam', icon: <FileProtectOutlined />, label: '考试安排' },
  { key: '/lab', icon: <ExperimentOutlined />, label: '实验提醒' },
  { key: '/grade', icon: <TrophyOutlined />, label: '成绩显示' },
];

/** 主题切换下拉菜单选项 */
const THEME_OPTIONS: MenuProps['items'] = [
  { key: 'system', icon: <DesktopOutlined />, label: '跟随系统' },
  { key: 'light', icon: <BulbOutlined />, label: '亮色模式' },
  { key: 'dark', icon: <BulbFilled />, label: '暗黑模式' },
  { type: 'divider' },
  { key: 'appearance', icon: <BgColorsOutlined />, label: '外观设置' },
];

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  // 启动时从主进程读取已持久化的主题偏好
  useEffect(() => {
    window.api.theme.get().then((result) => {
      if (result.ok && result.data) {
        setThemeMode(result.data);
      }
    });
  }, []);

  // 根据当前路径计算选中的菜单项，避免菜单高亮与路由不同步
  const selectedKey = useMemo(() => {
    const match = MENU_ITEMS.find((item) => location.pathname.startsWith(item.key));
    return match ? match.key : '/schedule';
  }, [location.pathname]);

  const {
    token: { colorBgContainer },
  } = theme.useToken();

  const handleMenuClick = (key: string) => {
    navigate(key);
  };

  const handleThemeChange: MenuProps['onClick'] = ({ key }) => {
    if (key === 'appearance') {
      setAppearanceOpen(true);
      return;
    }
    const mode = key as ThemeMode;
    setThemeMode(mode);
    window.api.theme.set(mode);
  };

  // 标题栏右侧主题切换按钮图标：跟随系统用桌面图标，亮色用空心灯泡，暗黑用实心灯泡
  const themeIcon =
    themeMode === 'system' ? (
      <DesktopOutlined />
    ) : themeMode === 'dark' ? (
      <BulbFilled />
    ) : (
      <BulbOutlined />
    );

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider collapsible breakpoint="lg">
        <div
          style={{
            height: 32,
            margin: 16,
            color: '#fff',
            fontWeight: 600,
            textAlign: 'center',
            lineHeight: '32px',
          }}
        >
          大学生工具组
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => handleMenuClick(key)}
        />
      </Sider>
      <Layout>
        {/* 自定义标题栏：titlebar-drag 使整个 Header 可拖拽移动窗口；
            右侧 padding 留出原生窗口控制按钮（最小化/最大化/关闭）的空间 */}
        <Header
          className="titlebar-drag"
          style={{
            padding: '0 150px 0 24px',
            background: colorBgContainer,
            fontSize: 18,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 40,
            lineHeight: '40px',
          }}
        >
          <span>大学生工具组</span>
          {/* 主题切换按钮：no-drag 排除拖拽，确保可点击 */}
          <Space className="titlebar-no-drag">
            <Dropdown menu={{ items: THEME_OPTIONS, onClick: handleThemeChange }} placement="bottomRight">
              <Button type="text" icon={themeIcon}>
                {themeMode === 'system' ? '跟随系统' : themeMode === 'dark' ? '暗黑' : '亮色'}
                <DownOutlined style={{ fontSize: 10 }} />
              </Button>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ margin: 16, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
      <AppearanceSettingsModal open={appearanceOpen} onClose={() => setAppearanceOpen(false)} />
    </Layout>
  );
}
