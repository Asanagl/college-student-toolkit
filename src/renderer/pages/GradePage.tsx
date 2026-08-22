// 成绩显示板块页面
// 职责：主进程聚合统计、按学期/学位课分页取数、成绩编辑与 GPA 公式设置。
// 大数据量时只把当前页跨 IPC 传到渲染进程，避免首屏和路由切换携带完整成绩表。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "antd";
import {
  PlusOutlined,
  FunctionOutlined,
  EditOutlined,
  DeleteOutlined,
  StarOutlined,
  StarFilled,
} from "@ant-design/icons";
import type { Grade, GradeDashboard, GpaFormula } from "../../shared/types";
import GradeDialog from "../components/grade/GradeDialog";
import GpaFormulaDialog, {
  DEFAULT_FORMULA,
} from "../components/grade/GpaFormulaDialog";

const { Text } = Typography;
const DEGREE_VIEW_KEY = "__degree_view__";
const PAGE_SIZE_OPTIONS = [20, 50, 100];

const FALLBACK_FORMULA: GpaFormula = {
  id: "default",
  name: "默认公式",
  formula: DEFAULT_FORMULA,
  isDefault: true,
  createdAt: "",
  updatedAt: "",
};

function parseSemester(value: string): [number, number, number] {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(value);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : [0, 0, 0];
}

function compareSemesters(left: string, right: string): number {
  const a = parseSemester(left);
  const b = parseSemester(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export default function GradePage() {
  const [dashboard, setDashboard] = useState<GradeDashboard | null>(null);
  const [pageData, setPageData] = useState({
    items: [] as Grade[],
    page: 1,
    pageSize: 20,
    total: 0,
  });
  const [activeKey, setActiveKey] = useState(DEGREE_VIEW_KEY);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const requestId = useRef(0);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const result = await window.api.grade.getDashboard();
      if (result.ok && result.data) {
        setDashboard(result.data);
      } else {
        message.error(result.error ?? "加载成绩统计失败");
      }
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const semesters = useMemo(
    () =>
      [...(dashboard?.semesters ?? [])]
        .sort((a, b) => compareSemesters(b.semester, a.semester))
        .map((item) => item.semester),
    [dashboard?.semesters],
  );

  const allSemesters = semesters;

  useEffect(() => {
    const validKeys = [...semesters, DEGREE_VIEW_KEY];
    if (!validKeys.includes(activeKey)) {
      setActiveKey(semesters[0] ?? DEGREE_VIEW_KEY);
      setPage(1);
    }
  }, [activeKey, semesters]);

  const queryKey = `${activeKey}:${page}:${pageSize}`;

  const loadPage = useCallback(
    async (targetKey: string, targetPage: number, targetPageSize: number) => {
      const currentRequest = ++requestId.current;
      const targetQueryKey = `${targetKey}:${targetPage}:${targetPageSize}`;
      setPageLoading(true);
      setLoadedQueryKey(null);
      try {
        const query =
          targetKey === DEGREE_VIEW_KEY
            ? {
                degreeOnly: true,
                page: targetPage,
                pageSize: targetPageSize,
              }
            : {
                semester: targetKey,
                page: targetPage,
                pageSize: targetPageSize,
              };
        const result = await window.api.grade.listPage(query);
        if (currentRequest !== requestId.current) return;
        if (result.ok && result.data) {
          setPageData(result.data);
          setLoadedQueryKey(targetQueryKey);
        } else {
          message.error(result.error ?? "加载成绩列表失败");
        }
      } finally {
        if (currentRequest === requestId.current) setPageLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!dashboard) return;
    void loadPage(activeKey, page, pageSize);
  }, [activeKey, dashboard, loadPage, page, pageSize]);

  const refreshData = useCallback(async () => {
    setPage(1);
    await loadDashboard();
  }, [loadDashboard]);

  const [gradeDialogOpen, setGradeDialogOpen] = useState(false);
  const [editingGrade, setEditingGrade] = useState<Grade | null>(null);
  const [formulaDialogOpen, setFormulaDialogOpen] = useState(false);

  const handleAdd = () => {
    setEditingGrade(null);
    setGradeDialogOpen(true);
  };

  const handleEdit = useCallback((grade: Grade) => {
    setEditingGrade(grade);
    setGradeDialogOpen(true);
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await window.api.grade.remove(id);
      if (!result.ok) {
        message.error(result.error ?? "删除失败");
        return;
      }
      message.success("已删除成绩");
      void refreshData();
    },
    [refreshData],
  );

  const handleToggleDegree = useCallback(
    async (grade: Grade) => {
      const result = await window.api.grade.update(grade.id, {
        isDegreeCourse: !grade.isDegreeCourse,
      });
      if (!result.ok) {
        message.error(result.error ?? "更新失败");
        return;
      }
      void refreshData();
    },
    [refreshData],
  );

  const columns: TableColumnsType<Grade> = useMemo(
    () => [
      {
        title: "课程名",
        dataIndex: "courseName",
        key: "courseName",
        ellipsis: true,
      },
      {
        title: "学分",
        dataIndex: "credit",
        key: "credit",
        width: 80,
        align: "center",
      },
      {
        title: "绩点",
        dataIndex: "gradePoint",
        key: "gradePoint",
        width: 80,
        align: "center",
      },
      {
        title: "成绩",
        dataIndex: "score",
        key: "score",
        width: 80,
        align: "center",
        render: (score: number | null | undefined) =>
          score != null ? <Text>{score}</Text> : <Text type="secondary">—</Text>,
      },
      {
        title: "学位课",
        dataIndex: "isDegreeCourse",
        key: "isDegreeCourse",
        width: 100,
        align: "center",
        render: (isDegree: boolean) =>
          isDegree ? <Tag color="green">学位课</Tag> : <Tag>否</Tag>,
      },
      {
        title: "操作",
        key: "actions",
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
              {record.isDegreeCourse ? "取消学位课" : "设为学位课"}
            </Button>
          </Space>
        ),
      },
    ],
    [handleDelete, handleEdit, handleToggleDegree],
  );

  const renderTable = (tableKey: string) => {
    const isActive = tableKey === activeKey && loadedQueryKey === queryKey;
    const total =
      tableKey === DEGREE_VIEW_KEY
        ? dashboard?.degreeCount ?? 0
        : dashboard?.semesters.find((item) => item.semester === tableKey)
            ?.count ?? 0;
    return (
      <Table
        columns={columns}
        dataSource={isActive ? pageData.items : []}
        rowKey="id"
        loading={pageLoading || dashboardLoading}
        pagination={{
          current: isActive ? pageData.page : page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPageSize === pageSize ? nextPage : 1);
            setPageSize(nextPageSize);
          },
        }}
        size="middle"
        locale={{ emptyText: <Empty description="该视图暂无成绩" /> }}
      />
    );
  };

  const tabItems = useMemo(() => {
    const items = semesters.map((semester) => ({
      key: semester,
      label: semester,
      children: renderTable(semester),
    }));
    items.push({
      key: DEGREE_VIEW_KEY,
      label: `学位课视图${dashboard?.degreeCount ? ` (${dashboard.degreeCount})` : ""}`,
      children: renderTable(DEGREE_VIEW_KEY),
    });
    return items;
  }, [dashboard, loadedQueryKey, page, pageData, pageSize, activeKey, columns, pageLoading, semesters]);

  const formula = dashboard?.formula ?? FALLBACK_FORMULA;
  const handleSaved = () => {
    setGradeDialogOpen(false);
    void refreshData();
  };
  const handleFormulaSaved = () => void refreshData();

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Space style={{ marginBottom: 16 }} wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加成绩
          </Button>
          <Button
            icon={<FunctionOutlined />}
            onClick={() => setFormulaDialogOpen(true)}
          >
            公式设置
          </Button>
        </Space>
        <Space size="middle" wrap>
          <Card size="small" style={{ minWidth: 200 }}>
            <Statistic
              title={`本学期 GPA（${dashboard?.latestSemester || "暂无学期"}）`}
              value={dashboard?.semesterGpa ?? 0}
              precision={2}
            />
          </Card>
          <Card size="small" style={{ minWidth: 160 }}>
            <Statistic
              title="总体 GPA"
              value={dashboard?.overallGpa ?? 0}
              precision={2}
            />
          </Card>
          <Card size="small" style={{ minWidth: 160 }}>
            <Statistic
              title="学位课 GPA"
              value={dashboard?.degreeGpa ?? 0}
              precision={2}
            />
          </Card>
          <Card size="small" style={{ minWidth: 140 }}>
            <Statistic
              title="总学分"
              value={dashboard?.totalCredit ?? 0}
              precision={1}
            />
          </Card>
        </Space>
      </Card>

      <Card>
        {!dashboard ? (
          <div style={{ minHeight: 180, display: "grid", placeItems: "center" }}>
            <Typography.Text type="secondary">正在加载成绩...</Typography.Text>
          </div>
        ) : dashboard.totalCount === 0 ? (
          <Empty description="暂无成绩，点击「添加成绩」开始录入">
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              添加成绩
            </Button>
          </Empty>
        ) : (
          <Tabs
            activeKey={activeKey}
            onChange={(key) => {
              setActiveKey(key);
              setPage(1);
            }}
            destroyInactiveTabPane
            items={tabItems}
          />
        )}
      </Card>

      <GradeDialog
        open={gradeDialogOpen}
        editing={editingGrade}
        semesters={allSemesters}
        onClose={() => setGradeDialogOpen(false)}
        onSaved={handleSaved}
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
