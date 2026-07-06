// 实验提醒板块页面：实验列表 + 工具栏 + 添加/编辑对话框 + 自动导入流程。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Space, Spin, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  ReloadOutlined,
  ImportOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Lab, ParsedLab } from '../../shared/types';
import LabDialog from '../components/lab/LabDialog';
import LabConflictResolver from '../components/lab/LabConflictResolver';

const { Title, Text } = Typography;

const DEFAULT_REMINDER_OFFSETS = [1440, 60];

export default function LabPage() {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLab, setEditingLab] = useState<Lab | null>(null);

  // 自动导入流程状态
  const [importing, setImporting] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [domLabs, setDomLabs] = useState<ParsedLab[]>([]);
  const [ocrLabs, setOcrLabs] = useState<ParsedLab[]>([]);

  const loadLabs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.api.lab.list();
      if (res.ok && res.data) {
        setLabs(res.data);
      } else {
        message.error(res.error ?? '加载实验失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLabs();
  }, [loadLabs]);

  // 按日期升序排序
  const sortedLabs = useMemo(() => {
    return [...labs].sort((a, b) => {
      const da = `${a.date} ${a.startTime}`;
      const db = `${b.date} ${b.startTime}`;
      return da.localeCompare(db);
    });
  }, [labs]);

  const handleAdd = () => {
    setEditingLab(null);
    setDialogOpen(true);
  };
  const handleEdit = (lab: Lab) => {
    setEditingLab(lab);
    setDialogOpen(true);
  };
  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingLab(null);
  };

  const handleDialogOk = async (data: Omit<Lab, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editingLab) {
      const res = await window.api.lab.update(editingLab.id, data);
      if (!res.ok) {
        message.error(res.error ?? '更新失败');
        return;
      }
      message.success('已更新实验');
    } else {
      const res = await window.api.lab.add(data);
      if (!res.ok) {
        message.error(res.error ?? '添加失败');
        return;
      }
      message.success('已添加实验');
    }
    setDialogOpen(false);
    setEditingLab(null);
    loadLabs();
  };

  const handleDelete = async (lab: Lab) => {
    const res = await window.api.lab.remove(lab.id);
    if (!res.ok) {
      message.error(res.error ?? '删除失败');
      return;
    }
    message.success('已删除');
    loadLabs();
  };

  // ===== 自动导入流程 =====
  const handleImport = async () => {
    setImporting(true);
    try {
      const openRes = await window.api.importBrowser.openBrowser();
      if (!openRes.ok) {
        message.error(openRes.error ?? '打开浏览器失败');
        return;
      }
      const [domRes, imgRes] = await Promise.all([
        window.api.importBrowser.extractDom(),
        window.api.importBrowser.capturePage(),
      ]);
      if (!domRes.ok && !imgRes.ok) {
        message.error('未提取到任何数据，请重新尝试');
        return;
      }
      let dom: ParsedLab[] = [];
      let ocr: ParsedLab[] = [];
      if (domRes.ok && domRes.data) {
        const parseRes = await window.api.labImport.parseDomForLabs(domRes.data);
        if (parseRes.ok && parseRes.data) dom = parseRes.data;
      }
      if (imgRes.ok && imgRes.data) {
        const ocrRes = await window.api.labImport.runOcrForLabs(imgRes.data);
        if (ocrRes.ok && ocrRes.data) ocr = ocrRes.data;
      }
      if (dom.length === 0 && ocr.length === 0) {
        message.warning('未能识别出实验，请确认已打开实验安排页面');
        return;
      }
      setDomLabs(dom);
      setOcrLabs(ocr);
      setConflictOpen(true);
    } catch (err) {
      message.error(`导入失败: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleConflictConfirm = async (merged: ParsedLab[]) => {
    let success = 0;
    for (let i = 0; i < merged.length; i++) {
      const l = merged[i];
      const payload = {
        name: l.name ?? `未命名实验${i + 1}`,
        date: l.date ?? dayjs().format('YYYY-MM-DD'),
        startTime: l.startTime ?? '14:00',
        endTime: l.endTime ?? '16:00',
        location: l.location,
        instructor: l.instructor,
        notes: l.notes,
        reminderOffsets: DEFAULT_REMINDER_OFFSETS,
      };
      const res = await window.api.lab.add(payload);
      if (res.ok) success++;
    }
    message.success(`已导入 ${success}/${merged.length} 项实验`);
    setConflictOpen(false);
    loadLabs();
  };

  const columns: ColumnsType<Lab> = useMemo(
    () => [
      {
        title: '实验名',
        dataIndex: 'name',
        key: 'name',
        render: (text: string) => <Text strong>{text}</Text>,
      },
      {
        title: '日期',
        dataIndex: 'date',
        key: 'date',
        width: 120,
      },
      {
        title: '时间',
        key: 'time',
        width: 120,
        render: (_, row) => <Text>{row.startTime} - {row.endTime}</Text>,
      },
      {
        title: '地点',
        dataIndex: 'location',
        key: 'location',
        width: 140,
        render: (text?: string) => text || <Text type="secondary">—</Text>,
      },
      {
        title: '指导教师',
        dataIndex: 'instructor',
        key: 'instructor',
        width: 100,
        render: (text?: string) => text || <Text type="secondary">—</Text>,
      },
      {
        title: '倒计时',
        key: 'countdown',
        width: 100,
        render: (_, row) => {
          const days = dayjs(row.date).startOf('day').diff(dayjs().startOf('day'), 'day');
          if (days < 0) return <Tag color="default">已结束</Tag>;
          if (days === 0) return <Tag color="red">今天</Tag>;
          const color = days < 7 ? 'red' : 'blue';
          return <Tag color={color}>{days} 天后</Tag>;
        },
      },
      {
        title: '注意事项',
        dataIndex: 'notes',
        key: 'notes',
        width: 140,
        render: (text?: string) =>
          text ? <Text type="secondary">{text}</Text> : <Text type="secondary">—</Text>,
      },
      {
        title: '操作',
        key: 'action',
        width: 100,
        render: (_, row) => (
          <Space size="small">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleEdit(row)}
            />
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleDelete(row)}
            />
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          实验提醒
        </Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadLabs}>
            刷新
          </Button>
          <Button icon={<PlusOutlined />} onClick={handleAdd}>
            添加实验
          </Button>
          <Button type="primary" icon={<ImportOutlined />} loading={importing} onClick={handleImport}>
            自动导入
          </Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        <Card styles={{ body: { padding: 12 } }}>
          <Table
            columns={columns}
            dataSource={sortedLabs}
            rowKey="id"
            pagination={false}
            size="middle"
            locale={{ emptyText: '暂无实验安排，点击"添加实验"或"自动导入"' }}
          />
        </Card>
      </Spin>

      <LabDialog
        open={dialogOpen}
        lab={editingLab ?? undefined}
        onOk={handleDialogOk}
        onCancel={handleDialogClose}
      />

      <LabConflictResolver
        open={conflictOpen}
        domLabs={domLabs}
        ocrLabs={ocrLabs}
        onConfirm={handleConflictConfirm}
        onCancel={() => setConflictOpen(false)}
      />
    </div>
  );
}
