// 成绩显示板块页面
// 职责：统计卡片 + 学期分页表格 + 学位课视图 + 添加/编辑/公式对话框
// GPA 计算在渲染进程完成（与主进程 GradeService 维护等价逻辑，因 contextIsolation 无法共享）
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Space,
  Statistic,
  Tabs,
  Table,
  Tag,
  Popconfirm,
  message,
  Empty,
  Typography,
  type TableColumnsType,
} from 'antd';
import {
  PlusOutlined,
  FunctionOutlined,
  ExportOutlined,
  EditOutlined,
  DeleteOutlined,
  StarOutlined,
  StarFilled,
} from '@ant-design/icons';
import type { Grade, GpaFormula } from '../../shared/types';
import GradeDialog from '../components/grade/GradeDialog';
import GpaFormulaDialog, { computeGpa, DEFAULT_FORMULA } from '../components/grade/GpaFormulaDialog';

const { Text } = Typography;

/** 学位课视图 Tab 的固定 key，避免与真实学期字符串冲突 */
const DEGREE_VIEW_KEY = '__degree_view__';

/** 回退用默认公式（数据库无记录时使用） */
const FALLBACK_FORMULA: GpaFormula = {
  id: 'default',
  name: '默认公式',
  formula: DEFAULT_FORMULA,
  isDefault: true,
  createdAt: '',
  updatedAt: '',
};

/**
 * 解析 "YYYY-YYYY-N" 学期为数字元组用于排序。
 * 非标准格式回退到 [0,0,0]，排在最前以便用户可见。
 */
function parseSemester(s: string): [number, number, number] {
  const m = s.match(/^(\d+)-(\d+)-(\d+)$/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 学期比较：按起始年、结束年、学期序号升序 */
function compareSemesters(a: string, b: string): number {
  const [a1, a2, a3] = parseSemester(a);
  const [b1, b2, b3] = parseSemester(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

export default function GradePage() {
  const [grades, setGrades] = useState<Grade[]>([]);
  const [formula, setFormula] = useState<GpaFormula>(FALLBACK_FORMULA);
  const [loading, setLoading] = useState(false);
  const [activeKey, setActiveKey] = useState<string>(DEGREE_VIEW_KEY);

  // 对话框状态
  const [gradeDialogOpen, setGradeDialogOpen] = useState(false);
  const [editingGrade, setEditingGrade] = useState<Grade | null>(null);
  const [formulaDialogOpen, setFormulaDialogOpen] = useState(false);

  /** 加载成绩列表；silent=true 时不显示加载态，避免操作后表格闪烁 */
  const loadGrades = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await window.api.grade.list();
      if (res.ok && res.data) {
        setGrades(res.data);
      } else {
        message.error(res.error ?? '加载成绩失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  /** 加载默认公式；无记录时保持回退默认公式 */
  const loadFormula = useCallback(async () => {
    const res = await window.api.formula.list();
    if (res.ok && res.data && res.data.length > 0) {
      const def = res.data.find((f) => f.isDefault) ?? res.data[0];
      setFormula(def);
    }
  }, []);

  useEffect(() => {
    loadGrades();
    loadFormula();
  }, [loadGrades, loadFormula]);

  // 按学期分组，保持 Map 插入顺序
  const semesterGroups = useMemo(() => {
    const map = new Map<string, Grade[]>();
    for (const g of grades) {
      const list = map.get(g.semester) ?? [];
      list.push(g);
      map.set(g.semester, list);
    }
    return map;
  }, [grades]);

  // 学期列表降序排列（最新在前）
  const semesters = useMemo(() => {
    return Array.from(semesterGroups.keys()).sort((a, b) => compareSemesters(b, a));
  }, [semesterGroups]);

  // 当前选中的 Tab 失效时（如学期被删空）回退到最新学期
  useEffect(() => {
    const validKeys = [...semesters, DEGREE_VIEW_KEY];
    if (!validKeys.includes(activeKey)) {
      setActiveKey(semesters[0] ?? DEGREE_VIEW_KEY);
    }
  }, [semesters, activeKey]);

  // 已有学期（供对话框 Select 选项）
  const allSemesters = useMemo(() => {
    return Array.from(new Set(grades.map((g) => g.semester))).sort((a, b) =>
      compareSemesters(b, a)
    );
  }, [grades]);

  // 统计卡片数据
  const stats = useMemo(() => {
    const latestSemester = semesters[0] ?? '';
    const latestGrades = latestSemester ? semesterGroups.get(latestSemester) ?? [] : [];
    const semesterGpa = latestGrades.length > 0 ? computeGpa(latestGrades, formula) : 0;
    const overallGpa = grades.length > 0 ? computeGpa(grades, formula) : 0;
    const degreeGrades = grades.filter((g) => g.isDegreeCourse);
    const degreeGpa = degreeGrades.length > 0 ? computeGpa(degreeGrades, formula) : 0;
    const totalCredit = grades.reduce((sum, g) => sum + g.credit, 0);
    return { latestSemester, semesterGpa, overallGpa, degreeGpa, totalCredit };
  }, [grades, semesters, semesterGroups, formula]);

  // ===== 操作处理 =====

  const handleAdd = () => {
    setEditingGrade(null);
    setGradeDialogOpen(true);
  };

  const handleEdit = (grade: Grade) => {
    setEditingGrade(grade);
    setGradeDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    const res = await window.api.grade.remove(id);
    if (!res.ok) {
      message.error(res.error ?? '删除失败');
      return;
    }
    message.success('已删除成绩');
    loadGrades(true);
  };

  /** 快捷切换学位课标记 */
  const handleToggleDegree = async (grade: Grade) => {
    const res = await window.api.grade.update(grade.id, {
      isDegreeCourse: !grade.isDegreeCourse,
    });
    if (!res.ok) {
      message.error(res.error ?? '更新失败');
      return;
    }
    loadGrades(true);
  };

  /** 导出数据：先选路径再导出 */
  const handleExport = async () => {
    const pickRes = await window.api.data.pickExportPath();
    if (!pickRes.ok || !pickRes.data) return; // 用户取消
    const exportRes = await window.api.data.export(pickRes.data);
    if (exportRes.ok) {
      message.success('导出成功');
    } else {
      message.error(exportRes.error ?? '导出失败');
    }
  };

  const handleGradeSaved = () => loadGrades(true);
  const handleFormulaSaved = () => {
    loadFormula();
    loadGrades(true); // 公式变化后统计卡片需刷新
  };

  // ===== 表格列定义 =====

  const columns: TableColumnsType<Grade> = [
    { title: '课程名', dataIndex: 'courseName', key: 'courseName', ellipsis: true },
    { title: '学分', dataIndex: 'credit', key: 'credit', width: 80, align: 'center' },
    { title: '绩点', dataIndex: 'gradePoint', key: 'gradePoint', width: 80, align: 'center' },
    {
      title: '成绩',
      dataIndex: 'score',
      key: 'score',
      width: 80,
      align: 'center',
      render: (score: number | null | undefined) =>
        score != null ? <Text>{score}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: '学位课',
      dataIndex: 'isDegreeCourse',
      key: 'isDegreeCourse',
      width: 100,
      align: 'center',
      render: (isDegree: boolean) =>
        isDegree ? <Tag color="green">学位课</Tag> : <Tag>否</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      render: (_value, record) => (
        <Space size="small" wrap>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除该成绩？"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
          <Button
            size="small"
            icon={record.isDegreeCourse ? <StarFilled /> : <StarOutlined />}
            onClick={() => handleToggleDegree(record)}
          >
            {record.isDegreeCourse ? '取消学位课' : '设为学位课'}
          </Button>
        </Space>
      ),
    },
  ];

  // ===== Tabs 项 =====

  const tabItems = useMemo(() => {
    const items = semesters.map((sem) => ({
      key: sem,
      label: sem,
      children: (
        <Table
          columns={columns}
          dataSource={semesterGroups.get(sem) ?? []}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="middle"
          locale={{ emptyText: <Empty description="该学期暂无成绩" /> }}
        />
      ),
    }));

    // 学位课视图 Tab：汇总所有标记为学位课的课程
    const degreeGrades = grades.filter((g) => g.isDegreeCourse);
    items.push({
      key: DEGREE_VIEW_KEY,
      label: `学位课视图${degreeGrades.length > 0 ? ` (${degreeGrades.length})` : ''}`,
      children: (
        <Table
          columns={columns}
          dataSource={degreeGrades}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="middle"
          locale={{ emptyText: <Empty description="暂无学位课，请在列表中标记" /> }}
        />
      ),
    });
    return items;
  }, [semesters, semesterGroups, grades, columns, loading]);

  // ===== 渲染 =====

  return (
    <div>
      {/* 顶部操作区 + 统计卡片 */}
      <Card style={{ marginBottom: 16 }}>
        <Space style={{ marginBottom: 16 }} wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加成绩
          </Button>
          <Button icon={<FunctionOutlined />} onClick={() => setFormulaDialogOpen(true)}>
            公式设置
          </Button>
          <Button icon={<ExportOutlined />} onClick={handleExport}>
            导出数据
          </Button>
        </Space>

        <Space size="middle" wrap>
          <Card size="small" style={{ minWidth: 200 }}>
            <Statistic
              title={`本学期 GPA（${stats.latestSemester || '暂无学期'}）`}
              value={stats.semesterGpa}
              precision={2}
            />
          </Card>
          <Card size="small" style={{ minWidth: 160 }}>
            <Statistic title="总体 GPA" value={stats.overallGpa} precision={2} />
          </Card>
          <Card size="small" style={{ minWidth: 160 }}>
            <Statistic title="学位课 GPA" value={stats.degreeGpa} precision={2} />
          </Card>
          <Card size="small" style={{ minWidth: 140 }}>
            <Statistic title="总学分" value={stats.totalCredit} precision={1} />
          </Card>
        </Space>
      </Card>

      {/* 学期分页表格 + 学位课视图 */}
      <Card>
        {grades.length === 0 ? (
          <Empty description="暂无成绩，点击「添加成绩」开始录入">
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              添加成绩
            </Button>
          </Empty>
        ) : (
          <Tabs
            activeKey={activeKey}
            onChange={setActiveKey}
            items={tabItems}
          />
        )}
      </Card>

      {/* 对话框 */}
      <GradeDialog
        open={gradeDialogOpen}
        editing={editingGrade}
        semesters={allSemesters}
        onClose={() => setGradeDialogOpen(false)}
        onSaved={handleGradeSaved}
      />
      <GpaFormulaDialog
        open={formulaDialogOpen}
        currentFormula={formula}
        onClose={() => setFormulaDialogOpen(false)}
        onSaved={handleFormulaSaved}
      />
    </div>
  );
}
