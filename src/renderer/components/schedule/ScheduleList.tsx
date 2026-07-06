// 日程列表组件：显示某一天的所有日程，支持点击编辑与添加。
// 接收已按日期过滤并排序的日程数组，不自行过滤，职责单一。
import { Button, Empty, Tag, Typography } from 'antd';
import { BellOutlined, PlusOutlined } from '@ant-design/icons';
import type { RepeatRule, Schedule } from '../../../shared/types';

const { Text } = Typography;

interface ScheduleListProps {
  date: Date;
  /** 已按日期过滤并按开始时间排序的日程列表 */
  schedules: Schedule[];
  onAdd: () => void;
  onEdit: (schedule: Schedule) => void;
}

const REPEAT_LABELS: Record<RepeatRule, string> = {
  none: '不重复',
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
};

/** 格式化时间范围为 "HH:mm - HH:mm" */
function formatTimeRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const fmt = (d: Date) =>
    `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  return `${fmt(s)} - ${fmt(e)}`;
}

/** 将提醒偏移（分钟）格式化为可读文本 */
function formatReminder(offset: number): string {
  if (offset <= 0) return '不提醒';
  if (offset < 60) return `${offset}分钟前`;
  if (offset < 1440) return `${offset / 60}小时前`;
  return `${offset / 1440}天前`;
}

export default function ScheduleList({ date, schedules, onAdd, onEdit }: ScheduleListProps) {
  const dateStr = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <Text strong style={{ fontSize: 15 }}>
          {dateStr}
        </Text>
        <Button type="primary" icon={<PlusOutlined />} size="small" onClick={onAdd}>
          添加日程
        </Button>
      </div>
      {schedules.length === 0 ? (
        <Empty description="今日暂无日程" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {schedules.map((s) => (
            <div
              key={s.id}
              onClick={() => onEdit(s)}
              style={{
                padding: '8px 12px',
                border: '1px solid #f0f0f0',
                borderRadius: 6,
                cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#1677ff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#f0f0f0';
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Text strong>{s.title}</Text>
                <Tag color="blue">{REPEAT_LABELS[s.repeatRule]}</Tag>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  marginTop: 4,
                  color: '#888',
                  fontSize: 13,
                }}
              >
                <span>{formatTimeRange(s.startTime, s.endTime)}</span>
                <span>
                  <BellOutlined /> {formatReminder(s.reminderOffset)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
