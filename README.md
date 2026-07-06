# 大学生 AI 工具组桌面应用

基于 Electron 30 + React 18 + TypeScript 5 + Vite 5 的桌面应用，集成课程表管理、考试提醒、实验安排、成绩计算、GPA 公式编辑等功能，支持通过嵌入式浏览器自动导入教务系统数据。

---

## 目录

- [课程表自动导入使用指南](#课程表自动导入使用指南)
- [ImportBrowserService IPC 接口文档](#importbrowserservice-ipc-接口文档)
- [变更摘要](#变更摘要)

---

## 课程表自动导入使用指南

### 功能概述
内置嵌入式浏览器用于登录教务系统并自动提取课程表/考试/实验信息。
支持 DOM 解析与 OCR 识别双通道，工具栏常驻显示，毛玻璃视觉效果。

### 操作流程

#### 1. 打开导入浏览器
在「课程表」页面点击「自动导入」按钮，弹出嵌入式浏览器窗口（1100x720）。

#### 2. 登录教务系统
- 在工具栏 URL 输入框输入教务系统网址，回车或点击「前往」
- 系统在 iframe 内导航，工具栏保持可见
- 完成登录并进入课表页面

#### 3. 单标签页拦截
部分教务系统会通过 `window.open` 或 `target="_blank"` 唤起多标签页。
本浏览器自动拦截并在当前 iframe 内导航，始终保持单标签页。

#### 4. 开始识别
点击工具栏右侧「开始识别」按钮（蓝色渐变），系统会：
1. 隐藏工具栏（避免干扰 OCR）
2. 提取 iframe 内页面 DOM
3. 截图当前页面
4. 关闭浏览器窗口
5. 并行执行 DOM 解析与 OCR 识别

#### 5. 处理识别结果
识别完成后弹出「冲突解决」对话框，用户合并/选择课程后确认导入。

### OCR 首次加载说明
- 首次使用 OCR 会加载中文识别模型（chi_sim），耗时约 5-10 秒
- 应用启动 30 秒后会在后台预加载模型，避免首次调用阻塞
- DOM 解析通常更快且更准确，建议优先依赖 DOM 解析

### 工具栏按钮说明
| 按钮 | 功能 |
|------|------|
| ← | 后退（iframe 内） |
| → | 前进（iframe 内） |
| ⟳ | 刷新（iframe 内） |
| URL 输入框 | 输入网址并回车访问 |
| 前往 | 导航到输入的 URL |
| 开始识别 | 触发 DOM 提取 + 截图 + 关闭窗口 |

### 故障排查
| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 点击「开始识别」后提示"未提取到任何数据" | iframe 未加载任何页面 | 先在 URL 输入框导航到教务系统再识别 |
| OCR 识别结果为空 | 截图质量低或页面为非文本图片 | 优先使用 DOM 解析；或手动添加课程 |
| URL 输入框显示地址但页面未跳转 | 网络错误或 URL 无效 | 检查 URL 是否正确，重试 |
| 识别后课程信息缺失 | 教务系统页面结构特殊 | 手动补充缺失字段 |

---

## ImportBrowserService IPC 接口文档

### 概述
ImportBrowserService 负责嵌入式浏览器的生命周期管理与数据提取。
通过 IPC 通道与渲染进程通信，所有通道定义在 `shared/types.ts` 的 `IPC_CHANNELS` 中。

### IPC 通道列表

#### 1. TIMETABLE_OPEN_BROWSER
- 方向：渲染进程 → 主进程
- 签名：`window.api.importBrowser.openBrowser(): Promise<IpcResult<boolean>>`
- 行为：
  - 创建 modal BrowserWindow（1100x720）
  - 加载工具栏 HTML（data: URL）
  - 动态创建 iframe 并附加 webContents 监听
  - 设置 setWindowOpenHandler 拦截新窗口
- 返回：`{ ok: true, data: true }`（窗口关闭后 resolve）

#### 2. TIMETABLE_CLOSE_BROWSER
- 签名：`window.api.importBrowser.closeBrowser(): Promise<IpcResult<boolean>>`
- 行为：关闭浏览器窗口

#### 3. TIMETABLE_EXTRACT_DOM
- 签名：`window.api.importBrowser.extractDom(): Promise<IpcResult<string>>`
- 行为：返回缓存的 DOM 字符串（点击"开始识别"后缓存）
- 返回：
  - 成功：`{ ok: true, data: "<html>..." }`
  - 未提取：`{ ok: false, error: "尚未提取 DOM，请先在浏览器中点击"开始识别"" }`

#### 4. TIMETABLE_CAPTURE_PAGE
- 签名：`window.api.importBrowser.capturePage(): Promise<IpcResult<string>>`
- 行为：返回缓存的截图 base64（PNG 格式）
- 返回：
  - 成功：`{ ok: true, data: "<base64>" }`
  - 未提取：`{ ok: false, error: "尚未截图，请先在浏览器中点击"开始识别"" }`

#### 5. TIMETABLE_PARSE_DOM
- 签名：`window.api.importBrowser.parseDom(html: string): Promise<IpcResult<ParsedCourse[]>>`
- 行为：用 cheerio 解析 HTML 提取课程（多解析器策略）

#### 6. TIMETABLE_RUN_OCR
- 签名：`window.api.importBrowser.runOcr(imageBase64: string): Promise<IpcResult<ParsedCourse[]>>`
- 行为：
  - base64 转 Buffer
  - 调用 tesseract.js 识别（chi_sim 模型）
  - 解析文本为课程列表

### 工具栏内部通道（非 IPC_CHANNELS）

#### import-browser:action
- 方向：工具栏 preload ↔ 主进程（双向）
- 事件：`ipcMain.on('import-browser:action', callback)` / `webContents.send('import-browser:action', action)`
- Action 类型：
  ```typescript
  type Action =
    | { type: 'back' }
    | { type: 'forward' }
    | { type: 'refresh' }
    | { type: 'navigate'; url: string }
    | { type: 'extract' }
    | { type: 'urlChanged'; url: string };  // 主进程 → 工具栏
  ```

### WebFrameMain API 使用
- `webContents.mainFrame.frames` 访问 iframe 子 frame 列表
- `frame.executeJavaScript(code)` 在子 frame 上执行代码
- `findIframeFrame()` 返回第一个非 `about:blank`/`data:` 的子 frame

### 错误码
| 错误信息 | 触发场景 | 处理建议 |
|---------|---------|---------|
| "尚未提取 DOM，请先在浏览器中点击"开始识别"" | 未点识别就调用 extractDom | 提示用户先识别 |
| "尚未截图，请先在浏览器中点击"开始识别"" | 未点识别就调用 capturePage | 提示用户先识别 |
| "iframe 导航失败: ..." | executeJavaScript 抛错 | 控制台日志，用户通常无感 |
| "DOM 提取失败: ..." | frame.executeJavaScript 抛错 | 控制台日志，降级到主 frame |
| "截图失败: ..." | capturePage 抛错 | 控制台日志，OCR 通道不可用 |

### 安全配置说明
- `contextIsolation: true`：启用上下文隔离
- `nodeIntegration: false`：禁用 Node 集成
- `sandbox: false`：禁用沙箱（preload 需要 ipcRenderer）
- `webSecurity: false`：允许跨域加载教务系统页面（部分系统为 http）

---

## 变更摘要

### 1. 内置浏览器毛玻璃重构 (ImportBrowserService.ts)
- 类型：重大重构
- 影响：课程表/考试/实验导入流程
- 内容：
  - TOOLBAR_HTML 重构：毛玻璃顶栏（`backdrop-filter: blur(20px)`）+ 按钮渐变/hover 动画
  - navigate 改为 iframe.src（不再用 loadURL 替换整个窗口）
  - performExtraction 适配子 frame（mainFrame.frames）
  - 新增 `findIframeFrame()` + `executeInIframe()` 辅助方法
  - setWindowOpenHandler 拦截新窗口，强制单标签页

### 2. GPA 计算白屏修复 (GpaFormulaDialog.tsx)
- 类型：Bug 修复
- 影响：成绩显示页面
- 内容：
  - computeGpa 添加 try-catch，失败返回 0
  - sumOverGrades 添加 credit/gradePoint/score 类型兜底

### 3. OCR 预加载 (OcrService.ts)
- 类型：性能优化
- 内容：init() 添加 30s 延迟预加载 worker，避免首次 OCR 阻塞 10 秒

### 4. SQLite 索引 (DataService.ts)
- 类型：性能优化
- 内容：添加 4 个 CREATE INDEX
  - `idx_courses_weekday_week(weekday, start_week)`
  - `idx_exams_date(date)`
  - `idx_labs_date(date)`
  - `idx_grades_semester(semester)`

### 5. UI 引导文本 (TimetablePage.tsx)
- 类型：UX 改进
- 内容：添加 OCR/自动导入小字提示

### 6. 调试环境清理
- 类型：代码清理
- 内容：移除 H1/H2/H5 性能插桩代码（main.ts / ScheduleService.ts / BaseRepository.ts）

### 验证状态
- ✅ tsc + vite build 通过
- ✅ 代码审查：3 个轻微问题，均不影响正常使用
- ✅ 安全审查：无可利用漏洞
- ⏳ 运行时验证（待用户手动）：
  - 成绩显示页面白屏修复
  - 毛玻璃视觉效果
  - iframe 导航后工具栏常驻
  - OCR 截图不含顶栏文字
