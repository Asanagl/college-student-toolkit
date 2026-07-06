// Phase 1 验证脚本：测试 SQLite CRUD 与通知服务
// 此脚本仅在 electron 主进程环境中运行，不打包进生产代码。
//
// 运行方式（项目根目录执行）：
//   1. 编译 TS 为 CJS（external 掉 native 模块与 electron）：
//      npx esbuild scripts/test-phase1.ts --bundle --platform=node --format=cjs ^
//        --external:electron --external:better-sqlite3 --external:electron-store ^
//        --external:archiver --external:unzip-stream --outfile=dist-test/test-phase1.cjs
//   2. 用 electron 运行：
//      npx electron dist-test/test-phase1.cjs
import { app } from 'electron';
import { dataService } from '../src/main/services/DataService';
import { notificationService } from '../src/main/services/NotificationService';

/** 简单断言工具：条件为 false 时抛错，终止测试 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`断言失败: ${message}`);
  }
}

async function runTests(): Promise<void> {
  console.log('\n========== Phase 1 测试开始 ==========\n');

  // ===== 1. 初始化 DataService =====
  console.log('[1] 初始化 DataService...');
  await dataService.init();
  console.log('    DataService 初始化成功');

  // ===== 2. 验证默认数据 =====
  console.log('[2] 验证默认数据...');
  const periods = dataService.periodConfig.getAll();
  console.log(`    节次配置数量: ${periods.length}（期望 12）`);
  assert(periods.length === 12, '应有 12 节默认节次配置');
  console.log(`    第1节: ${periods[0].startTime}-${periods[0].endTime}, breakAfter=${periods[0].breakAfter}`);
  console.log(`    第12节: ${periods[11].startTime}-${periods[11].endTime}, breakAfter=${periods[11].breakAfter}`);
  assert(periods[11].breakAfter === 0, '末节 breakAfter 应为 0');

  const formulas = dataService.formulas.list();
  console.log(`    GPA 公式数量: ${formulas.length}（期望 >= 1）`);
  assert(formulas.length >= 1, '应有默认 GPA 公式');
  const defaultFormula = dataService.formulas.getById('default');
  console.log(`    默认公式: ${defaultFormula ? defaultFormula.name : '未找到'}`);
  assert(defaultFormula !== null, '应存在 id=default 的公式');
  assert(defaultFormula?.isDefault === true, '默认公式 isDefault 应为 true');

  // ===== 3. 测试日程 CRUD（覆盖主路径）=====
  console.log('[3] 测试日程 CRUD...');
  const beforeCount = dataService.schedules.list().length;
  const schedule = dataService.schedules.add({
    title: '测试日程',
    startTime: new Date().toISOString(),
    endTime: new Date(Date.now() + 3600000).toISOString(),
    reminderOffset: 15,
    repeatRule: 'weekly',
  });
  console.log(`    插入日程: id=${schedule.id}, title=${schedule.title}`);
  assert(schedule.id !== '', '插入后应有 id');
  assert(schedule.repeatRule === 'weekly', 'repeatRule 应为 weekly');

  const found = dataService.schedules.getById(schedule.id);
  assert(found !== null, '按 ID 查询应成功');
  console.log(`    查询: reminderOffset=${found?.reminderOffset}, repeatRule=${found?.repeatRule}`);
  assert(found?.reminderOffset === 15, 'reminderOffset 应为 15');

  const updated = dataService.schedules.update(schedule.id, { title: '更新后的日程', reminderOffset: 30 });
  assert(updated?.title === '更新后的日程', '更新后 title 应改变');
  assert(updated?.reminderOffset === 30, '更新后 reminderOffset 应为 30');
  console.log(`    更新: title=${updated?.title}, reminderOffset=${updated?.reminderOffset}`);

  const list = dataService.schedules.list();
  console.log(`    列表数量: ${list.length}（插入前 ${beforeCount}）`);
  assert(list.length === beforeCount + 1, '列表应增加 1 条');

  const removed = dataService.schedules.remove(schedule.id);
  assert(removed === true, '删除应返回 true');
  assert(dataService.schedules.list().length === beforeCount, '删除后应恢复原数量');
  console.log(`    删除成功，列表恢复为 ${beforeCount} 条`);

  // ===== 4. 测试课程 CRUD =====
  console.log('[4] 测试课程 CRUD...');
  const course = dataService.courses.add({
    name: '高等数学',
    teacher: '张老师',
    location: '教学楼A101',
    startWeek: 1,
    endWeek: 16,
    weekday: 1,
    startPeriod: 1,
    endPeriod: 2,
    color: '#4285F4',
  });
  assert(course.color === '#4285F4', 'color 应保留');
  assert(course.startWeek === 1 && course.endWeek === 16, '周次应保留');
  console.log(`    插入课程: ${course.name}, weekday=${course.weekday}, color=${course.color}`);
  assert(dataService.courses.remove(course.id), '删除课程应成功');
  console.log('    删除课程成功');

  // ===== 5. 测试考试 CRUD（含 JSON 数组字段）=====
  console.log('[5] 测试考试 CRUD...');
  const exam = dataService.exams.add({
    courseName: '线性代数',
    date: '2026-07-15',
    startTime: '09:00',
    endTime: '11:00',
    location: '考场3',
    seat: 'A12',
    reminderOffsets: [1440, 60],
  });
  const examFound = dataService.exams.getById(exam.id);
  assert(examFound?.reminderOffsets.length === 2, 'reminderOffsets 应有 2 个元素');
  assert(examFound?.reminderOffsets[0] === 1440, '第一个 offset 应为 1440');
  console.log(`    插入考试: ${exam.courseName}, reminderOffsets=${JSON.stringify(examFound?.reminderOffsets)}`);
  dataService.exams.remove(exam.id);
  console.log('    删除考试成功');

  // ===== 6. 测试实验 CRUD =====
  console.log('[6] 测试实验 CRUD...');
  const lab = dataService.labs.add({
    name: '物理实验',
    date: '2026-07-10',
    startTime: '14:00',
    endTime: '16:00',
    location: '实验室B',
    instructor: '李老师',
    reminderOffsets: [1440],
  });
  assert(dataService.labs.getById(lab.id)?.instructor === '李老师', 'instructor 应保留');
  console.log(`    插入实验: ${lab.name}, instructor=${lab.instructor}`);
  dataService.labs.remove(lab.id);
  console.log('    删除实验成功');

  // ===== 7. 测试成绩 CRUD（含 boolean 字段）=====
  console.log('[7] 测试成绩 CRUD...');
  const grade = dataService.grades.add({
    courseName: '程序设计',
    semester: '2025-2026-1',
    credit: 3,
    gradePoint: 4.0,
    score: 92,
    isDegreeCourse: true,
  });
  const gradeFound = dataService.grades.getById(grade.id);
  assert(gradeFound?.isDegreeCourse === true, 'isDegreeCourse 应为 true');
  assert(gradeFound?.score === 92, 'score 应为 92');
  console.log(`    插入成绩: ${grade.courseName}, isDegreeCourse=${gradeFound?.isDegreeCourse}`);
  dataService.grades.remove(grade.id);
  console.log('    删除成绩成功');

  // ===== 8. 测试通知服务 =====
  console.log('[8] 测试通知服务...');
  await notificationService.init();

  const dndResult = await notificationService.getDnd();
  console.log(
    `    当前 DnD: enabled=${dndResult.data?.enabled}, ${dndResult.data?.startTime}-${dndResult.data?.endTime}`
  );
  assert(dndResult.ok, 'getDnd 应成功');

  // 先清空历史，避免之前残留干扰
  await notificationService.clearHistory();

  const sendResult = await notificationService.send({
    title: 'Phase 1 测试通知',
    body: '如果你看到这条桌面通知，说明 NotificationService 工作正常',
    source: 'system',
  });
  console.log(`    发送通知: ok=${sendResult.ok}, delivered=${sendResult.data}`);
  assert(sendResult.ok, 'send 应返回 ok');

  const history = await notificationService.getHistory();
  console.log(`    通知历史数量: ${history.data?.length}`);
  assert((history.data?.length ?? 0) >= 1, '历史应至少有 1 条');
  assert(history.data?.[0]?.source === 'system', '历史首条 source 应为 system');

  await notificationService.clearHistory();
  const afterClear = await notificationService.getHistory();
  assert((afterClear.data?.length ?? 0) === 0, '清空后历史应为空');
  console.log('    清空历史成功');

  // ===== 9. 测试 DnD 时段拦截 =====
  console.log('[9] 测试 DnD 拦截...');
  // 开启 DnD 并设为当前时段，验证通知被拦截
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const nowStr = `${hh}:${mm}`;
  await notificationService.setDnd({ enabled: true, startTime: nowStr, endTime: nowStr });
  const blocked = await notificationService.send({
    title: '应被拦截的通知',
    body: '此通知不应弹出',
    source: 'system',
  });
  console.log(`    DnD 开启时发送: delivered=${blocked.data}（期望 false）`);
  assert(blocked.data === false, 'DnD 时段内 delivered 应为 false');
  // 恢复 DnD 关闭
  await notificationService.setDnd({ enabled: false, startTime: '22:00', endTime: '08:00' });
  await notificationService.clearHistory();
  console.log('    DnD 已恢复关闭');

  console.log('\n========== Phase 1 测试全部通过 ==========\n');

  await dataService.dispose();
}

// electron 启动后运行测试，完成后退出
app.whenReady().then(async () => {
  try {
    await runTests();
  } catch (err) {
    console.error('\n========== 测试失败 ==========');
    console.error(err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

// 防止打开窗口（测试脚本不需要 UI）
app.on('window-all-closed', () => app.quit());
