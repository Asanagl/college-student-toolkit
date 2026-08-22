# 大学生 AI 工具组

大学生 AI 工具组是一个 Windows 桌面应用，用于管理日程、课程表、考试、实验和成绩/GPA，并支持在用户主动操作后从教务系统导入数据。

当前代码版本为 `0.3.0`。本仓库交付的是可审计的本地 RC：核心实现、19 个测试文件/131 个单元与组件用例、2 个 Electron E2E smoke、x64 AppX/MSIX 结构检查、隔离启动 smoke 和完整 Release 性能门禁已完成。当前正式身份候选为 v13：产品版本 `0.3.0`，Windows MSIX Identity Version `0.3.5.0`，本地验证已通过；Partner Center 包页已完成分析并显示 `Validated`，v13 已保存到 Submission 1。页面仍提示 `runFullTrust` 受限功能需要审批；Submission 1 仍是草稿，属性、IARC 年龄分级、Store 一览、定价/可用性和提交选项尚未补齐，也尚未提交认证或发布。Store 审核/发布、Store 实机安装更新、干净机验收和真实教务系统验收仍需外部证据。因此，本地构建或草稿上传不能被称为 Microsoft Store `v0.3.0 Stable`。

## 功能概览

- 日程、课程表、考试、实验和成绩的增删改查与持久化。
- GPA 默认公式为 `SUM(credit * gradePoint) / SUM(credit)`，公式编辑器只接受受限算术语法和 `SUM(...)` 聚合，不执行任意用户函数。
- 统一设置窗口：课程与学期、通知、外观、OCR 组件、数据与备份、关于与更新六个页签。
- 四类提醒统一调度，支持去重、重启恢复、周期日程和免打扰汇总。
- 教务导入支持 DOM 解析；OCR 是可选组件，用户点击安装后才从固定 Release 资产下载。
- v0.2 数据库迁移、legacy v1 备份导入和 v2 完整备份导入。
- 备份包含学习数据和可迁移设置，但不包含密码、教务 Cookie、登录会话、浏览器缓存、窗口坐标或 OCR 组件。

## 当前交付状态

| 项目                                                        | 状态                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 版本与依赖升级                                              | `0.3.0` 已写入 `package.json` 和锁文件                                                          |
| 本地单元/组件测试、类型检查、Lint、格式检查                 | 已通过（19 文件、131 用例），详见 [`docs/v0.3.0-verification.md`](docs/v0.3.0-verification.md)  |
| Electron 源码与 packaged E2E                                | 已通过（`npm run test:e2e`：2 passed；当前源码 AppX 导入 fixture：1 passed）                    |
| 本地生产构建和包前置 smoke                                  | 已通过                                                                                          |
| 依赖安全审计                                                | `npm audit --omit=dev` 已通过                                                                   |
| Windows Release 性能与 30 分钟 soak                       | 已通过（30 次采样、5 次预热、5 分钟 idle、30 分钟/180 周期 soak）                              |
| 本地 x64 NSIS RC 和 unpacked 启动 smoke                     | 已生成并通过；仅作备用/回归渠道，不是 Store 正式包                                              |
| 本地 x64 MSIX、manifest/native binding 检查和隔离启动 smoke | 已生成并通过；使用 `CN=ms` 测试身份，不可直接提交 Store                                         |
| 本地 `CN=ms` 测试包指纹                                      | `135,688,701` bytes；SHA-256 `36B65CBE8099259EEE37AE2BEF0DB1DE7C8382C17C715D6E81A7D72C3A24D4A8` |
| 当前正式身份 MSIX 提交候选                                 | `release-v0.3.0-msix-store-v13`；Identity Version `0.3.5.0`；`135,698,379` bytes；SHA-256 `ADBB80C6509A58F70F3F83C24301869440A2C69A833787E3C6A61B8745FB34CB`；本地验证通过；运行时/备份产品版本仍为 `0.3.0` |
| Partner Center identity、审核/发布和 Store 页面             | v13 已验证并保存；Submission 1 仍为草稿；`runFullTrust` 审批、商店资料、认证和发布仍未完成 |
| Store 一览演示素材                                          | 已生成 5 张隔离演示截图，见 [`docs/store-assets`](docs/store-assets)；上传前仍需发布者确认文案和品牌素材 |
| Store 实际安装、更新、卸载保留数据和重装恢复                | 未执行，需 Store 发布后在 Windows 实机验收                                                      |
| 真实 OCR Release 资产下载                                   | 本地资产和双哈希已通过；公开 Release 下载验证待完成                                             |
| Windows 11 24H2/25H2 干净机及真实教务系统验收               | 未执行，阻断 Store Stable                                                                       |

完整验收清单见 [`docs/v0.3.0-acceptance-checklist.md`](docs/v0.3.0-acceptance-checklist.md)，用户可见变更见 [`docs/v0.3.0-release-notes.md`](docs/v0.3.0-release-notes.md)。

## Windows 用户

正式 Windows 版本应从 Microsoft Store 页面获取。当前已记录 Product ID `9NV11V5BK23N` 和页面 URL，但 Submission 1 仍是草稿，不能把该页面或本地包当作已发布 Stable 下载。仓库中的 `release-v0.3.0-msix-local` 是 electron-builder 生成的本地 Store-only 测试包，Publisher 为 `CN=ms`，只用于包结构和隔离启动验证，不能直接提交 Store 或交付给普通用户。

正式 Store 包由 Microsoft Store 管理安装、发布者信任、更新和卸载事务，应用内不会启动 `electron-updater`。NSIS 只保留为本地 RC/备用渠道。无论使用哪个渠道，覆盖升级前都应先导出 v0.2 原始数据和 legacy v1 备份；v0.3 的 v2 备份不能由旧版 v0.2 读取。

## 教务导入

导入窗口由本地工具栏和独立远程页面组成：远程页面使用隔离的 `WebContentsView` 和临时内存 session，不与主应用共享 preload、Cookie 或缓存。默认只允许 HTTPS；HTTP 必须由用户针对本次导航明确确认。窗口关闭、取消或完成后会销毁远程 view、session、Cookie 和缓存；为完成当前导入，已提取的 DOM 与截图会暂时留在主进程内存，直到下一次导入或应用退出时清空。

使用流程：

1. 在课程表、考试或实验页面打开“自动导入”。
2. 在导入窗口输入教务系统地址并登录；不要把账号密码写入应用备注或日志。
3. 打开目标课表、考试或实验页面后点击“开始识别”。
4. 优先使用 DOM 解析；如果页面只有图片或 DOM 不完整，可在设置中明确安装 OCR 组件后重试，也可以手动补录。
5. 在冲突解决界面确认记录，再批量写入本地数据库。

OCR 不会在启动后自动下载或预加载模型。固定组件为 `ocr-chi-sim` `1.0.0`，组件不进入备份。manifest 锁定的压缩资产大小为 `1,710,883` bytes，SHA-256 为 `037B9E59AB3598EF6E892E1DC9AB7D34AE993B555C7296B9E08A2F0675648A9E`，解压模型 SHA-256 为 `9784F7C917C546424B690FCDE708CE1F604A4393D08BB51DDAB146D7D7C794E6`。这个压缩资产由 Node.js zlib level 9 可重现生成；原计划草案中的压缩哈希没有对应来源，不能用于发布。真实 GitHub Release 资产创建并下载验证前，不宣称线上 OCR 安装可用。

## 数据、备份与隐私

在“设置 → 数据与备份”中可以导出 v2 ZIP、执行导入预检、确认覆盖并恢复。导入分为预检和提交两个阶段，使用一次性 token、staging 目录和 journal；写入失败时优先自动回滚到最近可用恢复点。

v2 备份包含：

- `data/data.db`：课程、日程、考试、实验、成绩、GPA 公式和节次配置；
- `settings/portable-settings.json`：主题、学期起始日期、免打扰、最近通知历史和外观设置；
- 可选的受限背景图片。

备份是未加密 ZIP，可能包含个人学习数据。请只把它保存或发送给可信对象。备份不会保存密码、教务 Cookie、登录会话、浏览器缓存、机器绝对路径、窗口坐标、更新缓存或 OCR 组件。

## 开发与本地验证

开发环境推荐 Node.js 22 LTS；当前验证机使用 Node.js `v24.16.0`、npm `11.13.0` 和 Electron `30.5.1`。安装依赖并运行门禁：

```powershell
npm ci
npm run verify
```

构建 Electron 资源并运行包前置检查：

```powershell
npm run build:electron
npm run test:smoke:package
npm run test:perf
```

本地 AppX/MSIX 结构和隔离启动检查：

```powershell
npm run package:appx
npm run verify:appx
npm run test:smoke:appx
```

正式 Store 构建必须使用 Partner Center 提供的准确 package identity；这些字段不是账号凭据，不要把密码、Cookie、私钥或访问令牌放入环境以外的文件。由于 Partner Center 不接受非零第四段版本，当前候选使用三段 Store 身份版本 `0.3.5`，由清单生成 `0.3.5.0`；应用运行时和备份 manifest 仍保持产品版本 `0.3.0`：

```powershell
$env:APPX_IDENTITY_NAME = "<Partner Center Name>"
$env:APPX_APPLICATION_ID = "<Partner Center Application ID>"
$env:APPX_PUBLISHER = "<Partner Center Publisher>"
$env:APPX_PUBLISHER_DISPLAY_NAME = "Asanagi"
$env:APPX_PACKAGE_VERSION = "0.3.5"
$env:APPX_OUTPUT_DIR = "release-v0.3.0-msix-store-v13"
npm run package:store
$env:APPX_EXPECTED_VERSION = "0.3.5.0"
npm run verify:appx
npm run test:smoke:appx
```

`APPX_PACKAGE_VERSION` 必须是三段纯数字版本；不要再设置旧的 `APPX_SET_BUILD_NUMBER` 或 `APPX_BUILD_NUMBER`，脚本会主动拒绝它们，因为它们会生成 Partner Center 不接受的非零第四段。构建完成后可清理这些环境变量；不要把它们写入 `.env`、提交记录或日志中的凭据区域。

可选的完整 E2E 入口：

```powershell
npm run test:e2e
npm run test:e2e:packaged
```

当前工作树已生成隔离的 packaged RC 可执行文件，E2E 会自动使用临时 `userData`；本轮源码入口和 packaged 入口均通过。它验证的是本地打包 RC，不代表 Microsoft Store 实际安装、更新或卸载保留数据通过。

Windows 发布环境应在干净 checkout 上执行：

```powershell
npm ci
npx electron-builder install-app-deps --arch=x64
npm run build:electron
npm run package:win
```

打包后必须检查 `better_sqlite3.node` 的 x64 PE、Electron ABI、包版本、无旧版产物混入，以及隔离 profile 中的建库、CRUD、关闭和重开。`verify:appx` 还会拒绝 Store 包中的 `app-update.yml`，因为 Store 渠道由 Microsoft Store 管理更新。正式 Store 交付还必须有 Partner Center identity、审核/发布、实际安装、更新、卸载保留数据和真实业务验收证据；本地 `CN=ms` 包不能替代这些证据。

## 文档

- [`plan.md`](plan.md)：v0.3.0 实施计划、技术决策和 Stable 退出标准。
- [`docs/v0.3.0-verification.md`](docs/v0.3.0-verification.md)：本地验证命令、结果、覆盖率范围和未执行项。
- [`docs/v0.3.0-acceptance-checklist.md`](docs/v0.3.0-acceptance-checklist.md)：发布前逐项验收清单。
- [`docs/v0.3.0-release-notes.md`](docs/v0.3.0-release-notes.md)：用户可见变更、迁移、隐私提示和已知限制。
- [`docs/v0.3.0-store-publishing.md`](docs/v0.3.0-store-publishing.md)：本地 MSIX 验证、Partner Center identity、提交和需要用户介入的 Store 验收流程。
- [`docs/v0.3.0-user-operations.md`](docs/v0.3.0-user-operations.md)：发布者本人需要执行的 Store 发布、实机验收、迁移和真实教务导入流程。
- [`docs/v0.3.0-store-listing-draft.md`](docs/v0.3.0-store-listing-draft.md)：中英文 Store 文案草案，提交前需发布者确认。
- [`docs/v0.3.0-privacy-policy-draft.md`](docs/v0.3.0-privacy-policy-draft.md)：隐私政策草案；替换占位符并公开托管后才能填入 Partner Center。
- [`docs/store-assets/README.md`](docs/store-assets/README.md)：隔离演示截图清单、来源和上传说明。
- [`docs/v0.3.0-sbom.cdx.json`](docs/v0.3.0-sbom.cdx.json)：基于锁文件生成的生产依赖 CycloneDX SBOM。

## 许可证

本项目使用 MIT License。OCR 中文语言数据的许可证随组件和 Release 资产说明提供。
