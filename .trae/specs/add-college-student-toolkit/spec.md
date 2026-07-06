# 大学生AI工具组 Spec

## Why
当前面向大学生的桌面工具大多功能割裂：课程表、日程、考试、实验、成绩各自为政，且缺少跨设备同步、Windows 原生通知等关键体验。需要一个统一的桌面应用，整合上述板块，并支持教务系统自动导入和本地数据迁移，让大学生在一个应用内完成日常学业管理。

## What Changes
- 新增桌面应用主体（Electron + React + TypeScript 架构），承载五大板块
- 新增日程板块：日历视图 + Windows 11 原生通知
- 新增课程表板块：手动导入 + 嵌入式浏览器自动导入 + OCR 二次确认 + 高度自定义时间
- 新增考试安排板块：与课程表同样的导入逻辑 + 提醒
- 新增实验提醒板块：与考试安排同样的导入逻辑 + 提醒
- 新增成绩板块：手动导入 + 自定义 GPA 公式 + 学位课 GPA
- 新增本地数据存储 + 完整导入/导出（支持跨设备迁移）
- 新增自动更新（electron-updater + GitHub Releases 后台下载 + 启动时安装）
- **BREAKING**: 本项目为全新应用，无向后兼容需求
- **BREAKING**: 应用框架采用 Electron + React + TypeScript（替代原 Qt 6.8 + QML 方案），以优化前端界面体验并提升长期维护性

## Impact
- 受影响的代码: 全新项目，无现有代码冲突
- 依赖项: Electron 30+, React 18, TypeScript 5, Vite 5, Ant Design 5, better-sqlite3, tesseract.js, electron-updater, electron-store, archiver, cheerio, expr-eval
- 目标平台: Windows 11（首要），未来可扩展至 macOS / Linux

## ADDED Requirements

### Requirement: 应用主体架构
应用 SHALL 基于 Electron + React 18 + TypeScript 构建，采用主进程（Node.js 后端逻辑、数据访问、原生 API）+ 渲染进程（React UI）的分层架构，使用 IPC（contextBridge + ipcMain/ipcRenderer）进行进程间通信，主界面包含左侧导航栏 + 右侧内容区。

#### Scenario: 启动应用
- **WHEN** 用户启动应用
- **THEN** 主窗口显示，左侧导航栏展示五个板块入口：日程、课程表、考试安排、实验提醒、成绩显示
- **AND** 启动时通过 electron-updater 检查是否有已下载的更新，若有则提示用户安装

### Requirement: 日程板块 - 日历视图
日程板块 SHALL 提供月历视图，允许用户在日历上点击某天添加日程，已安排日程的日期 SHALL 显示标记。

#### Scenario: 添加日程
- **WHEN** 用户在日历上选择某天并点击"添加日程"
- **THEN** 弹出日程编辑对话框，可填写标题、开始时间、结束时间、提醒提前时间（分钟/小时/天）、重复规则（无/每日/每周/每月）
- **AND** 保存后日程出现在日历对应日期上，并显示标记

#### Scenario: 编辑/删除日程
- **WHEN** 用户点击日历上已有的日程
- **THEN** 弹出编辑对话框，可修改或删除该日程
- **AND** 删除后从日历上移除标记

### Requirement: 日程板块 - Windows 11 通知
日程 SHALL 通过 Windows 11 原生通知中心推送提醒，通知在日程时间 - 用户设定的提前时间到达时触发。

#### Scenario: 日程提醒触发
- **WHEN** 日程的提醒时间到达（日程时间 - 提前时间）
- **THEN** 系统 SHALL 通过 Electron Notification API 推送 Windows 11 原生 toast 通知
- **AND** 通知包含日程标题、开始时间、应用图标
- **AND** 用户可在 Windows 通知中心查看历史提醒

### Requirement: 课程表板块 - 手动导入
课程表 SHALL 支持手动添加课程，每条课程记录包含：课程名、教师、地点、起始周、结束周、星期几、起始节、结束节、颜色。

#### Scenario: 手动添加课程
- **WHEN** 用户点击"添加课程"按钮
- **THEN** 弹出课程编辑对话框，可填写上述所有字段
- **AND** 保存后课程出现在课程表对应位置，按周次显示

### Requirement: 课程表板块 - 自动导入
课程表 SHALL 提供嵌入式浏览器（Electron BrowserWindow 子窗口），用户可在其中登录教务系统、手动导航至课程表页面，应用 SHALL 在用户触发识别时通过 webContents 提取页面 DOM 并解析课程信息，并使用 tesseract.js 对页面截图进行 OCR 二次确认。

#### Scenario: 自动导入流程
- **WHEN** 用户点击"自动导入"按钮
- **THEN** 应用打开嵌入式 BrowserWindow 子窗口
- **WHEN** 用户在浏览器中登录教务系统并导航至课程表页面
- **AND** 用户点击"开始识别"按钮
- **THEN** 应用 SHALL 通过 webContents.executeJavaScript 提取当前页面 DOM
- **AND** 通过 webContents.capturePage 截图并调用 tesseract.js 进行文字识别
- **AND** 将 DOM 解析结果与 OCR 结果进行比对
- **WHEN** DOM 与 OCR 结果存在冲突（如课程名拼写差异）
- **THEN** 应用 SHALL 在确认对话框中高亮差异，供用户手动选择正确版本
- **WHEN** 用户确认后
- **THEN** 课程被批量导入到课程表

### Requirement: 课程表板块 - 高度自定义时间
用户 SHALL 能自定义每节课的起止时间、课间休息长度、大课休息时间、实验安排时间，以及每节课前的提醒提前时间。

#### Scenario: 修改课程时间配置
- **WHEN** 用户进入"时间设置"对话框
- **THEN** 可编辑：
  - 每节课（第1节至第N节）的起始时间和结束时间
  - 普通课间休息长度（分钟）
  - 大课休息时间长度（分钟）
  - 实验节次的时间配置
  - 每节课前的提醒提前时间（分钟）
- **AND** 保存后所有相关通知时间同步更新

### Requirement: 课程表板块 - 课前提醒
应用 SHALL 在每节课开始前根据用户设定的提前时间，通过 Electron Notification API 推送 Windows 11 toast 提醒。

#### Scenario: 课前通知触发
- **WHEN** 当前时间到达"课程开始时间 - 提前时间"
- **THEN** 系统 SHALL 推送 Windows 11 通知
- **AND** 通知包含：课程名、地点、教师、第几节、开始时间

### Requirement: 课程表板块 - 周视图展示
课程表 SHALL 以周视图展示（参考 Wake Up 课程表），7 列对应周一至周日，行对应节次，课程以彩色卡片形式显示。

#### Scenario: 切换周次
- **WHEN** 用户点击"上一周"或"下一周"
- **THEN** 课程表显示对应周次的课程
- **AND** 不在该周次的课程不被显示

### Requirement: 考试安排板块 - 导入
考试安排 SHALL 支持手动导入和自动导入，自动导入逻辑与课程表一致（嵌入式 BrowserWindow + DOM 解析 + OCR 二次确认）。

#### Scenario: 手动添加考试
- **WHEN** 用户点击"添加考试"
- **THEN** 弹出对话框可填写：课程名、考试日期、开始时间、结束时间、地点、座位号、备注
- **AND** 保存后考试出现在考试列表中

#### Scenario: 自动导入考试安排
- **WHEN** 用户使用嵌入式浏览器登录教务系统进入考试安排页面并触发识别
- **THEN** 应用 SHALL 通过 DOM + OCR 提取考试信息并导入

### Requirement: 考试安排板块 - 提醒与修改
应用 SHALL 在考试前根据用户设定的提前时间（可配置多个提醒，如提前1天、3天、1周）推送 Windows 通知，并允许用户修改考试时间。

#### Scenario: 考试多档提醒
- **WHEN** 用户为某场考试设置多个提醒时间（如提前1周、3天、1天）
- **THEN** 系统在每个提醒点分别推送通知

#### Scenario: 修改考试时间
- **WHEN** 用户编辑某条考试记录的时间
- **THEN** 应用 SHALL 更新考试时间，重新计算所有提醒时间点

### Requirement: 实验提醒板块
实验提醒 SHALL 与考试安排使用相同的导入与提醒逻辑，但字段针对实验课：实验名、实验日期、时间、地点、指导教师、注意事项。

#### Scenario: 实验提醒触发
- **WHEN** 实验时间 - 用户设定的提前时间到达
- **THEN** 系统 SHALL 推送 Windows 11 通知，包含实验名、地点、注意事项

#### Scenario: 实验安排自动导入
- **WHEN** 用户使用嵌入式浏览器从教务系统识别实验安排
- **THEN** 应用 SHALL 通过 DOM + OCR 提取并导入

### Requirement: 成绩显示板块 - 手动导入
应用 SHALL 允许用户手动输入每门课程的：课程名、学期、学分、绩点、成绩、是否学位课。

#### Scenario: 添加成绩记录
- **WHEN** 用户点击"添加成绩"
- **THEN** 弹出对话框填写上述字段
- **AND** 保存后成绩列表按学期分组显示

### Requirement: 成绩显示板块 - 自定义 GPA 公式
应用 SHALL 允许用户自定义 GPA 计算公式，公式支持变量（学分、绩点）、运算符（+、-、*、/）、聚合函数（Σ 求和），并提供语法校验。

#### Scenario: 自定义公式
- **WHEN** 用户进入"GPA 公式设置"
- **THEN** 可编辑公式表达式（默认: `Σ(学分×绩点) / Σ学分`）
- **AND** 应用提供公式语法校验，错误时高亮错误位置（使用 expr-eval 表达式引擎）
- **WHEN** 用户保存公式
- **THEN** 系统使用该公式重新计算所有学期 GPA

### Requirement: 成绩显示板块 - GPA 计算
应用 SHALL 基于用户公式计算：本学期 GPA、总体 GPA、学位课 GPA（仅对标记为学位课的课程计算）。

#### Scenario: 本学期 GPA 计算
- **WHEN** 用户查看某学期成绩
- **THEN** 应用显示该学期所有课程的 GPA（按自定义公式计算）
- **AND** 单独显示该学期学位课 GPA

#### Scenario: 学位课 GPA
- **WHEN** 用户已标记某些课程为学位课
- **THEN** 应用 SHALL 单独计算所有学位课的总学分绩点，与总体 GPA 分开展示

### Requirement: 本地数据存储
所有用户数据 SHALL 存储在本地（Electron app.getPath('userData')），不依赖任何远程服务。

#### Scenario: 数据持久化
- **WHEN** 用户创建/修改/删除任何数据（日程、课程、考试、实验、成绩、公式、自定义时间）
- **THEN** 应用 SHALL 立即写入本地 SQLite 数据库（better-sqlite3）
- **AND** 数据库文件位于用户数据目录下

### Requirement: 数据导入/导出
应用 SHALL 提供完整数据的导入和导出功能，便于跨设备迁移。

#### Scenario: 导出数据
- **WHEN** 用户点击"导出数据"
- **THEN** 应用将 SQLite 数据库 + 所有配置打包为单一 ZIP 文件（使用 archiver）
- **AND** 用户可选择保存路径（dialog.showSaveDialog）

#### Scenario: 导入数据
- **WHEN** 用户点击"导入数据"并选择 ZIP 文件（dialog.showOpenDialog）
- **THEN** 应用校验文件格式与版本
- **AND** 提示用户是否覆盖现有数据
- **WHEN** 用户确认
- **THEN** 数据被导入并刷新所有板块

### Requirement: 自动更新
应用 SHALL 通过 electron-updater 检查 GitHub Releases 更新，后台下载安装包，并在下载完成后提示用户安装。

#### Scenario: 检查更新
- **WHEN** 应用启动时（或用户手动触发"检查更新"）
- **THEN** electron-updater 查询 GitHub Releases 获取最新版本
- **AND** 与当前版本号对比
- **WHEN** 存在新版本
- **THEN** electron-updater 在后台自动下载安装包
- **AND** 在状态栏显示下载进度（download-progress 事件）

#### Scenario: 安装更新
- **WHEN** 下载完成（update-downloaded 事件触发）
- **THEN** 应用 SHALL 弹出对话框提示用户重启并安装
- **WHEN** 用户确认
- **THEN** 应用调用 autoUpdater.quitAndInstall() 退出并启动安装程序

### Requirement: Windows 11 通知集成
所有板块的提醒 SHALL 通过 Windows 11 原生通知中心推送，统一使用 Electron Notification API。

#### Scenario: 通知格式
- **WHEN** 任何提醒触发
- **THEN** 通知 SHALL 包含：标题、正文、应用图标、来源板块标识
- **AND** 通知可在 Windows 通知中心查看历史

#### Scenario: 通知免打扰
- **WHEN** 用户在设置中开启"免打扰时段"
- **THEN** 在免打扰时段内的通知 SHALL 被静默，记录到应用内通知历史
- **AND** 免打扰结束后，汇总推送未读通知
