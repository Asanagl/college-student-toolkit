// 根组件
// 职责：配置路由，使用 HashRouter（更适合 Electron 的 file:// 协议，避免刷新 404）
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import MainLayout from './components/MainLayout';
import SchedulePage from './pages/SchedulePage';
import TimetablePage from './pages/TimetablePage';
import ExamPage from './pages/ExamPage';
import LabPage from './pages/LabPage';
import GradePage from './pages/GradePage';
// Phase 7：更新通知组件，常驻根节点，监听主进程更新状态并提示用户
import UpdateNotifier from './components/update/UpdateNotifier';

export default function App() {
  return (
    <HashRouter>
      {/* UpdateNotifier 渲染一个固定定位的手动检查按钮，并处理更新状态副作用 */}
      <UpdateNotifier />
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<Navigate to="/schedule" replace />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/timetable" element={<TimetablePage />} />
          <Route path="/exam" element={<ExamPage />} />
          <Route path="/lab" element={<LabPage />} />
          <Route path="/grade" element={<GradePage />} />
          {/* 兜底：未匹配的路由回到日程页 */}
          <Route path="*" element={<Navigate to="/schedule" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
