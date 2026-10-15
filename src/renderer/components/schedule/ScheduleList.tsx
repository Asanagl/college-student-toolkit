// 日程列表组件：显示某一天的所有日程，支持点击编辑与添加。
// 接收已按日期过滤并排序的日程数组，不自行过滤，职责单一。
import type { KeyboardEvent } from 'react';
import { Button, Empty, Tag, theme, Typography } from 'antd';
import { BellOutlined, PlusOutlined } from '@ant-design/icons';
import type { RepeatRule, Schedule } from '../../../shared/types';
import type { ConflictRef } from '../../../shared/conflicts';
import ConflictTag from '../ConflictTag';

const { Text } = Typography;

interface ScheduleListProps {
  date: Date;
  /** 已按日期过滤并按开始时间排序的日程列表 */
  schedules: Schedule[];
  /** 撞课标记：日程 id → 冲突课程列表 */
  conflicts?: Map<string, ConflictRef[]>;
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

export default function ScheduleList({ date, schedules, conflicts, onAdd, onEdit }: ScheduleListProps) {
  const dateStr = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;

  // 取语义 token 而非写死色值：写死的边框/文字色在暗色模式下不可读，写死的 #1677ff 也不跟随主题主色
  const {
    token: { colorBorderSecondary, colorTextTertiary, colorPrimary },
  } = theme.useToken();

  // 条目是 div 不是 button，需手动补键盘触发，否则纯键盘用户无法进入编辑
  const handleItemKeyDown = (e: KeyboardEvent<HTMLDivElement>, schedule: Schedule) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); // 阻止空格滚动页面
      onEdit(schedule);
    }
  };

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
              onKeyDown={(e) => handleItemKeyDown(e, s)}
              role="button"
              tabIndex={0}
              style={{
                padding: '8px 12px',
                border: `1px solid ${colorBorderSecondary}`,
                borderRadius: 6,
                cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = colorPrimary;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = colorBorderSecondary;
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
                <span>
                  <Tag color="blue">{REPEAT_LABELS[s.repeatRule]}</Tag>
                  <ConflictTag refs={conflicts?.get(s.id) ?? []} />
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  marginTop: 4,
                  color: colorTextTertiary,
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
