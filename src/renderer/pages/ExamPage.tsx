// 考试安排板块页面：考试列表 + 工具栏 + 添加/编辑对话框 + 自动导入流程。
// 职责：管理考试数据、对话框开关状态、自动导入流程，向下分发数据与回调。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  PlusOutlined,
  ReloadOutlined,
  ImportOutlined,
  EditOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { Exam, ParsedExam } from "../../shared/types";
import ExamDialog from "../components/exam/ExamDialog";
import ExamConflictResolver from "../components/exam/ExamConflictResolver";

const { Title, Text } = Typography;

// 默认提醒档位：导入考试时若未识别到提醒档位则使用
const DEFAULT_REMINDER_OFFSETS = [1440, 60];
const TABLE_PAGINATION = {
  pageSize: 20,
  showSizeChanger: true,
  pageSizeOptions: [20, 50, 100],
};

// 导入进度提示的固定 key：对话框遮罩挡住整个页面，只有全局 message 能透出进度
const IMPORT_MSG_KEY = "exam-import-progress";

type CompleteParsedExam = ParsedExam & {
  courseName: string;
  date: string;
  startTime: string;
  endTime: string;
};

function hasCompleteExam(exam: ParsedExam): exam is CompleteParsedExam {
  const isTime = (value: unknown): value is string =>
    typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  return Boolean(exam.courseName?.trim())
    && typeof exam.date === "string"
    && dayjs(exam.date, "YYYY-MM-DD", true).isValid()
    && isTime(exam.startTime)
    && isTime(exam.endTime)
    && exam.startTime < exam.endTime;
}

export default function ExamPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingExam, setEditingExam] = useState<Exam | null>(null);
  // 保存/导入落库是逐条串行 await，期间对话框按钮仍可点击，用状态位挡住重复写入
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);

  // 自动导入流程状态
  const [importing, setImporting] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [domExams, setDomExams] = useState<ParsedExam[]>([]);
  const [ocrExams, setOcrExams] = useState<ParsedExam[]>([]);

  const loadExams = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.api.exam.list();
      if (res.ok && res.data) {
        setExams(res.data);
      } else {
        message.error(res.error ?? "加载考试失败");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  // 按日期升序排序
  const sortedExams = useMemo(() => {
    return [...exams].sort((a, b) => {
      const da = `${a.date} ${a.startTime}`;
      const db = `${b.date} ${b.startTime}`;
      return da.localeCompare(db);
    });
  }, [exams]);

  const handleAdd = () => {
    setEditingExam(null);
    setDialogOpen(true);
  };
  const handleEdit = (exam: Exam) => {
    setEditingExam(exam);
    setDialogOpen(true);
  };
  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingExam(null);
  };

  const handleDialogOk = async (
    data: Omit<Exam, "id" | "createdAt" | "updatedAt">,
  ) => {
    if (submitting) return; // 写库未完成前忽略后续点击，避免重复插入
    setSubmitting(true);
    try {
      if (editingExam) {
        const res = await window.api.exam.update(editingExam.id, data);
        if (!res.ok) {
          message.error(res.error ?? "更新失败");
          return;
        }
        message.success("已更新考试");
      } else {
        const res = await window.api.exam.add(data);
        if (!res.ok) {
          message.error(res.error ?? "添加失败");
          return;
        }
        message.success("已添加考试");
      }
      setDialogOpen(false);
      setEditingExam(null);
      loadExams();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (exam: Exam) => {
    const res = await window.api.exam.remove(exam.id);
    if (!res.ok) {
      message.error(res.error ?? "删除失败");
      return;
    }
    message.success("已删除");
    loadExams();
  };

  // ===== 自动导入流程 =====
  const handleImport = async () => {
    setImporting(true);
    try {
      // 复用嵌入式浏览器：打开 → 用户登录教务系统到考试页面 → 关闭后提取
      const openRes = await window.api.importBrowser.openBrowser();
      if (!openRes.ok) {
        message.error(openRes.error ?? "打开浏览器失败");
        return;
      }
      const [domRes, imgRes] = await Promise.all([
        window.api.importBrowser.extractDom(),
        window.api.importBrowser.capturePage(),
      ]);
      if (!domRes.ok && !imgRes.ok) {
        message.error("未提取到任何数据，请重新尝试");
        return;
      }
      // 并行解析 DOM 与 OCR
      let dom: ParsedExam[] = [];
      let ocr: ParsedExam[] = [];
      if (domRes.ok && domRes.data) {
        const parseRes = await window.api.examImport.parseDomForExams(
          domRes.data,
        );
        if (parseRes.ok && parseRes.data) dom = parseRes.data;
      }
      if (imgRes.ok && imgRes.data) {
        const ocrRes = await window.api.examImport.runOcrForExams(imgRes.data);
        if (ocrRes.ok && ocrRes.data) ocr = ocrRes.data;
      }
      if (dom.length === 0 && ocr.length === 0) {
        message.warning("未能识别出考试，请确认已打开考试安排页面");
        return;
      }
      setDomExams(dom);
      setOcrExams(ocr);
      setConflictOpen(true);
    } catch (err) {
      message.error(`导入失败: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleConflictConfirm = async (merged: ParsedExam[]) => {
    if (submitLock.current) return;
    if (merged.some((exam) => !hasCompleteExam(exam))) {
      message.error("请先补全每场考试的课程名、日期和起止时间；不完整的识别结果不会写入日程。");
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    try {
      let success = 0;
      for (let i = 0; i < merged.length; i++) {
        const e = merged[i] as CompleteParsedExam;
        message.loading({
          content: `正在导入 ${i + 1}/${merged.length}…`,
          key: IMPORT_MSG_KEY,
          duration: 0,
        });
        const payload = {
          courseName: e.courseName.trim(),
          date: e.date,
          startTime: e.startTime,
          endTime: e.endTime,
          location: e.location,
          seat: e.seat,
          notes: e.notes,
          reminderOffsets: DEFAULT_REMINDER_OFFSETS,
        };
        const res = await window.api.exam.add(payload);
        if (res.ok) success++;
      }
      message.success(`已导入 ${success}/${merged.length} 场考试`);
      setConflictOpen(false);
      loadExams();
    } finally {
      // 进度提示与成功提示是不同 key，销毁前者不会吞掉后者
      message.destroy(IMPORT_MSG_KEY);
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<Exam> = useMemo(
    () => [
      {
        title: "课程名",
        dataIndex: "courseName",
        key: "courseName",
        render: (text: string) => <Text strong>{text}</Text>,
      },
      {
        title: "日期",
        dataIndex: "date",
        key: "date",
        width: 120,
      },
      {
        title: "时间",
        key: "time",
        width: 120,
        render: (_, row) => (
          <Text>
            {row.startTime} - {row.endTime}
          </Text>
        ),
      },
      {
        title: "地点",
        dataIndex: "location",
        key: "location",
        width: 140,
        render: (text?: string) => text || <Text type="secondary">—</Text>,
      },
      {
        title: "座位",
        dataIndex: "seat",
        key: "seat",
        width: 80,
        render: (text?: string) => text || <Text type="secondary">—</Text>,
      },
      {
        title: "倒计时",
        key: "countdown",
        width: 100,
        render: (_, row) => {
          const days = dayjs(row.date)
            .startOf("day")
            .diff(dayjs().startOf("day"), "day");
          if (days < 0) return <Tag color="default">已结束</Tag>;
          if (days === 0) return <Tag color="red">今天</Tag>;
          // 距离 <7 天红色高亮
          const color = days < 7 ? "red" : "blue";
          return <Tag color={color}>{days} 天后</Tag>;
        },
      },
      {
        title: "备注",
        dataIndex: "notes",
        key: "notes",
        width: 140,
        render: (text?: string) =>
          text ? (
            <Text type="secondary">{text}</Text>
          ) : (
            <Text type="secondary">—</Text>
          ),
      },
      {
        title: "操作",
        key: "action",
        width: 100,
        render: (_, row) => (
          <Space size="small">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleEdit(row)}
            />
            {/* 删除图标紧挨编辑图标，误触即永久丢数据，必须二次确认 */}
            <Popconfirm
              title="确认删除该考试？"
              description="删除后无法恢复"
              onConfirm={() => handleDelete(row)}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
              />
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [],
  );

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
          考试安排
        </Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadExams}>
            刷新
          </Button>
          <Button icon={<PlusOutlined />} onClick={handleAdd}>
            添加考试
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

      <Spin spinning={loading}>
        <Card styles={{ body: { padding: 12 } }}>
          <Table
            columns={columns}
            dataSource={sortedExams}
            rowKey="id"
            pagination={TABLE_PAGINATION}
            size="middle"
            locale={{ emptyText: '暂无考试安排，点击"添加考试"或"自动导入"' }}
          />
        </Card>
      </Spin>

      <ExamDialog
        open={dialogOpen}
        exam={editingExam ?? undefined}
        onOk={handleDialogOk}
        onCancel={handleDialogClose}
      />

      <ExamConflictResolver
        open={conflictOpen}
        domExams={domExams}
        ocrExams={ocrExams}
        submitting={submitting}
        onConfirm={handleConflictConfirm}
        onCancel={() => setConflictOpen(false)}
      />
    </div>
  );
}
