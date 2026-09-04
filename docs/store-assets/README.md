# Store 一览截图

这些 PNG 由 `scripts/capture-store-assets.cjs` 使用本地 unpacked RC 和隔离临时 profile 生成。演示 profile 只写入脱敏的示例课程、日程、考试、实验和成绩，没有读取真实 userData；截图生成完成后临时 profile 已删除。

文件均为 1366×768 的 PNG，当前大小低于 Partner Center 桌面截图的 50 MB 限制：

- `zh-cn-desktop-01-timetable.png`：课程表和课程详情；
- `zh-cn-desktop-02-schedule.png`：月历、日程和提醒；
- `zh-cn-desktop-03-exams.png`：考试安排；
- `zh-cn-desktop-04-grades.png`：成绩和 GPA；
- `zh-cn-desktop-05-settings.png`：关于与更新，显示 Microsoft Store 管理更新；
- `zh-cn-desktop-06-acm-workbench.png`：ACM 临时 IDE（单文件 C++ 编辑/编译运行）；
- `zh-cn-desktop-07-acm-diff.png`：ACM 对拍（标准程序 / 待测程序）；
- `zh-cn-desktop-08-onboarding.png`：首次使用引导（新空 profile 的欢迎页）。

Partner Center 的 Store 一览至少需要一张桌面截图，建议上传课程表、日程、ACM Workbench 和 ACM 对拍；设置页和引导页可作为补充。上传前由发布者确认演示文案、品牌母版、语言和版权信息。截图只是本地 v0.5.0 RC 的 UI 素材，不证明 Store 安装或审核通过。

重新生成：

```powershell
node scripts/capture-store-assets.cjs
```
