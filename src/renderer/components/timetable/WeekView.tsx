// 课程表周视图组件：7 列网格 + 左侧节次标尺 + 顶部周次切换。
// 课程卡片按颜色背景渲染（半透明），参考 Wake Up 课程表样式。
// 点击空白单元格触发 onAdd(weekday, period)，点击课程卡片触发 onEdit(course)。
import { useMemo, type CSSProperties } from 'react';
import { Button, InputNumber, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import type { Course, Weekday } from '../../../shared/types';

const { Text } = Typography;

// 周一为一周开始，表头顺序：一、二、三、四、五、六、日
const WEEKDAY_LABELS: string[] = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_NUMBERS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

interface WeekViewProps {
  courses: Course[];
  currentWeek: number;
  onWeekChange: (w: number) => void;
  onEdit: (c: Course) => void;
  onAdd: (weekday: Weekday, period: number) => void;
  /** 节次总数，决定左侧标尺行数；默认 12 */
  periodCount: number;
}

/** 将十六进制颜色转为 rgba(r,g,b,a) 形式，便于卡片背景做透明度处理 */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const r = Number.parseInt(m[1].substring(0, 2), 16);
  const g = Number.parseInt(m[1].substring(2, 4), 16);
  const b = Number.parseInt(m[1].substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function WeekView({
  courses,
  currentWeek,
  onWeekChange,
  onEdit,
  onAdd,
  periodCount,
}: WeekViewProps) {
  // 仅渲染当前周生效的课程（startWeek <= currentWeek <= endWeek）
  const visibleCourses = useMemo(() => {
    return courses.filter((c) => currentWeek >= c.startWeek && currentWeek <= c.endWeek);
  }, [courses, currentWeek]);

  // 按 (weekday, startPeriod) 索引，便于单元格快速查找；同一时段可能多门课程（理论上不应有，但容错）
  const courseMap = useMemo(() => {
    const map = new Map<string, Course[]>();
    for (const c of visibleCourses) {
      const key = `${c.weekday}-${c.startPeriod}`;
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [visibleCourses]);

  const periodNumbers = useMemo(() => {
    return Array.from({ length: periodCount }, (_, i) => i + 1);
  }, [periodCount]);

  // 网格布局：第一列节次标尺（48px），其后 7 列等宽
  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `48px repeat(7, 1fr)`,
    border: '1px solid #f0f0f0',
    borderRadius: 6,
    overflow: 'hidden',
  };
  const headerCellStyle: CSSProperties = {
    padding: '8px 0',
    textAlign: 'center',
    background: '#fafafa',
    borderBottom: '1px solid #f0f0f0',
    borderRight: '1px solid #f0f0f0',
    fontWeight: 600,
  };
  const periodLabelStyle: CSSProperties = {
    padding: '4px 0',
    textAlign: 'center',
    background: '#fafafa',
    borderBottom: '1px solid #f0f0f0',
    borderRight: '1px solid #f0f0f0',
    fontSize: 12,
    color: '#888',
  };
  const cellStyle: CSSProperties = {
    borderBottom: '1px solid #f0f0f0',
    borderRight: '1px solid #f0f0f0',
    minHeight: 48,
    cursor: 'pointer',
    position: 'relative',
    padding: 2,
  };

  const handlePrevWeek = () => onWeekChange(Math.max(1, currentWeek - 1));
  const handleNextWeek = () => onWeekChange(Math.min(30, currentWeek + 1));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 周次切换控件 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Button icon={<LeftOutlined />} onClick={handlePrevWeek} size="small" />
        <Text strong>第</Text>
        <InputNumber
          min={1}
          max={30}
          value={currentWeek}
          onChange={(v) => v && onWeekChange(v)}
          size="small"
          style={{ width: 64 }}
        />
        <Text strong>周</Text>
        <Button icon={<RightOutlined />} onClick={handleNextWeek} size="small" />
      </div>

      {/* 课表网格 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={gridStyle}>
          {/* 表头第一格（左上角空白） */}
          <div style={headerCellStyle} />
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} style={headerCellStyle}>
              周{label}
            </div>
          ))}
          {/* 每行：节次标尺 + 7 个时段单元格 */}
          {periodNumbers.map((period) => (
            <WeekRow
              key={period}
              period={period}
              courseMap={courseMap}
              periodLabelStyle={periodLabelStyle}
              cellStyle={cellStyle}
              onEdit={onEdit}
              onAdd={onAdd}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 单行：节次标尺 + 7 个时段单元格 */
interface WeekRowProps {
  period: number;
  courseMap: Map<string, Course[]>;
  periodLabelStyle: CSSProperties;
  cellStyle: CSSProperties;
  onEdit: (c: Course) => void;
  onAdd: (weekday: Weekday, period: number) => void;
}

function WeekRow({
  period,
  courseMap,
  periodLabelStyle,
  cellStyle,
  onEdit,
  onAdd,
}: WeekRowProps) {
  return (
    <>
      <div style={periodLabelStyle}>{period}</div>
      {WEEKDAY_NUMBERS.map((weekday) => {
        const key = `${weekday}-${period}`;
        const cellCourses = courseMap.get(key) ?? [];
        return (
          <div
            key={key}
            style={cellStyle}
            onClick={(e) => {
              // 点击空白处新增；点击课程卡片时由卡片自身 stopPropagation 后触发 onEdit
              if (e.target === e.currentTarget) onAdd(weekday, period);
            }}
          >
            {cellCourses.map((c) => (
              <CourseCard key={c.id} course={c} onEdit={onEdit} />
            ))}
          </div>
        );
      })}
    </>
  );
}

/** 课程卡片：颜色背景 + 半透明，显示课程名/地点/教师 */
interface CourseCardProps {
  course: Course;
  onEdit: (c: Course) => void;
}

function CourseCard({ course, onEdit }: CourseCardProps) {
  const background = hexToRgba(course.color, 0.25);
  const borderLeft = `3px solid ${course.color}`;
  return (
    <div
      style={{
        background,
        borderLeft,
        borderRadius: 4,
        padding: '4px 6px',
        fontSize: 12,
        cursor: 'pointer',
        marginBottom: 2,
        overflow: 'hidden',
      }}
      onClick={(e) => {
        e.stopPropagation();
        onEdit(course);
      }}
      title={`${course.name}\n${course.teacher ?? ''}\n${course.location ?? ''}`}
    >
      <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {course.name}
      </div>
      {course.location && (
        <div style={{ color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {course.location}
        </div>
      )}
      {course.teacher && (
        <div style={{ color: '#777', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {course.teacher}
        </div>
      )}
    </div>
  );
}
