# Tasks

## Phase 0: 项目初始化
- [x] Task 0.1: 创建 Electron + React + TypeScript 项目骨架
  - [x] SubTask 0.1.1: 使用 Vite + React + TypeScript 模板初始化渲染进程目录（src/renderer/）
  - [x] SubTask 0.1.2: 创建 Electron 主进程入口（src/main/main.ts、src/main/preload.ts）
  - [x] SubTask 0.1.3: 配置 electron-builder（electron-builder.yml）打包参数
  - [x] SubTask 0.1.4: 配置 electron-updater（publish 指向 GitHub Releases）
- [x] Task 0.2: 实现五个板块导航框架
  - [x] SubTask 0.2.1: 主布局组件（左侧导航栏 + 右侧 Outlet 内容区，使用 React Router）
  - [x] SubTask 0.2.2: 五个板块占位页面（日程、课程表、考试安排、实验提醒、成绩显示）
- [x] Task 0.3: 搭建主进程 IPC 通信框架
  - [x] SubTask 0.3.1: contextBridge 暴露安全 API（window.api）
  - [x] SubTask 0.3.2: ipcMain/ipcRenderer 通道命名规范（"db:read"、"db:write"、"notify:send" 等）
  - [x] SubTask 0.3.3: 主进程服务层骨架：DataService、NotificationService、ScheduleService、TimetableService、ExamService、LabService、GradeService、UpdateService

## Phase 1: 数据存储与基础设施
- [x] Task 1.1: 设计本地 SQLite 数据库 schema（better-sqlite3）
  - [x] SubTask 1.1.1: 日程表（schedule_items）：id、title、start_time、end_time、reminder_offset、repeat_rule、created_at
  - [x] SubTask 1.1.2: 课程表（courses）：id、name、teacher、location、start_week、end_week、weekday、start_period、end_period、color
  - [x] SubTask 1.1.3: 自定义时间配置（period_config）：period_index、start_time、end_time、break_after、is_lab
  - [x] SubTask 1.1.4: 考试表（exams）：id、course_name、date、start_time、end_time、location、seat、notes
  - [x] SubTask 1.1.5: 实验表（labs）：id、name、date、start_time、end_time、location、instructor、notes
  - [x] SubTask 1.1.6: 成绩表（grades）：id、course_name、semester、credit、grade_point、score、is_degree_course
  - [x] SubTask 1.1.7: GPA 公式表（gpa_formula）：id、formula、is_default
- [x] Task 1.2: 实现 DataService（主进程）
  - [x] SubTask 1.2.1: 初始化 better-sqlite3 连接，定位 app.getPath('userData')
  - [x] SubTask 1.2.2: 为每个数据表实现 CRUD 函数（prepared statements）
  - [x] SubTask 1.2.3: 通过 IPC 暴露给渲染进程（返回普通 JS 对象）
- [x] Task 1.3: 实现数据导入/导出
  - [x] SubTask 1.3.1: 导出：使用 archiver 将 SQLite 文件 + 配置文件打包为 ZIP
  - [x] SubTask 1.3.2: 导入：使用 unzip-stream 解压，校验版本与格式，提示用户覆盖确认
  - [x] SubTask 1.3.3: 渲染进程调用 dialog.showSaveDialog / showOpenDialog 选择路径
- [x] Task 1.4: 实现 Windows 11 通知封装（NotificationService）
  - [x] SubTask 1.4.1: 使用 Electron Notification API（new Notification({ title, body, icon })）
  - [x] SubTask 1.4.2: 主进程封装 sendNotification(title, body, source) IPC 接口
  - [x] SubTask 1.4.3: 免打扰时段设置（electron-store 存储）+ 应用内通知历史

## Phase 2: 日程板块
- [x] Task 2.1: 实现日历视图 React 组件
  - [x] SubTask 2.1.1: 月份切换控件（上一月/下一月/今天）
  - [x] SubTask 2.1.2: 日期网格（7×6），显示日号与日程标记点
  - [x] SubTask 2.1.3: 点击日期切换到该日的日程列表
  - [x] SubTask 2.1.4: 使用 Ant Design Calendar 或自实现网格
- [x] Task 2.2: 实现日程 CRUD 对话框（Ant Design Modal + Form）
  - [x] SubTask 2.2.1: 标题、开始时间、结束时间输入（DatePicker / TimePicker）
  - [x] SubTask 2.2.2: 提醒提前时间选择（InputNumber + 单位 Select）
  - [x] SubTask 2.2.3: 重复规则下拉框（无/每日/每周/每月）
  - [x] SubTask 2.2.4: 保存调用 window.api.schedule.add，删除调用 window.api.schedule.remove
- [x] Task 2.3: 实现日程提醒调度器（主进程）
  - [x] SubTask 2.3.1: setInterval 每分钟检查即将到来的日程
  - [x] SubTask 2.3.2: 计算提醒时间点（日程时间 - 提前时间），命中时调用 NotificationService
  - [x] SubTask 2.3.3: 处理重复规则的下次触发时间生成

## Phase 3: 课程表板块
- [x] Task 3.1: 实现课程表周视图 React 组件
  - [x] SubTask 3.1.1: 7 列网格（周一至周日），左侧节次标尺
  - [x] SubTask 3.1.2: 课程卡片按颜色、节次、周次渲染（参考 Wake Up 课程表样式，CSS Grid）
  - [x] SubTask 3.1.3: 周次切换控件（上一周/下一周/当前周）
- [x] Task 3.2: 实现手动添加/编辑课程对话框（Ant Design Modal + Form）
  - [x] SubTask 3.2.1: 课程名、教师、地点输入
  - [x] SubTask 3.2.2: 起始周、结束周 InputNumber
  - [x] SubTask 3.2.3: 星期几、起始节、结束节选择
  - [x] SubTask 3.2.4: 颜色选择器（预设色板）
- [x] Task 3.3: 实现自定义时间设置对话框
  - [x] SubTask 3.3.1: 每节课起止时间编辑表（第1节至第N节，TimePicker）
  - [x] SubTask 3.3.2: 普通课间休息、大课休息、实验时间配置
  - [x] SubTask 3.3.3: 每节课前提醒提前时间设置
- [x] Task 3.4: 实现嵌入式浏览器（Electron BrowserWindow 子窗口）
  - [x] SubTask 3.4.1: 主进程创建 BrowserWindow（modal: true, webPreferences with preload）
  - [x] SubTask 3.4.2: 渲染进程工具栏：URL 输入框、刷新、后退、"开始识别"按钮
  - [x] SubTask 3.4.3: 通过 webContents.executeJavaScript 提取 DOM（document.body.innerHTML）
- [x] Task 3.5: 实现 DOM 解析器（主进程，使用 cheerio）
  - [x] SubTask 3.5.1: 抽象 ParserBase 接口，支持多种教务系统适配
  - [x] SubTask 3.5.2: 实现常见教务系统（正方、URP、青果等）的选择器规则
  - [x] SubTask 3.5.3: 输出标准化的课程 JSON 列表
- [x] Task 3.6: 集成 tesseract.js OCR
  - [x] SubTask 3.6.1: 通过 webContents.capturePage 截图
  - [x] SubTask 3.6.2: 调用 tesseract.js 识别中文文本（chi_sim 模型）
  - [x] SubTask 3.6.3: 解析 OCR 结果为结构化课程信息
- [x] Task 3.7: 实现 DOM 与 OCR 结果冲突比对 UI
  - [x] SubTask 3.7.1: 比对算法：按时间段匹配课程，高亮差异字段
  - [x] SubTask 3.7.2: 确认对话框：每条差异供用户选择正确版本或手动修改
  - [x] SubTask 3.7.3: 用户确认后批量入库
- [x] Task 3.8: 实现课前提醒调度器（主进程）
  - [x] SubTask 3.8.1: 基于当前周次与节次配置计算下次课程开始时间
  - [x] SubTask 3.8.2: 提前时间到达时调用 NotificationService
  - [x] SubTask 3.8.3: 跨周次、跨学期的调度切换

## Phase 4: 考试安排板块
- [x] Task 4.1: 复用 Phase 3 的嵌入式浏览器组件实现考试安排自动导入
  - [x] SubTask 4.1.1: 适配考试页面的 DOM 解析器
  - [x] SubTask 4.1.2: OCR 二次确认流程复用
- [x] Task 4.2: 实现考试手动添加/编辑对话框（Ant Design Modal + Form）
  - [x] SubTask 4.2.1: 课程名、日期、开始/结束时间、地点、座位号、备注
  - [x] SubTask 4.2.2: 多档提醒设置（如提前1周、3天、1天）
- [x] Task 4.3: 实现考试提醒调度器
  - [x] SubTask 4.3.1: 多档提醒时间计算
  - [x] SubTask 4.3.2: 修改考试时间后重新调度
- [x] Task 4.4: 实现考试列表视图（按日期排序、倒计时显示）

## Phase 5: 实验提醒板块
- [x] Task 5.1: 复用嵌入式浏览器实现实验安排自动导入
- [x] Task 5.2: 实现实验手动添加/编辑对话框（实验名、日期、时间、地点、指导教师、注意事项）
- [x] Task 5.3: 实现实验提醒调度器（同 Task 4.3 逻辑复用）
- [x] Task 5.4: 实现实验列表视图（按日期排序、倒计时显示）

## Phase 6: 成绩显示板块
- [x] Task 6.1: 实现成绩列表 React 视图（按学期分组、Tabs 切换学期）
- [x] Task 6.2: 实现成绩手动添加/编辑对话框
  - [x] SubTask 6.2.1: 课程名、学期（如 2025-2026-1）、学分、绩点、成绩、是否学位课
  - [x] SubTask 6.2.2: 学期下拉框（自动从已有数据生成）
- [x] Task 6.3: 实现 GPA 公式编辑器
  - [x] SubTask 6.3.1: 公式文本框 + 变量说明面板（学分、绩点、Σ）
  - [x] SubTask 6.3.2: 语法校验（使用 expr-eval 表达式引擎）
  - [x] SubTask 6.3.3: 公式保存与多公式管理（默认 + 自定义）
- [x] Task 6.4: 实现 GPA 计算引擎
  - [x] SubTask 6.4.1: 解析用户公式为可执行表达式
  - [x] SubTask 6.4.2: 计算本学期 GPA、总体 GPA、学位课 GPA
  - [x] SubTask 6.4.3: 在成绩视图顶部展示三类 GPA
- [x] Task 6.5: 实现学位课标记管理与展示
  - [x] SubTask 6.5.1: 学位课列单独视图
  - [x] SubTask 6.5.2: 切换学位课标记的快捷操作

## Phase 7: 自动更新（electron-updater）
- [x] Task 7.1: 配置 electron-updater
  - [x] SubTask 7.1.1: 安装 electron-updater 依赖
  - [x] SubTask 7.1.2: 主进程初始化 autoUpdater（feedURL 指向 GitHub Releases）
  - [x] SubTask 7.1.3: electron-builder.yml 配置 publish（GitHub owner/repo/token）
- [x] Task 7.2: 实现更新检查与下载
  - [x] SubTask 7.2.1: 启动时自动检查（autoUpdater.checkForUpdates()）
  - [x] SubTask 7.2.2: 监听 update-downloaded 事件，触发用户提示
  - [x] SubTask 7.2.3: 状态栏显示下载进度（监听 download-progress 事件）
- [x] Task 7.3: 实现安装逻辑
  - [x] SubTask 7.3.1: 用户确认后调用 autoUpdater.quitAndInstall()
  - [x] SubTask 7.3.2: 提供"手动检查更新"入口（设置页面）

## Phase 8: 集成与测试
- [x] Task 8.1: 集成五个板块到主界面，确保导航切换与数据流正确
  - 验证：tsc 严格类型检查通过（renderer + main 双项目 exit 0），vite build 三阶段（renderer + main + preload）全部成功
  - 验证：五个板块页面均已实现（SchedulePage/TimetablePage/ExamPage/LabPage/GradePage），路由配置完整
- [ ] Task 8.2: 端到端测试：教务系统导入课程表 → 课前通知触发的完整流程（需手动运行时验证）
- [ ] Task 8.3: 性能测试：本地数据库查询响应时间 < 100ms、React 列表渲染流畅、通知调度延迟 < 1s（需手动运行时验证）
- [ ] Task 8.4: 数据导入/导出跨设备迁移测试（需手动运行时验证）
- [ ] Task 8.5: 打包测试（electron-builder 生成 Windows 安装包并验证）
  - 状态：electron-builder 启动成功，但下载 electron v30.5.1 win32-x64 二进制（109MB）时网络受限，未完成。构建产物（dist/ + dist-electron/）已就绪，待网络恢复后重试 `npm run package:win`

# Task Dependencies
- Phase 1 依赖 Phase 0
- Phase 2/3/4/5/6 依赖 Phase 1（彼此可并行）
- Task 3.4-3.7 是 Task 4.1 和 Task 5.1 的前置依赖（嵌入式浏览器组件可复用）
- Task 6.3 与 Task 6.4 互相依赖（公式编辑器与计算引擎需协同开发）
- Task 4.3 与 Task 5.3 共享调度逻辑（可抽离 ReminderScheduler 基类）
- Phase 7 依赖 Phase 0（独立模块，可与其他 Phase 并行）
- Phase 8 依赖所有前置 Phase
