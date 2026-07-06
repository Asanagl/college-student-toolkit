// 课程表板块页面：周视图 + 工具栏 + 课程/时间设置对话框 + 自动导入流程。
// 职责：管理课程数据、节次配置、当前周次、对话框状态，向下分发数据与回调。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Space, Spin, Typography, message } from 'antd';
import {
  PlusOutlined,
  SettingOutlined,
  ImportOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { Course, ParsedCourse, PeriodConfig, Weekday } from '../../shared/types';
import WeekView from '../components/timetable/WeekView';
import CourseDialog from '../components/timetable/CourseDialog';
import TimeSettingsDialog from '../components/timetable/TimeSettingsDialog';
import ConflictResolver from '../components/timetable/ConflictResolver';

const { Title, Text } = Typography;

// 预设色板：导入课程未带颜色时按顺序分配
const DEFAULT_COLORS = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9C27B0', '#00BCD4', '#FF9800', '#795548'];

export default function TimetablePage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [periods, setPeriods] = useState<PeriodConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentWeek, setCurrentWeek] = useState(1);

  // 对话框状态
  const [courseDialogOpen, setCourseDialogOpen] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  // 点击空白新增时预填的 weekday/period
  const [addPreset, setAddPreset] = useState<{ weekday: Weekday; period: number } | null>(null);
  const [timeDialogOpen, setTimeDialogOpen] = useState(false);

  // 自动导入流程状态
  const [importing, setImporting] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [domCourses, setDomCourses] = useState<ParsedCourse[]>([]);
  const [ocrCourses, setOcrCourses] = useState<ParsedCourse[]>([]);

  // 拉取课程列表
  const loadCourses = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.api.timetable.list();
      if (res.ok && res.data) {
        setCourses(res.data);
      } else {
        message.error(res.error ?? '加载课程失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // 拉取节次配置
  const loadPeriods = useCallback(async () => {
    const res = await window.api.periodConfig.get();
    if (res.ok && res.data) {
      setPeriods(res.data);
    }
  }, []);

  useEffect(() => {
    loadCourses();
    loadPeriods();
  }, [loadCourses, loadPeriods]);

  // 默认当前周次：基于学期开始日期简化为 1（首启）
  useEffect(() => {
    if (currentWeek === 1 && courses.length > 0) {
      // 取所有课程的最大 endWeek 作为参考上界
      const maxWeek = courses.reduce((m, c) => Math.max(m, c.endWeek), 1);
      if (currentWeek > maxWeek) setCurrentWeek(Math.max(1, maxWeek));
    }
  }, [courses, currentWeek]);

  const periodCount = useMemo(() => periods.length || 12, [periods]);

  // ===== 课程 CRUD =====
  const handleAddCourse = (weekday: Weekday, period: number) => {
    setEditingCourse(null);
    setAddPreset({ weekday, period });
    setCourseDialogOpen(true);
  };

  const handleEditCourse = (c: Course) => {
    setEditingCourse(c);
    setAddPreset(null);
    setCourseDialogOpen(true);
  };

  const handleAddButtonClick = () => {
    setEditingCourse(null);
    setAddPreset(null);
    setCourseDialogOpen(true);
  };

  const handleCourseDialogOk = async (data: Omit<Course, 'id' | 'createdAt' | 'updatedAt'>) => {
    // 若点击空白新增，沿用预设的 weekday/period
    const payload = addPreset
      ? {
          ...data,
          weekday: addPreset.weekday,
          startPeriod: addPreset.period,
          endPeriod: Math.max(data.endPeriod, addPreset.period),
        }
      : data;

    if (editingCourse) {
      const res = await window.api.timetable.update(editingCourse.id, payload);
      if (!res.ok) {
        message.error(res.error ?? '更新失败');
        return;
      }
      message.success('已更新课程');
    } else {
      const res = await window.api.timetable.add(payload);
      if (!res.ok) {
        message.error(res.error ?? '添加失败');
        return;
      }
      message.success('已添加课程');
    }
    setCourseDialogOpen(false);
    setEditingCourse(null);
    setAddPreset(null);
    loadCourses();
  };

  // ===== 自动导入流程 =====
  const handleImport = async () => {
    setImporting(true);
    try {
      // 1. 打开嵌入式浏览器；promise 在用户关闭子窗口后 resolve
      const openRes = await window.api.importBrowser.openBrowser();
      if (!openRes.ok) {
        message.error(openRes.error ?? '打开浏览器失败');
        return;
      }
      // 2. 用户已点击"开始识别"或手动关闭；提取 DOM 与截图
      const [domRes, imgRes] = await Promise.all([
        window.api.importBrowser.extractDom(),
        window.api.importBrowser.capturePage(),
      ]);
      if (!domRes.ok && !imgRes.ok) {
        message.error('未提取到任何数据，请重新尝试');
        return;
      }
      // 3. 并行解析 DOM 与 OCR
      const tasks: Promise<{ dom?: ParsedCourse[]; ocr?: ParsedCourse[] }> = (async () => {
        let dom: ParsedCourse[] | undefined;
        let ocr: ParsedCourse[] | undefined;
        if (domRes.ok && domRes.data) {
          const parseRes = await window.api.importBrowser.parseDom(domRes.data);
          if (parseRes.ok && parseRes.data) dom = parseRes.data;
        }
        if (imgRes.ok && imgRes.data) {
          const ocrRes = await window.api.importBrowser.runOcr(imgRes.data);
          if (ocrRes.ok && ocrRes.data) ocr = ocrRes.data;
        }
        return { dom, ocr };
      })();
      const { dom, ocr } = await tasks;
      if ((!dom || dom.length === 0) && (!ocr || ocr.length === 0)) {
        message.warning('未能识别出课程，请确认课表页面已加载');
        return;
      }
      setDomCourses(dom ?? []);
      setOcrCourses(ocr ?? []);
      setConflictOpen(true);
    } catch (err) {
      message.error(`导入失败: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleConflictConfirm = async (merged: ParsedCourse[]) => {
    let success = 0;
    for (let i = 0; i < merged.length; i++) {
      const c = merged[i];
      // 必填字段兜底：缺失则用默认值
      const payload = {
        name: c.name ?? `未命名课程${i + 1}`,
        teacher: c.teacher,
        location: c.location,
        startWeek: c.startWeek ?? 1,
        endWeek: c.endWeek ?? 16,
        weekday: (c.weekday ?? 1) as Weekday,
        startPeriod: c.startPeriod ?? 1,
        endPeriod: c.endPeriod ?? c.startPeriod ?? 1,
        color: c.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      };
      const res = await window.api.timetable.add(payload);
      if (res.ok) success++;
    }
    message.success(`已导入 ${success}/${merged.length} 门课程`);
    setConflictOpen(false);
    loadCourses();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部工具栏 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          课程表
        </Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { loadCourses(); loadPeriods(); }}>
            刷新
          </Button>
          <Button icon={<PlusOutlined />} onClick={handleAddButtonClick}>
            添加课程
          </Button>
          <Button icon={<SettingOutlined />} onClick={() => setTimeDialogOpen(true)}>
            时间设置
          </Button>
          <Button type="primary" icon={<ImportOutlined />} loading={importing} onClick={handleImport}>
            自动导入
          </Button>
        </Space>
      </div>

      {/* 自动导入与 OCR 引导提示 */}
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          提示：点击「自动导入」将打开嵌入式浏览器，登录教务系统并进入课表页面后关闭子窗口，系统会自动提取课程信息。
          OCR 识别首次运行需加载中文模型（约 5-10 秒），请耐心等待；DOM 解析通常更快且更准确。
        </Text>
      </div>

      <Spin spinning={loading}>
        <Card styles={{ body: { padding: 12 } }}>
          <WeekView
            courses={courses}
            currentWeek={currentWeek}
            onWeekChange={setCurrentWeek}
            onEdit={handleEditCourse}
            onAdd={handleAddCourse}
            periodCount={periodCount}
          />
        </Card>
      </Spin>

      <CourseDialog
        open={courseDialogOpen}
        course={editingCourse ?? undefined}
        onOk={handleCourseDialogOk}
        onCancel={() => {
          setCourseDialogOpen(false);
          setEditingCourse(null);
          setAddPreset(null);
        }}
      />

      <TimeSettingsDialog
        open={timeDialogOpen}
        onClose={() => {
          setTimeDialogOpen(false);
          loadPeriods();
        }}
      />

      <ConflictResolver
        open={conflictOpen}
        domCourses={domCourses}
        ocrCourses={ocrCourses}
        onConfirm={handleConflictConfirm}
        onCancel={() => setConflictOpen(false)}
      />
    </div>
  );
}
