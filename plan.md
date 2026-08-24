# 大学生工具组 `v0.3.0` Microsoft Store/MSIX 可交付版本实施计划

> 发布路线变更记录（2026-08-21）：用户已决定通过 Microsoft Store 分发 MSIX，正式渠道不再以购买 OV Authenticode 证书为前提。本计划保留 NSIS 作为本地 RC/备用构建，但 Store 版本由 Microsoft Store 负责签名、分发和更新。下文凡与 OV 证书、RFC 3161、GitHub Stable 自动更新相关的旧条目，均按本变更说明替换；未完成的 Store 外部验收不得被本地构建结果代替。

> **当前交付修订（2026-08-24，优先于本文件中旧 v14/v15/v18 记录）**：当前本地候选为 `release-v0.3.0-msix-store-v19/college-student-toolkit-0.3.11-x64.msix`，产品版本 `0.3.0`、MSIX Identity Version `0.3.11.0`、大小 `136,149,552` bytes、SHA-256 `047D764C1187669C0CECA578CC00AE6DD9880EC7EAA406D95186B83F5EA2BF6F`。本轮完成提醒休眠补扫/串行重算、OCR 重定向 allowlist、性能报告 required metric 门禁、OCR fixture 可复现修复、编译、封装和静态包核对；受影响提醒/OCR 单元测试及类型检查已通过，完整门禁、实机验收和长性能采样仍未完成。它未签名；当前 Partner Center 草稿页面可见 `0.3.7.0` 和 `0.3.6.0` 包，但没有 v19，原生/扩展文件选择上传仍未成功，最新只能称为“本地 RC / Microsoft Store 提交候选”。最终 Store 审核、`runFullTrust` 审批、资料/定价/IARC 法定确认、实际 Store 安装更新卸载、v0.2 迁移及真实教务导入仍未完成。交付和操作流程以 [`docs/v0.3.0-delivery.md`](docs/v0.3.0-delivery.md) 为准。

> 历史执行记录（2026-08-23）：针对导入浏览器 generation 清理竞态修复重建的正式身份候选为 v14 `release-v0.3.0-msix-store-v14/college-student-toolkit-0.3.6-x64.msix`；该包已在 Partner Center 分析并保存为 `Validated`。它不是当前 v19。2026-08-24 页面同时显示旧 `0.3.6.0` 与 `0.3.7.0` 包，v19 尚未上传；商店资料、`runFullTrust` 审批、认证、审核、公开发布和实机验收仍未完成。

## 一、目标、交付边界与已锁定决策

### 交付目标

把当前“核心功能基本实现、但验证和发布链路未闭环”的 `v0.2.0` 代码，升级为可供普通用户长期使用的 Windows 正式版本。最终版本必须满足：

- Windows 11 x64 普通用户可安装、启动、卸载和覆盖升级，无需预装 Node.js、Python、Visual Studio 或其他开发环境。
- 日程、课程表、考试、实验、成绩/GPA 五个板块的增删改查、持久化和提醒均可正常使用。
- 教务系统 DOM 导入、可选 OCR、冲突解决和批量写入可正常使用。
- 现有 `v0.2.0` 用户数据库和旧备份可以安全迁移，不丢失自定义数据或公式。
- 正式 Windows 交付物通过 Microsoft Store 的 MSIX 渠道提交和分发；Store 的签名、发布者信任和更新事务由 Microsoft Store/Partner Center 管理。
- 应用在 Store 渠道不得启动 `electron-updater`；Store 更新和卸载保留数据行为必须单独验收。
- 自动化测试、覆盖率、性能、安装、升级和真实教务系统验收全部形成可审计记录。

### 已锁定的产品决策

| 项目           | 决策                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------- |
| 目标平台       | Windows 11 x64；验收覆盖 24H2、25H2                                                             |
| 正式版本       | `v0.3.0`；只有 Store 审核通过、实际安装和业务验收完成后才称为 Store Stable                      |
| 当前未提交改动 | 16 个现有改动全部保留，逐项审查、修正、补测试后纳入                                             |
| 数据兼容       | 保留并迁移 `v0.2.0` 数据及 legacy v1 备份                                                       |
| 新备份范围     | 数据库、学期、提醒、通知历史、主题、外观和背景图；排除窗口坐标、缓存、登录会话和 OCR 组件       |
| OCR            | 可选组件；用户在应用内明确触发下载，未安装时 DOM 和手动录入仍可用                               |
| 正式分发       | Microsoft Store MSIX；本地 AppX/MSIX 仅作为包结构和隔离启动验收物                               |
| 更新           | Microsoft Store 管理；NSIS 仅保留 GitHub updater 备用渠道，不与 Store 渠道混用                  |
| Store 身份     | `identityName`、`applicationId`、`publisher` 必须使用 Partner Center 提供的准确值，不在仓库编造 |
| 真实验收       | 由用户本人在 RC 阶段登录真实教务系统；不收集或保存账号密码                                      |
| 发布原则       | 任一 P0/P1、严重代码审查问题或高危安全问题未关闭时，只能保持 RC，不得发布 Stable                |

### 技术选型

| 领域         | 采用方案                                                           | 未采用方案及原因                                                                |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 自动化测试   | Vitest + V8 Coverage + React Testing Library + Playwright Electron | Jest/WebdriverIO 会引入第二套 TS 转换和测试运行链；Spectron 已废弃              |
| ZIP 导入     | `yauzl` 中央目录预检 + `zod` 运行时校验                            | 当前 `unzip-stream.Extract` 会先落盘，难以可靠防御 Zip Slip、重复条目和压缩炸弹 |
| 教务浏览器   | 本地工具栏 BrowserWindow + 隔离的 `WebContentsView`                | 当前跨域 iframe 依赖 `webSecurity:false`、`sandbox:false`，不适合处理真实账号   |
| 原生模块打包 | ASAR + `asarUnpack` 原生 `.node`                                   | 关闭 ASAR 会增加可篡改面和文件碎片，也不能解决 ABI 问题                         |
| Store 发布   | Partner Center MSIX 提交、Store 签名和更新                         | 不购买 OV 证书；本地 unsigned Store-only 包不得直接对外发布                     |
| 背景图片     | 主进程文件选择 + 受限自定义协议读取                                | 不再允许渲染进程提交任意路径，也不通过 CSP 全局开放 `file:`                     |
| OCR 分发     | 固定 GitHub Release 资产 + 应用内双 SHA-256 校验下载               | 不内置模型，不允许启动后静默下载，也不回退第三方 CDN                            |

## 二、实施阶段与关键改动

### 阶段 0：保护现有工作并建立可复现基线

1. 从当前 `main` 创建 `codex/v0.3.0-stable` 分支，完整保留现有 16 个未提交文件；禁止 reset、checkout 或覆盖用户改动。
2. 对现有改动逐文件审查并分类：

   - 监听器取消订阅与共享更新类型。
   - 暗色/亚克力/背景图兼容。
   - 删除二次确认与课程删除入口。
   - 考试、实验防重复提交和导入进度。
   - 课程冲突合并中同槽位多课程丢失修复。
   - CSP、键盘操作和可访问性改动。

3. 先为每项行为增加回归测试，再修复审查发现的问题；通过后将现有工作形成独立基线提交。
4. 保持 `appId`、产品名和用户数据目录不变，避免 Store 安装后创建第二套用户数据；Partner Center identity 与本地应用显示名逐项核对。
5. Store 发布所需的 `identityName`、`applicationId`、`publisher`、产品 ID 和提交状态由用户在 Partner Center 侧确认；仓库和日志不得保存账号密码、Cookie、私钥或访问令牌。未提供准确 identity 时，只允许生成带 `CN=ms` 标记的本地 Store-only 测试包。

### 阶段 1：建立测试、静态检查和 CI 基础

1. 增加统一工程命令：

   - `typecheck`：渲染层和主进程两套 TypeScript 严格检查。
   - `lint`：ESLint、TypeScript、React Hooks、未处理 Promise 和函数长度检查。
   - `format:check`：只检查，不在 CI 自动改写。
   - `test:unit`、`test:coverage`、`test:e2e`、`test:e2e:packaged`。
   - `test:perf`、`test:smoke:package`、`test:smoke:appx`、`verify:appx`。
   - `verify`：PR 必需的完整非发布门禁。

2. 引入 Vitest、`@vitest/coverage-v8`、jsdom、React Testing Library、user-event 和 Playwright Test。
3. 每个测试使用独立临时 `userData`；测试之间不得共享数据库、electron-store、计时器或执行顺序。
4. Electron Notification、dialog、BrowserWindow、autoUpdater、Tesseract、网络和系统时间全部通过 Mock/依赖注入隔离；SQLite 集成测试必须使用真实 `better-sqlite3` 临时库。
5. 建立脱敏 fixture：

   - 正方、URP、青果和通用课程表 HTML。
   - 考试、实验 HTML。
   - OCR 文本和图片。
   - 真实结构但无个人信息的 `v0.2.0` 数据库与 legacy v1 ZIP。
   - 损坏数据库、未来 schema、错误哈希、Zip Slip、重复条目和压缩炸弹负面样本。

6. 将 AGENTS 规范转成真实门禁：生产函数不超过 50 行、输入均有运行时校验、异常均被转换为明确错误、注释解释原因而非复述代码。

### 阶段 2：修复发布阻塞级正确性与安全问题

#### 数据库、GPA 与启动可靠性

1. 修正新库默认 GPA 公式为 `SUM(credit * gradePoint) / SUM(credit)`。
2. 移除或重构当前不会被 IPC 调用且返回空值/抛“Phase 6 未实现”的死 `GradeService`：

   - GPA 计算提取为纯函数模块，渲染层和测试复用。
   - 成绩 CRUD 继续由 Repository 负责。
   - 不保留静默返回空数据的公共方法。

3. `DataService`、迁移器和恢复服务视为关键启动服务：

   - 初始化失败时不得继续展示一个数据功能全部失效的主窗口。
   - 显示恢复错误页或原生错误对话框，提供日志位置和恢复入口。
   - 不得在损坏数据库旁自动创建空库覆盖用户文件。

4. 在应用初始化最前面调用单实例锁；第二实例只聚焦并显示已有窗口，禁止两个进程同时打开 `data.db`。
5. 所有数据库写入保持 prepared statement；表名只允许内部固定常量。

#### IPC 与输入边界

1. 使用 `zod` 为日程、课程、考试、实验、成绩、公式、设置、备份和 OCR IPC 建立运行时 schema。
2. 校验字符串长度、必填字段、ID、周次、节次、日期、时间、提醒偏移、数字范围、base64 长度和对象形状。
3. `preload` 的 API 对象使用 `satisfies RendererApi` 或显式类型，防止共享类型与运行时暴露面漂移。
4. 所有 handler 统一返回 `IpcResult`；禁止 Promise rejection 穿过 bridge。
5. 所有订阅型 API 必须返回取消订阅函数，并在 React effect 清理时调用。
6. 渲染层不允许访问 `ipcRenderer`、Node API、任意文件路径或 `require`。
7. 用户文本按纯文本存储和显示；禁止引入 `dangerouslySetInnerHTML`。React 输出编码之外，再拒绝控制字符和异常超长输入。

#### 教务浏览器安全重构

1. 用 `WebContentsView` 承载远程教务页面；BrowserWindow 主 frame 只加载本地工具栏。
2. 远程 view 固定：

   - `nodeIntegration:false`
   - `contextIsolation:true`
   - `sandbox:true`
   - `webSecurity:true`
   - 不加载 preload
   - 使用关闭即销毁的内存 session partition

3. 只允许 `https:` 和经过用户单次确认的 `http:`；拒绝 `file:`、`javascript:`、`data:`、UNC 和自定义协议。
4. 导航、重定向和 `window.open` 每次都经过同一协议校验；安全 URL 在当前 view 中导航，其余拒绝。
5. 拒绝远程页面的权限申请、下载、本地文件访问和新窗口能力。
6. DOM 提取和截图只保存在主进程内存；导入窗口关闭、取消或完成后立即清除远程 view、session、Cookie 和缓存，已提取结果仅为完成当前导入暂时保留，并在下一次导入或应用退出时清空。
7. 日志不得记录密码、Cookie、完整 DOM、完整截图或查询参数中的敏感值。
8. 真实教务页面必须无法访问主应用 preload、IPC 或本地背景/备份文件。

#### 外观与用户体验缺陷

1. 现有暗色主题、亚克力、背景层、删除确认、重复提交和键盘访问改动全部审查后纳入。
2. 背景图片改为主进程打开文件对话框并完成校验、复制；废弃渲染层读取非标准 `File.path`。
3. 注册只服务于 `userData/backgrounds` 的自定义图片协议；CSP 只开放该协议，不开放全局 `file:`。
4. 继续限制背景图片格式和 10 MiB 大小，并验证文件真实可解析。
5. 修复 Exam/Lab 表格陈旧闭包、课程当前周、所有硬编码浅色以及 IPC listener 泄漏。
6. 清理历史 `dist/win-unpacked`；构建输出目录互相隔离，并恢复可重复的干净构建，禁止陈旧产物混入 release。

### 阶段 3：数据库迁移、完整备份与统一设置

#### 数据库迁移

1. 引入 `DatabaseMigrator` 和 `PRAGMA user_version`：

   - `v0.2.0` 现有库定义为 database schema 1。
   - `v0.3.0` 定义为 database schema 2。
   - 新库直接创建 schema 2。

2. 对 `user_version=0` 的旧库：

   - 无业务表时按新库处理。
   - 有业务表时严格验证 7 张 v0.2 表及必要字段后，才认定为 schema 1。
   - 未知结构、损坏页、视图、触发器、虚拟表或未来 schema 一律拒绝。

3. schema 1→2 在单一事务中完成：

   - 先执行 `integrity_check` 和 `foreign_key_check`。
   - 只修复 `id='default'` 且公式精确等于旧错误字符串的记录。
   - 用户修改过的默认公式及所有自定义公式原样保留。
   - 成功后最后写入 `user_version=2`。

4. 迁移前创建恢复点；失败时回滚事务并恢复旧数据。
5. 将旧 `timetable.json` 中精确等于硬编码 `2025-09-01` 的值迁移为 `null`；其他非默认日期保留。

#### Backup Format v2

新备份固定包含：

- `manifest.json`
- `data/data.db`
- `settings/portable-settings.json`
- 可选 `assets/background.<ext>`

版本维度分离：

- `backupFormatVersion: 2`
- `databaseSchemaVersion: 2`
- `portableSettingsVersion: 1`

便携设置包括：

- 主题模式。
- 学期开始日期。
- DND 配置。
- 最近 100 条通知历史。
- 材质、模糊度、清晰度和背景引用。

明确排除：

- `window-state.json`
- Cookie、登录会话、浏览器缓存和存储。
- 更新缓存。
- OCR 组件。
- 调度器去重状态。
- 原机器绝对路径和 `file://` URL。

安全限制固定为：

- ZIP 最大 256 MiB。
- 解压总量最大 512 MiB。
- 数据库最大 256 MiB。
- 设置 JSON 最大 1 MiB。
- 背景图片最大 10 MiB。
- ZIP 条目最多 16 个。
- 拒绝绝对路径、盘符、UNC、`..`、反斜杠绕过、重复条目、加密 ZIP、符号链接和 CRC 错误。
- v2 中每个文件必须匹配 manifest 大小和 SHA-256。

兼容规则：

- `v0.3.0` 只导出 v2。
- 可以导入 v0.2 legacy v1 和 v0.3 v2。
- v1 只替换业务数据库，保留目标机器当前设置，并在预览中明确提示。
- v2 替换数据库和便携设置；窗口状态保持不变。
- 未知未来格式只读拒绝。
- v0.2 不保证能读取 v2，发布说明明确禁止降级恢复。

#### 两阶段恢复与断电回滚

1. `prepareImport`：

   - 主进程选择文件并复制到受控 staging。
   - 校验 ZIP、manifest、哈希、设置、图片和 SQLite。
   - 在 staging 数据库中先完成迁移。
   - 返回版本、七表记录数、设置/背景范围、警告和一次性 token。
   - 不修改当前数据。

2. `commitImport(token)`：

   - token 与发起窗口绑定、一次性使用、15 分钟过期。
   - 创建 `last-known-good` 恢复点。
   - 暂停四类提醒和全部写 IPC。
   - 原子替换数据库、设置和背景资产。
   - 重载服务、运行烟测并广播恢复完成事件。
   - 成功后才删除 staging。

3. `cancelImport(token)` 删除 staging，不修改当前状态。
4. 写入原子 `import-journal.json`，状态为 `prepared`、`applying`、`committed`。
5. 应用启动时先检查 journal：

   - 未完成应用阶段自动恢复 last-known-good。
   - 当前状态和恢复点都损坏时进入只读恢复页。
   - 禁止创建空库继续运行。

6. 备份为未加密 ZIP；UI 明确说明其中含课程、考试和成绩等个人数据，但不含密码或教务 Cookie。

#### 统一设置 UI

把现有外观弹窗升级为统一设置弹窗，包含六个 Tab：

1. **课程与学期**：设置学期起始日期；未设置时暂停课程提醒并显示提示，设置后自动定位当前周。
2. **通知**：DND 开关/时段、通知历史、清空历史；起止相同明确表示全天静默。
3. **外观**：复用材质、背景、模糊度、清晰度。
4. **OCR 识别组件**：状态、下载、取消、重试、删除、版本和占用空间。
5. **数据与备份**：完整导出、导入预检、覆盖确认、恢复阶段进度和错误恢复。
6. **关于与更新**：当前版本、手动检查更新、下载状态、发布者和隐私/日志说明。

成绩页现有“导出数据”入口移入统一设置，不保留两套导出语义。

### 阶段 4：提醒调度、通知语义与可选 OCR

#### 提醒调度器

1. 将四个独立的每分钟轮询整合为可注入 `Clock/Timer` 的统一 `ReminderScheduler`。
2. 根据当前数据计算最近到期提醒，使用精确定时器触发；只安排未来 24 小时内的事件，并每天安全重算。
3. 以下事件立即重算：

   - 日程、课程、考试、实验增删改。
   - 节次和学期日期修改。
   - 应用启动、系统唤醒和系统时间变化。
   - 数据恢复完成。

4. 增加低频安全扫描，防止系统休眠、定时器漂移或时钟调整造成漏提醒。
5. 去重键包含业务类型、记录 ID、发生时间和提醒偏移；持久化到独立 `reminder-state.json`，保留 30 天并定期清理。
6. `reminder-state.json` 不进入跨设备备份。
7. 每个提醒点只能触发一次；应用重启、恢复和重复 tick 不得重复通知。
8. DND 期间继续记录通知；DND 结束或用户关闭 DND 时发送一条汇总通知，并将对应记录标为已汇总。
9. 调度性能门禁：计划时间到 `Notification.show()` p95 小于 1 秒、最大值小于 1.5 秒。

#### OCR 可选组件

1. 删除启动 30 秒后的自动 worker 预加载；未安装组件时应用不得访问模型 CDN。
2. DOM 解析始终独立可用。缺少 OCR 时用户可以：

   - 继续仅使用 DOM。
   - 手动录入。
   - 明确选择下载 OCR 后重试。

3. OCR 组件固定为 `ocr-chi-sim` 版本 `1.0.0`，来源为固定 GitHub `v0.3.0` Release 资产。
4. 内置 manifest 包含组件版本、兼容引擎范围、资产 URL、压缩/解压大小、许可证和双 SHA-256。
5. 下载流程：

   - 只允许 manifest 中固定的 HTTPS URL和受限 GitHub 重定向目标。
   - 最大响应体按 manifest 大小上浮固定容差限制。
   - 下载到随机 `.partial`。
   - 边下载边验证压缩包 SHA-256。
   - 解压后再次验证大小和 SHA-256。
   - 两次通过后原子安装；失败删除临时文件并保留旧版本。
   - 只允许一个并发下载，支持取消、重试和删除。

6. 模型安装到 `userData/components/ocr-chi-sim/1.0.0/`；Tesseract 显式使用本地 `langPath/cachePath`，严禁缺失时回退默认 CDN。
7. 模型未安装返回 `OCR_COMPONENT_MISSING`；模型损坏返回 `OCR_COMPONENT_INVALID`。
8. OCR 组件不进入数据备份；卸载默认保留 userData，因此组件随用户数据保留，用户可在设置中主动删除。
9. 验收模型固定哈希：

   - 压缩文件 SHA-256：`037B9E59AB3598EF6E892E1DC9AB7D34AE993B555C7296B9E08A2F0675648A9E`
   - 解压模型 SHA-256：`9784F7C917C546424B690FCDE708CE1F604A4393D08BB51DDAB146D7D7C794E6`

   > 哈希校正记录（2026-08-23）：原草案中的 `B8A23F10C7DE500891EB458A8ADC9CC58AB7F242F08B7D149F5E9AEA4AD5DB7C` 没有对应的本地文件、Git 历史或 GitHub Release 资产；对同一明文模型使用 Node.js zlib level 9 生成的可重现资产大小仍为 `1,710,883` bytes，实际 SHA-256 为上面的值。发布时必须使用 manifest、Release 资产和 `SHA256SUMS` 的同一组值。

## 三、公共接口与类型变更

### 通用结果

`IpcResult<T>` 增加可选 `errorCode`。至少定义：

- `VALIDATION_FAILED`
- `BACKUP_BUSY`
- `BACKUP_INVALID`
- `BACKUP_CORRUPT`
- `BACKUP_TOO_NEW`
- `BACKUP_EXPIRED`
- `RESTORE_FAILED_ROLLED_BACK`
- `RESTORE_FAILED_RECOVERY_REQUIRED`
- `OCR_COMPONENT_MISSING`
- `OCR_COMPONENT_INVALID`
- `OCR_DOWNLOAD_FAILED`
- `CRITICAL_SERVICE_UNAVAILABLE`
- `UPDATE_MANAGED_BY_STORE`

### 数据与设置类型

新增：

- `BackupInspection`
- `BackupExportResult`
- `BackupImportResult`
- `BackupErrorCode`
- `TimetablePreferences { semesterStart: string | null }`
- `PortableSettings`
- `UpdateStatusPayload`，以当前未提交共享定义为唯一真源

### OCR 类型

新增：

- `OcrComponentState = 'not-installed' | 'downloading' | 'ready' | 'invalid' | 'error'`
- `OcrComponentStatus`：组件版本、当前/总字节、进度、状态和错误。
- `OcrComponentManifest`

### Renderer API

用以下接口替换渲染层传递任意路径的旧数据 API：

- `data.exportBackup()`
- `data.prepareImport()`
- `data.commitImport(token)`
- `data.cancelImport(token)`
- `data.onRestoreCompleted(callback)`

新增：

- `timetable.getPreferences()`
- `timetable.setSemesterStart(value)`
- `ocrComponent.getStatus()`
- `ocrComponent.install()`
- `ocrComponent.cancelInstall()`
- `ocrComponent.remove()`
- `ocrComponent.onStatusChange(callback)`
- `appearance.chooseBackground()`
- `update.getCurrentVersion()`
- `update.getChannel()`

继续使用并在设置 UI 接通：

- `notify.getDnd/setDnd`
- `notify.getHistory/clearHistory`
- `update.checkManual/installUpdate/onUpdateStatus/getChannel`；Store 渠道只显示 Store 管理提示，不调用 GitHub updater

所有 `on*` 接口都返回取消订阅函数。旧的 `pickExportPath`、`pickImportPath`、接受任意路径的 `data.import/export` 和 `appearance.uploadBackground(filePath)` 从渲染层公开接口移除。

## 四、测试、验证与发布门禁

### 自动化测试

1. **单元测试**

   - 所有课程、考试、实验解析器及 OCR 文本解析。
   - GPA 默认/自定义公式、非法公式、除零、空成绩和非有限数。
   - 七类 Repository、日期/时间、重复日程、周次、DND 和提醒去重。
   - 数据迁移、备份 manifest、ZIP 安全、回滚 journal。
   - 更新状态机和 OCR 下载状态机。
   - 每个模块至少一个负面用例。

2. **组件测试**

   - 五页面 CRUD、加载/空态/错误态。
   - 表单边界、删除确认、防重复提交。
   - 课程周次、冲突选择和多课程槽位。
   - 统一设置六个 Tab。
   - 数据覆盖确认、OCR 下载、更新进度。
   - 超长中文、特殊字符和疑似 XSS 文本。

3. **IPC 契约测试**

   - 每个通道只注册一次。
   - preload 暴露面与 `RendererApi` 一致。
   - 所有输入执行运行时校验。
   - 远程页面无法获得 IPC/Node 权限。
   - 所有失败均返回结构化错误。

4. **数据集成测试**

   - 七表 CRUD、WAL、重启持久化。
   - v0.2 实际 schema 迁移。
   - legacy v1 和 v2 跨 profile 导入。
   - 故障注入、断电 journal 和自动回滚。
   - 设置和背景恢复，窗口状态不迁移。

5. **Playwright Electron E2E**

   - 首启和五个导航。
   - 五板块完整 CRUD 与重启。
   - 本地 fixture 教务站 DOM 导入、window.open、HTTP 确认和冲突合并。
   - 四类提醒、DND 汇总和历史。
   - 备份导出、清空 profile、导入恢复。
   - OCR 未安装、安装、离线使用、损坏重装。
   - 主题、背景、托盘、单实例和更新 UI。

### 覆盖率和静态门禁

- 全项目 branches、lines、functions、statements 均不低于 80%。
- 解析器、调度器、Repository、GPA、备份/迁移、preload/IPC 和 OCR 组件核心模块分支覆盖率不低于 90%。
- PR 合并前核心测试连续运行三次全绿，禁止用自动重跑掩盖 flaky。
- `npm audit --omit=dev` 与 CodeQL 不得有高危或严重漏洞。
- CodeReview 无“严重”问题；SecAudit 无“高危”问题。
- 审查失败触发根因修复和回归审查，最多三轮；仍失败则保持 RC 并人工介入。

### 性能门禁

在 Windows 11 x64、至少 4 核/8 GiB/SSD、Release 构建上，预热 5 次、正式 30 次并记录 p50/p95/max：

- 数据集：1000 日程、500 课程、1000 考试、1000 实验、10000 成绩。
- 常用 SQLite 查询/CRUD p95 `<100ms`。
- IPC CRUD 往返 p95 `<150ms`。
- 页面切换和已有数据首屏 p95 `<300ms`。
- 冷启动到可交互 p95 `<3s`。
- 提醒调用 p95 `<1s`、max `<1.5s`。
- 10 MiB 备份导出和导入各 `<5s`。
- OCR 安装后首次识别 p95 `<15s`，worker 就绪后 `<8s`。
- 空闲 5 分钟 RSS `<300MiB`。
- 30 分钟 soak 后 RSS 增幅 `<10%`，无残留窗口、worker、timer 或 listener。

### Windows 和真实业务验收

在 Windows 11 24H2、25H2，普通用户、zh-CN/en-US、在线/断网、默认路径及含中文/空格路径上验收：

- 干净安装、快捷方式、单实例、托盘、退出、卸载保留数据和重装恢复。
- 打包版 SQLite 新增、查询、重启和删除。
- v0.2 原地覆盖安装至 v0.3，七表、公式、设置和背景完整。
- 两个独立用户 profile 完成 v2 跨设备迁移。
- 通知允许/关闭/专注助手、DND 和通知历史。
- OCR 未安装时启动 60 秒无模型请求；安装后断网仍可识别；取消、截断、错误哈希和篡改均安全失败。
- 用户本人登录真实教务系统，课程、考试、实验各完成一次导入。
- 真实验收不保存凭据、Cookie、完整 DOM 或截图；只保存脱敏记录数和字段核对结果。
- 所有显示记录必须可正确导入或人工修正，不允许静默丢课或写入错误默认值。

## 五、打包、Store 发布、更新和最终交付

### Windows 原生打包

1. 固定 Windows runner 和 Node.js 22 LTS，使用干净 checkout 和 `npm ci`。
2. 执行 `electron-builder install-app-deps --arch=x64`，按锁定的 Electron 版本重建 `better-sqlite3`。
3. 产物门禁必须确认以下文件存在且没有被旧目录污染：

   - `app/resources/app.asar` 中的 renderer、main、preload；
   - `app/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`；
   - AppX/MSIX 所需的 manifest、block map、内容类型和多尺寸图标。

4. 运行 `npm run verify:appx`，确认基础包版本为 `0.3.0.0`；如为 Partner Center 重传候选，则显式设置 `APPX_EXPECTED_VERSION=0.3.11.0`，并确认架构为 x64、显示名和 executable 正确、原生模块为 x64 PE，且 Store 包不含 `app-update.yml`。产品版本仍为 `0.3.0`，Store 身份版本使用三段 `0.3.11` 以生成第四段为零的 `0.3.11.0`。
5. 运行 `npm run test:smoke:appx`，以隔离 `userData` 启动 unpacked AppX 产物，确认 schema 2、七张业务表和默认 GPA 公式；该 smoke 不修改用户数据。
6. `npm run package:win` 只生成 NSIS 本地 RC/备用渠道；它不是 Store 正式交付物，也不得与 Store 更新链路混用。
7. 生成的图标必须覆盖主程序、AppX/MSIX tile、快捷方式、托盘和通知；本仓库已生成可复现的 PNG/ICO/AppX 资源，正式品牌母版仍由用户确认。

### Store 构建与身份

1. 本地无身份测试包使用 `CN=ms`，只用于验证 AppX/MSIX 结构和隔离启动，禁止提交到 Store 或作为正式下载物。
2. 正式构建只能通过 `npm run package:store`，并注入 Partner Center 提供的准确且非敏感的：

   - `APPX_IDENTITY_NAME`；
   - `APPX_APPLICATION_ID`；
   - `APPX_PUBLISHER`；
   - 可选的 `APPX_PUBLISHER_DISPLAY_NAME` 和 `APPX_OUTPUT_DIR`。
   - 重新上传同一产品版本时，必须显式设置三段 `APPX_PACKAGE_VERSION`（当前候选为 `0.3.11`），脚本会生成 `0.3.11.0`；旧的 `APPX_SET_BUILD_NUMBER` / `APPX_BUILD_NUMBER` 会被拒绝。

3. 仓库、日志和构建环境不得保存 Microsoft 账号密码、Cookie、私钥、云签名凭据或 Partner Center 访问令牌。构建脚本缺少 identity 或发现 `CN=ms` 时必须失败。
4. 提交前由 Partner Center 核对包的 Identity Name、Application ID、Publisher、Publisher ID、Package Family Name、架构、版本和显示名；身份不一致时停止提交。
5. Store 的签名、发布者信任、分发和更新由 Microsoft Store/Partner Center 管理。本地 unsigned Store-only 包的验证不能替代 Store 审核、发布或安装证据。

### Store 更新与 `v0.2.0` 首次升级

1. Store 包的 `electronUpdaterAware` 固定为 `false`；Store 渠道启动时不得初始化或调用 `electron-updater`。
2. Store 渠道的设置页和更新通知显示“由 Microsoft Store 管理更新”；手动检查返回 `UPDATE_MANAGED_BY_STORE`，用户应从 Microsoft Store 更新。
3. NSIS/非 Store 包仍可使用 GitHub updater 作为备用渠道，但不生成或携带到 Store 包中，也不应向 Store 用户展示 GitHub 更新入口。
4. `v0.2.0→v0.3.0` 首次升级必须在 Windows 11 x64 实机确认数据库 schema、七张业务表、公式、便携设置和背景资源；正式 Store 安装路径下的 `userData` 位置和保留策略不得仅凭本地 unpacked smoke 推断。
5. 必须验证 Store 安装、Store 更新、卸载后数据保留和重装恢复；降级前先导出 v0.2 原始数据与 legacy v1 备份，v0.2 不保证读取 v2 备份。

### Store Stable 退出标准与交付物

只有以下条件全部满足，才可以把版本称为 Microsoft Store `v0.3.0 Stable`：

- 所有 P0、P1 缺陷关闭；代码审查无严重问题，安全审计无高危问题。
- 总体覆盖率达到 ≥80%，核心模块分支覆盖率达到 ≥90%；自动 E2E、性能、30 分钟 soak、打包 smoke 全部通过。
- Windows 11 24H2/25H2 的干净安装、启动、覆盖升级、卸载保留数据和重装恢复通过。
- `v0.2.0` 数据升级、legacy v1/v2 备份迁移和 packaged CRUD 通过。
- 用户本人在不保存凭据的前提下完成真实教务系统课程、考试、实验导入；日志、fixture、构建产物中不存在凭据、Cookie 或完整教务数据。
- Partner Center identity 与包 manifest 精确匹配，Store 提交已通过审核并处于已发布状态。
- 从 Store 页面实际安装并启动，Store 更新完成一次，更新渠道显示正确，卸载保留数据行为已记录。
- OCR 最终 Release 资产、双 hash、离线识别和取消/损坏回归通过。

最终交付应包括：

- Microsoft Store 页面 URL、Product ID、Partner Center 包身份和提交/发布记录；
- Store 下载的正式 MSIX 安装与验证记录；
- 测试、覆盖率、性能、安装、迁移、安全和真实业务验收报告；
- OCR 组件 manifest、最终资产 hash 和许可证说明；
- CycloneDX SBOM、用户指南、数据备份/恢复指南、发布说明和已知限制；
- NSIS x64 本地 RC（如需备用渠道），明确标注其不属于 Store Stable。

### 主要风险与缓解

- **Store identity 或包身份不匹配**：只使用 Partner Center 导出的准确值，构建前后比较 manifest，禁止用本地 identity 冒充正式包。
- **Store 审核、发布或更新链路未完成**：保持 RC，记录提交状态、审核结果、页面 URL 和实际安装证据，不以本地构建代替外部证据。
- **数据库与多个 electron-store 不能组成单一事务**：使用同卷 staging、last-known-good 和启动恢复 journal。
- **原生模块 ABI 漂移**：每次 Electron 或 better-sqlite3 变化都在干净环境重建并执行 AppX/MSIX smoke。
- **远程教务页面攻击主应用**：WebContentsView、临时 partition、协议限制、沙箱、权限拒绝和凭据零日志。
- **OCR 供应链或网络失败**：不可变 URL、双 hash、原子安装；失败不影响 DOM 和手动流程。
- **备份含个人学习数据且未加密**：明确告知用户、排除凭据和 Cookie；加密备份不纳入 v0.3.0。
