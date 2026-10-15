// 课程表板块页面：周视图 + 工具栏 + 课程/时间设置对话框 + 自动导入流程。
// 职责：管理课程数据、节次配置、当前周次、对话框状态，向下分发数据与回调。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Modal, Space, Spin, Typography, message } from "antd";
import {
  PlusOutlined,
  SettingOutlined,
  ImportOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type {
  Course,
  Exam,
  Lab,
  ParsedCourse,
  PeriodConfig,
  Schedule,
  Weekday,
} from "../../shared/types";
import {
  coursePairConflict,
  findConflictingCourses,
  findCourseCourseConflicts,
  findCrossBoardConflicts,
} from "../../shared/conflicts";
import WeekView from "../components/timetable/WeekView";
import CourseDialog from "../components/timetable/CourseDialog";
import TimeSettingsDialog from "../components/timetable/TimeSettingsDialog";
import ConflictResolver from "../components/timetable/ConflictResolver";
import { SEMESTER_START_EVENT } from "../services/useConflictData";

const { Title, Text } = Typography;

// 预设色板：导入课程未带颜色时按顺序分配
const DEFAULT_COLORS = [
  "#4285F4",
  "#34A853",
  "#FBBC05",
  "#EA4335",
  "#9C27B0",
  "#00BCD4",
  "#FF9800",
  "#795548",
];

type CompleteParsedCourse = ParsedCourse & {
  name: string;
  startWeek: number;
  endWeek: number;
  weekday: Weekday;
  startPeriod: number;
  endPeriod: number;
};

function hasCompleteCourse(
  course: ParsedCourse,
): course is CompleteParsedCourse {
  return (
    Boolean(course.name?.trim()) &&
    Number.isInteger(course.startWeek) &&
    Number.isInteger(course.endWeek) &&
    Number.isInteger(course.weekday) &&
    Number.isInteger(course.startPeriod) &&
    Number.isInteger(course.endPeriod) &&
    course.startWeek! <= course.endWeek! &&
    course.startPeriod! <= course.endPeriod! &&
    course.weekday! >= 1 &&
    course.weekday! <= 7
  );
}

export default function TimetablePage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [periods, setPeriods] = useState<PeriodConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentWeek, setCurrentWeek] = useState(1);

  // 对话框状态
  const [courseDialogOpen, setCourseDialogOpen] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  // 点击空白新增时预填的 weekday/period
  const [addPreset, setAddPreset] = useState<{
    weekday: Weekday;
    period: number;
  } | null>(null);
  const [timeDialogOpen, setTimeDialogOpen] = useState(false);

  // 自动导入流程状态
  const [importing, setImporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
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
        message.error(res.error ?? "加载课程失败");
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

  // 撞课检测附加数据：学期开始日期 + 跨板块事项（考试/实验/日程）
  const [semesterStart, setSemesterStart] = useState<string | null>(null);
  const [conflictItems, setConflictItems] = useState<{
    exams: Exam[];
    labs: Lab[];
    schedules: Schedule[];
  }>({ exams: [], labs: [], schedules: [] });

  const loadConflictExtras = useCallback(async () => {
    const [prefRes, examRes, labRes, scheduleRes] = await Promise.all([
      window.api.timetable.getPreferences(),
      window.api.exam.list(),
      window.api.lab.list(),
      window.api.schedule.list(),
    ]);
    if (prefRes.ok && prefRes.data) {
      setSemesterStart(prefRes.data.semesterStart);
    }
    setConflictItems({
      exams: examRes.ok && examRes.data ? examRes.data : [],
      labs: labRes.ok && labRes.data ? labRes.data : [],
      schedules: scheduleRes.ok && scheduleRes.data ? scheduleRes.data : [],
    });
  }, []);

  useEffect(() => {
    loadCourses();
    loadPeriods();
    loadConflictExtras();
  }, [loadCourses, loadPeriods, loadConflictExtras]);

  // 设置弹窗挂在 MainLayout 上，修改学期开始日期后本页不会重挂载；
  // SettingsModal 保存成功后广播 SEMESTER_START_EVENT，本页据此重载撞课数据
  useEffect(() => {
    const onChanged = () => void loadConflictExtras();
    window.addEventListener(SEMESTER_START_EVENT, onChanged);
    return () => window.removeEventListener(SEMESTER_START_EVENT, onChanged);
  }, [loadConflictExtras]);

  // 撞课检测：课程互撞按当前周判定；跨板块经学期开始日期换算，
  // semesterStart 未设置时跨板块结果自动为空（页面提示区同步显示降级说明）
  const conflicts = useMemo(() => {
    const map = findCourseCourseConflicts(courses, currentWeek);
    const cross = findCrossBoardConflicts({
      courses,
      semesterStart,
      periods,
      exams: conflictItems.exams,
      labs: conflictItems.labs,
      schedules: conflictItems.schedules,
      week: currentWeek,
    });
    for (const [id, refs] of cross.courses) {
      map.set(id, [...(map.get(id) ?? []), ...refs]);
    }
    return map;
  }, [courses, currentWeek, semesterStart, periods, conflictItems]);

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

  const doSaveCourse = async (
    payload: Omit<Course, "id" | "createdAt" | "updatedAt">,
  ) => {
    if (editingCourse) {
      const res = await window.api.timetable.update(editingCourse.id, payload);
      if (!res.ok) {
        message.error(res.error ?? "更新失败");
        return;
      }
      message.success("已更新课程");
    } else {
      const res = await window.api.timetable.add(payload);
      if (!res.ok) {
        message.error(res.error ?? "添加失败");
        return;
      }
      message.success("已添加课程");
    }
    setCourseDialogOpen(false);
    setEditingCourse(null);
    setAddPreset(null);
    loadCourses();
  };

  // 手动保存无 submitLock 等价物：撞课 confirm 打开期间再次点击「保存」会叠加
  // 第二个 confirm，两个都确认即重复写入；saveLock 在确认链路上全程占位
  const saveLock = useRef(false);

  const handleCourseDialogOk = async (
    data: Omit<Course, "id" | "createdAt" | "updatedAt">,
  ) => {
    if (saveLock.current) return;
    // 若点击空白新增，沿用预设的 weekday/period
    const payload = addPreset
      ? {
          ...data,
          weekday: addPreset.weekday,
          startPeriod: addPreset.period,
          endPeriod: Math.max(data.endPeriod, addPreset.period),
        }
      : data;

    // 撞课时提示但允许保存（编辑时排除课程自身）
    const others = editingCourse
      ? courses.filter((c) => c.id !== editingCourse.id)
      : courses;
    const hits = findConflictingCourses(payload, others);
    saveLock.current = true;
    if (hits.length === 0) {
      try {
        await doSaveCourse(payload);
      } finally {
        saveLock.current = false;
      }
      return;
    }
    // Modal.confirm 是命令式弹窗：页面路由卸载后弹窗仍存活，onOk 闭包会完成写入；
    // 属可接受行为（写入本身是用户确认过的意图），saveLock 保证不会叠加重复写入
    Modal.confirm({
      title: "检测到撞课",
      content: (
        <div>
          <div>以下课程与其时间重叠：</div>
          <ul>
            {hits.map((c) => (
              <li key={c.id}>
                {c.name}（第 {c.startWeek}–{c.endWeek} 周，周
                {"一二三四五六日"[c.weekday - 1]} 第 {c.startPeriod}–
                {c.endPeriod} 节）
              </li>
            ))}
          </ul>
          <div>仍要保存吗？保存后课程表上会以角标标记撞课。</div>
        </div>
      ),
      okText: "仍然保存",
      cancelText: "返回修改",
      onOk: async () => {
        try {
          await doSaveCourse(payload);
        } finally {
          saveLock.current = false;
        }
      },
      onCancel: () => {
        saveLock.current = false;
      },
    });
  };

  const handleDeleteCourse = async (id: string) => {
    const res = await window.api.timetable.remove(id);
    if (!res.ok) {
      message.error(res.error ?? "删除失败");
      return;
    }
    message.success("已删除课程");
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
        message.error(openRes.error ?? "打开浏览器失败");
        return;
      }
      // 2. 用户已点击"开始识别"或手动关闭；提取 DOM 与截图
      const [domRes, imgRes] = await Promise.all([
        window.api.importBrowser.extractDom(),
        window.api.importBrowser.capturePage(),
      ]);
      if (!domRes.ok && !imgRes.ok) {
        message.error("未提取到任何数据，请重新尝试");
        return;
      }
      // 3. 并行解析 DOM 与 OCR
      const tasks: Promise<{ dom?: ParsedCourse[]; ocr?: ParsedCourse[] }> =
        (async () => {
          let dom: ParsedCourse[] | undefined;
          let ocr: ParsedCourse[] | undefined;
          if (domRes.ok && domRes.data) {
            const parseRes = await window.api.importBrowser.parseDom(
              domRes.data,
            );
            if (parseRes.ok && parseRes.data) {
              dom = parseRes.data.courses;
              const skipped = parseRes.data.skippedUnscheduled;
              if (skipped.length > 0) {
                message.info(
                  `${skipped.length} 门课程未安排上课时间（${skipped.map((s) => s.name).join("、")}），未导入，如需请手动添加。`,
                );
              }
            }
          }
          if (imgRes.ok && imgRes.data) {
            const ocrRes = await window.api.importBrowser.runOcr(imgRes.data);
            if (ocrRes.ok && ocrRes.data) ocr = ocrRes.data;
          }
          return { dom, ocr };
        })();
      const { dom, ocr } = await tasks;
      if ((!dom || dom.length === 0) && (!ocr || ocr.length === 0)) {
        message.warning("未能识别出课程，请确认课表页面已加载");
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

  const doImportWrite = async (merged: CompleteParsedCourse[]) => {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      let success = 0;
      for (let i = 0; i < merged.length; i++) {
        const c = merged[i];
        const payload = {
          name: c.name.trim(),
          teacher: c.teacher,
          location: c.location,
          startWeek: c.startWeek,
          endWeek: c.endWeek,
          weekday: c.weekday,
          startPeriod: c.startPeriod,
          endPeriod: c.endPeriod,
          color: c.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        };
        const res = await window.api.timetable.add(payload);
        if (res.ok) success++;
      }
      if (success < merged.length) {
        message.warning(
          `已导入 ${success} / ${merged.length} 门课程，部分课程写入失败，请核对课表`,
        );
      } else {
        message.success(`已导入 ${success} 门课程`);
      }
      setConflictOpen(false);
      void loadCourses();
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const handleConflictConfirm = async (merged: ParsedCourse[]) => {
    if (merged.some((course) => !hasCompleteCourse(course))) {
      message.error(
        "请先补全每门课程的名称、周次、星期和起止节次；不完整的识别结果不会写入课表。",
      );
      return;
    }
    const incoming = merged as CompleteParsedCourse[];
    // 导入写入撞课检查：已有课程与导入课程（含导入课程相互之间）撞课时提示，确认后仍写入
    const slots = [
      ...courses.map((c) => ({
        name: c.name,
        weekday: c.weekday as number,
        startWeek: c.startWeek,
        endWeek: c.endWeek,
        startPeriod: c.startPeriod,
        endPeriod: c.endPeriod,
      })),
      ...incoming.map((c) => ({
        name: c.name.trim(),
        weekday: c.weekday as number,
        startWeek: c.startWeek,
        endWeek: c.endWeek,
        startPeriod: c.startPeriod,
        endPeriod: c.endPeriod,
      })),
    ];
    const pairs: string[] = [];
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        if (coursePairConflict(slots[i], slots[j])) {
          pairs.push(`${slots[i].name} × ${slots[j].name}`);
        }
      }
    }
    if (pairs.length === 0) {
      await doImportWrite(incoming);
      return;
    }
    Modal.confirm({
      title: "导入将产生撞课",
      content: `检测到 ${pairs.length} 处撞课：${pairs.slice(0, 5).join("；")}${pairs.length > 5 ? " 等" : ""}。写入后课程表上会以角标标记，仍要写入吗？`,
      okText: "仍然写入",
      cancelText: "返回检查",
      onOk: () => doImportWrite(incoming),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶部工具栏 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          课程表
        </Title>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              loadCourses();
              loadPeriods();
              loadConflictExtras();
            }}
          >
            刷新
          </Button>
          <Button icon={<PlusOutlined />} onClick={handleAddButtonClick}>
            添加课程
          </Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setTimeDialogOpen(true)}
          >
            时间设置
          </Button>
          <Button
            type="primary"
            icon={<ImportOutlined />}
            loading={importing}
            onClick={handleImport}
          >
            自动导入
          </Button>
        </Space>
      </div>

      {/* 自动导入与 OCR 引导提示 */}
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          提示：点击「自动导入」将打开嵌入式浏览器，登录教务系统并进入课表页面后关闭子窗口，系统会自动提取课程信息。
          OCR 识别首次运行需加载中文模型（约 5-10 秒），请耐心等待；DOM
          解析通常更快且更准确。
        </Text>
        {semesterStart === null && (
          <Text type="warning" style={{ fontSize: 12, display: "block" }}>
            未设置学期开始日期，跨板块撞课检测（课程 vs
            考试/实验/日程）未启用；可在「设置 → 课程与学期」中设置。
          </Text>
        )}
      </div>

      <Spin spinning={loading}>
        <Card styles={{ body: { padding: 12 } }}>
          <WeekView
            courses={courses}
            currentWeek={currentWeek}
            semesterStart={semesterStart}
            onWeekChange={setCurrentWeek}
            onEdit={handleEditCourse}
            onAdd={handleAddCourse}
            periodCount={periodCount}
            conflicts={conflicts}
          />
        </Card>
      </Spin>

      <CourseDialog
        open={courseDialogOpen}
        course={editingCourse ?? undefined}
        onOk={handleCourseDialogOk}
        onDelete={handleDeleteCourse}
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
        submitting={submitting}
        onConfirm={handleConflictConfirm}
        onCancel={() => setConflictOpen(false)}
      />
    </div>
  );
}
