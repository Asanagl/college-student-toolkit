// 日程板块页面：日历视图 + 日程列表 + CRUD 对话框。
// 职责：管理全局日程数据、选中日期与对话框开关状态，向下分发数据与回调。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, message, Spin, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { Schedule } from '../../shared/types';
import { findCrossBoardConflicts } from '../../shared/conflicts';
import CalendarView, { getSchedulesOnDate } from '../components/schedule/CalendarView';
import ScheduleList from '../components/schedule/ScheduleList';
import ScheduleDialog from '../components/schedule/ScheduleDialog';
import {
  SEMESTER_START_EVENT,
  useConflictData,
} from '../services/useConflictData';

const { Title, Text } = Typography;

export default function SchedulePage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  // 拉取所有日程，前端按日期过滤（日程总量有限，无需后端分页）
  const loadSchedules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.api.schedule.list();
      if (res.ok && res.data) {
        setSchedules(res.data);
      } else {
        message.error(res.error ?? '加载日程失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  // 跨板块撞课：日程 vs 课程（semesterStart 未设置时自动为空，不显示标记）
  const conflictData = useConflictData();
  const scheduleConflicts = useMemo(
    () =>
      findCrossBoardConflicts({
        courses: conflictData.courses,
        semesterStart: conflictData.semesterStart,
        periods: conflictData.periods,
        exams: [],
        labs: [],
        schedules,
      }).schedules,
    [
      conflictData.courses,
      conflictData.semesterStart,
      conflictData.periods,
      schedules,
    ],
  );

  // 学期开始日期在设置弹窗修改后本页不重挂载，订阅变更事件重载撞课数据
  useEffect(() => {
    const onChanged = () => void conflictData.reload();
    window.addEventListener(SEMESTER_START_EVENT, onChanged);
    return () => window.removeEventListener(SEMESTER_START_EVENT, onChanged);
  }, [conflictData.reload]);

  // 选中日期的日程（已按开始时间排序）
  const schedulesForSelectedDate = getSchedulesOnDate(schedules, selectedDate);

  const handleAdd = () => {
    setEditingSchedule(null);
    setDialogOpen(true);
  };
  const handleEdit = (s: Schedule) => {
    setEditingSchedule(s);
    setDialogOpen(true);
  };
  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingSchedule(null);
  };
  const handleDialogSuccess = () => {
    setDialogOpen(false);
    setEditingSchedule(null);
    loadSchedules();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部标题与添加按钮 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          日程
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加日程
        </Button>
      </div>
      {conflictData.error && (
        <Text type="warning" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          撞课数据加载失败，撞课标记不可用：{conflictData.error}
        </Text>
      )}
      <Spin spinning={loading}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* 左侧日历占主要空间 */}
          <Card style={{ flex: 1, minWidth: 0 }}>
            <CalendarView
              schedules={schedules}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />
          </Card>
          {/* 右侧日程列表 */}
          <Card style={{ width: 360, flexShrink: 0 }}>
            <ScheduleList
              date={selectedDate}
              schedules={schedulesForSelectedDate}
              conflicts={scheduleConflicts}
              onAdd={handleAdd}
              onEdit={handleEdit}
            />
          </Card>
        </div>
      </Spin>
      <ScheduleDialog
        open={dialogOpen}
        mode={editingSchedule ? 'edit' : 'add'}
        schedule={editingSchedule}
        defaultDate={selectedDate}
        onCancel={handleDialogClose}
        onSuccess={handleDialogSuccess}
      />
    </div>
  );
}
