// 日历视图组件：月历网格，支持月份切换与日程标记。
// 使用 CSS Grid 自实现 7 列 × 6 行日历，周一为一周开始。
// 导出日期工具函数供 SchedulePage 复用（按日期过滤日程、判断重复规则命中）。
import { useMemo, useState, type CSSProperties } from 'react';
import { Button, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import type { Schedule } from '../../../shared/types';

const { Text } = Typography;

// 周一为一周开始，表头顺序：一、二、三、四、五、六、日
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

interface CalendarViewProps {
  schedules: Schedule[];
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
}

/** 格式化日期为 YYYY-MM-DD，用作 Map key 与去重 key */
export function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 判断日程在指定日期是否发生（考虑重复规则）
 * - none: 仅在开始日期当天
 * - daily: 开始日期起每天
 * - weekly: 每周对应星期几（精确匹配 getDay）
 * - monthly: 每月对应日期（月末按精确日期匹配，天数不足的月份不发生）
 */
export function occursOnDate(schedule: Schedule, date: Date): boolean {
  const start = new Date(schedule.startTime);
  // 仅比较日期部分，抹去时间
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  // 目标日期早于开始日期则不发生（重复日程只向后生效）
  if (target.getTime() < startDate.getTime()) return false;

  switch (schedule.repeatRule) {
    case 'none':
      return formatDateKey(target) === formatDateKey(startDate);
    case 'daily':
      return true;
    case 'weekly':
      return target.getDay() === start.getDay();
    case 'monthly':
      return target.getDate() === start.getDate();
    default:
      return false;
  }
}

/** 获取某日的所有日程，按开始时间升序排序 */
export function getSchedulesOnDate(schedules: Schedule[], date: Date): Schedule[] {
  return schedules
    .filter((s) => occursOnDate(s, date))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

/**
 * 计算 6 行 × 7 列的日历网格日期（共 42 天）
 * 周一为一周开始：将 JS getDay()（0=周日..6=周六）转为周一为 0 的序号
 */
function computeCalendarDays(viewDate: Date): Date[] {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  // 周一为 0：getDay() 周一=1 -> 0，周日=0 -> 6
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
  // 网格起始日期（可能是上月末几天）
  const start = new Date(year, month, 1 - firstWeekday);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return days;
}

// 彩色圆点配色，最多显示 3 个
const DOT_COLORS = ['#1677ff', '#52c41a', '#faad14'];

export default function CalendarView({ schedules, selectedDate, onSelectDate }: CalendarViewProps) {
  // viewDate 控制当前显示的月份，初始与 selectedDate 同月
  const [viewDate, setViewDate] = useState(() => new Date(selectedDate));

  const days = useMemo(() => computeCalendarDays(viewDate), [viewDate]);
  const todayKey = formatDateKey(new Date());
  const selectedKey = formatDateKey(selectedDate);

  // 按日期统计日程数量（用于显示彩色圆点）
  const scheduleCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of days) {
      const count = schedules.filter((s) => occursOnDate(s, day)).length;
      if (count > 0) {
        map.set(formatDateKey(day), count);
      }
    }
    return map;
  }, [schedules, days]);

  const handlePrevMonth = () => {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  };
  const handleNextMonth = () => {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
  };
  const handleToday = () => {
    const t = new Date();
    setViewDate(new Date(t.getFullYear(), t.getMonth(), 1));
    onSelectDate(t);
  };

  const handleCellClick = (day: Date) => {
    onSelectDate(new Date(day));
    // 点击相邻月份的日期时切换视图月份，避免选中后高亮不可见
    if (day.getMonth() !== viewDate.getMonth()) {
      setViewDate(new Date(day.getFullYear(), day.getMonth(), 1));
    }
  };

  const title = `${viewDate.getFullYear()}年${viewDate.getMonth() + 1}月`;

  const cellStyle: CSSProperties = {
    minHeight: 80,
    border: '1px solid #f0f0f0',
    padding: 4,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    transition: 'background 0.2s',
  };

  const headerStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    textAlign: 'center',
    marginBottom: 4,
  };

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
  };

  return (
    <div>
      {/* 月份切换控件 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <Text strong style={{ fontSize: 16 }}>
          {title}
        </Text>
        <div>
          <Button
            icon={<LeftOutlined />}
            onClick={handlePrevMonth}
            size="small"
            style={{ marginRight: 4 }}
          />
          <Button size="small" onClick={handleToday}>
            今天
          </Button>
          <Button
            icon={<RightOutlined />}
            onClick={handleNextMonth}
            size="small"
            style={{ marginLeft: 4 }}
          />
        </div>
      </div>
      {/* 周表头 */}
      <div style={headerStyle}>
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} style={{ padding: '4px 0', color: '#888', fontSize: 13 }}>
            {label}
          </div>
        ))}
      </div>
      {/* 日期网格 6×7 */}
      <div style={gridStyle}>
        {days.map((day) => {
          const key = formatDateKey(day);
          const isCurrentMonth = day.getMonth() === viewDate.getMonth();
          const isToday = key === todayKey;
          const isSelected = key === selectedKey;
          const count = scheduleCountByDate.get(key) ?? 0;
          const background = isSelected ? '#e6f4ff' : isToday ? '#fafafa' : '#fff';
          const color = isCurrentMonth ? '#333' : '#bbb';
          return (
            <div
              key={key}
              style={{ ...cellStyle, background, color }}
              onClick={() => handleCellClick(day)}
            >
              <span style={{ fontWeight: isToday ? 600 : 400 }}>{day.getDate()}</span>
              {/* 彩色圆点标记，最多 3 个 */}
              {count > 0 && (
                <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                  {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
                    <span
                      key={i}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: DOT_COLORS[i % DOT_COLORS.length],
                        display: 'inline-block',
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
