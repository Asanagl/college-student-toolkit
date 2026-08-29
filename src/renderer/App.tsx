// 根组件
// 职责：配置路由，使用 HashRouter（更适合 Electron 的 file:// 协议，避免刷新 404）
import { createHashRouter, Navigate, RouterProvider } from "react-router-dom";
import MainLayout from "./components/MainLayout";
import SchedulePage from "./pages/SchedulePage";
import TimetablePage from "./pages/TimetablePage";
import ExamPage from "./pages/ExamPage";
import LabPage from "./pages/LabPage";
import GradePage from "./pages/GradePage";
import AcmWorkbenchPage from "./pages/AcmWorkbenchPage";
// Phase 7：更新通知组件，常驻根节点，监听主进程更新状态并提示用户
import UpdateNotifier from "./components/update/UpdateNotifier";

const router = createHashRouter([
  {
    element: (
      <>
        {/* UpdateNotifier 常驻路由树，才能与 Data Router 一起渲染。 */}
        <UpdateNotifier />
        <MainLayout />
      </>
    ),
    children: [
      { path: "/", element: <Navigate to="/schedule" replace /> },
      { path: "/schedule", element: <SchedulePage /> },
      { path: "/timetable", element: <TimetablePage /> },
      { path: "/exam", element: <ExamPage /> },
      { path: "/lab", element: <LabPage /> },
      { path: "/grade", element: <GradePage /> },
      { path: "/acm", element: <AcmWorkbenchPage /> },
      { path: "*", element: <Navigate to="/schedule" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
