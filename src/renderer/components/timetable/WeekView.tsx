// 课程表周视图组件：7 列网格 + 左侧节次标尺 + 顶部周次切换。
// 课程卡片按颜色背景渲染（半透明），参考 Wake Up 课程表样式。
// 点击空白单元格触发 onAdd(weekday, period)，点击课程卡片触发 onEdit(course)。
import { useMemo, useState, type CSSProperties } from "react";
import { Button, InputNumber, Typography, theme } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { Course, Weekday } from "../../../shared/types";
import type { ConflictRef } from "../../../shared/conflicts";

const { Text } = Typography;

// 周一为一周开始，表头顺序：一、二、三、四、五、六、日
const WEEKDAY_LABELS: string[] = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAY_NUMBERS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

interface WeekViewProps {
  courses: Course[];
  currentWeek: number;
  semesterStart?: string | null;
  onWeekChange: (w: number) => void;
  onEdit: (c: Course) => void;
  onAdd: (weekday: Weekday, period: number) => void;
  /** 节次总数，决定左侧标尺行数；默认 12 */
  periodCount: number;
  /** 撞课标记：课程 id → 当前周的冲突列表（课程互撞 + 跨板块） */
  conflicts?: Map<string, ConflictRef[]>;
}

interface WeekDate {
  month: string;
  day: string;
  iso: string;
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekDates(
  semesterStart: string | null | undefined,
  week: number,
): WeekDate[] | null {
  if (!semesterStart) return null;
  const start = parseLocalDate(semesterStart);
  if (!start) return null;
  start.setDate(start.getDate() + (week - 1) * 7);
  return WEEKDAY_NUMBERS.map((_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      month: `${date.getMonth() + 1}月`,
      day: String(date.getDate()),
      iso: formatIsoDate(date),
    };
  });
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
  semesterStart,
  onWeekChange,
  onEdit,
  onAdd,
  periodCount,
  conflicts,
}: WeekViewProps) {
  const [previousWeek, setPreviousWeek] = useState(currentWeek);
  const [animationKey, setAnimationKey] = useState(0);
  // 仅渲染当前周生效的课程（startWeek <= currentWeek <= endWeek）
  const visibleCourses = useMemo(() => {
    return courses.filter(
      (c) => currentWeek >= c.startWeek && currentWeek <= c.endWeek,
    );
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

  const weekDates = useMemo(
    () => getWeekDates(semesterStart, currentWeek),
    [semesterStart, currentWeek],
  );
  const weekRangeLabel = weekDates
    ? `${weekDates[0].month}${weekDates[0].day}日 – ${weekDates[6].month}${weekDates[6].day}日`
    : "请先在设置中填写学期起始日期";

  // 颜色一律取主题 token：写死浅色会让暗色模式与背景图/亚克力模式下表头变白条、文字读不清
  const {
    token: {
      colorFillQuaternary,
      colorBorderSecondary,
      colorText,
      colorTextTertiary,
    },
  } = theme.useToken();
  const gridBorder = `1px solid ${colorBorderSecondary}`;

  // 网格布局：第一列节次标尺（48px），其后 7 列等宽
  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `48px repeat(7, 1fr)`,
    border: gridBorder,
    borderRadius: 6,
    overflow: "hidden",
  };
  const headerCellStyle: CSSProperties = {
    padding: "8px 0",
    textAlign: "center",
    background: colorFillQuaternary,
    borderBottom: gridBorder,
    borderRight: gridBorder,
    fontWeight: 600,
    color: colorText,
  };
  const periodLabelStyle: CSSProperties = {
    padding: "4px 0",
    textAlign: "center",
    background: colorFillQuaternary,
    borderBottom: gridBorder,
    borderRight: gridBorder,
    fontSize: 12,
    color: colorTextTertiary,
  };
  const cellStyle: CSSProperties = {
    borderBottom: gridBorder,
    borderRight: gridBorder,
    minHeight: 48,
    cursor: "pointer",
    position: "relative",
    padding: 2,
  };

  const changeWeek = (nextWeek: number): void => {
    if (nextWeek === currentWeek) return;
    setPreviousWeek(currentWeek);
    setAnimationKey((value) => value + 1);
    onWeekChange(nextWeek);
  };
  const handlePrevWeek = () => changeWeek(Math.max(1, currentWeek - 1));
  const handleNextWeek = () => changeWeek(Math.min(30, currentWeek + 1));
  const handleInputWeekChange = (value: number | null): void => {
    if (value) changeWeek(value);
  };
  const animationDirection = currentWeek >= previousWeek ? "next" : "previous";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 周次切换控件 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
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
          onChange={handleInputWeekChange}
          size="small"
          style={{ width: 64 }}
        />
        <Text strong>周</Text>
        <Button
          icon={<RightOutlined />}
          onClick={handleNextWeek}
          size="small"
        />
        <Text className="timetable-week-range" type="secondary">
          {weekRangeLabel}
        </Text>
      </div>

      {/* 课表网格 */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <div
          key={animationKey}
          className={`timetable-grid-motion timetable-grid-motion-${animationDirection}`}
          style={gridStyle}
        >
          {/* 表头第一格（左上角空白） */}
          <div style={headerCellStyle} />
          {WEEKDAY_LABELS.map((label, index) => (
            <div key={label} style={headerCellStyle}>
              <span>周{label}</span>
              {weekDates && (
                <span className="timetable-date-label">
                  {weekDates[index].month}
                  {weekDates[index].day}日
                </span>
              )}
            </div>
          ))}
          {/* 每行：节次标尺 + 7 个时段单元格 */}
          {periodNumbers.map((period) => (
            <WeekRow
              key={period}
              period={period}
              courseMap={courseMap}
              conflicts={conflicts}
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
  conflicts?: Map<string, ConflictRef[]>;
  periodLabelStyle: CSSProperties;
  cellStyle: CSSProperties;
  onEdit: (c: Course) => void;
  onAdd: (weekday: Weekday, period: number) => void;
}

function WeekRow({
  period,
  courseMap,
  conflicts,
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
              <CourseCard
                key={c.id}
                course={c}
                refs={conflicts?.get(c.id) ?? []}
                onEdit={onEdit}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/** 课程卡片：颜色背景 + 半透明，显示课程名/地点/教师；撞课时右上角红色警示角标 */
interface CourseCardProps {
  course: Course;
  refs: ConflictRef[];
  onEdit: (c: Course) => void;
}

function CourseCard({ course, refs, onEdit }: CourseCardProps) {
  const background = hexToRgba(course.color, 0.25);
  const borderLeft = `3px solid ${course.color}`;
  // 卡片底色是课程色半透明，暗色下写死的灰字几乎与底色同亮度，必须跟随主题 token
  const {
    token: { colorTextSecondary, colorTextTertiary, colorError },
  } = theme.useToken();
  const conflictLines = refs.map((r) => `撞课：与 ${r.label}（${r.detail}）`);
  const title = [
    course.name,
    course.teacher ?? "",
    course.location ?? "",
    ...conflictLines,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      style={{
        background,
        borderLeft,
        borderRadius: 4,
        padding: "4px 6px",
        fontSize: 12,
        cursor: "pointer",
        marginBottom: 2,
        overflow: "hidden",
        position: "relative",
      }}
      onClick={(e) => {
        e.stopPropagation();
        onEdit(course);
      }}
      title={title}
    >
      {refs.length > 0 && (
        <span
          aria-label={`撞课：${refs.length} 处`}
          style={{ position: "absolute", top: 2, right: 4, color: colorError }}
        >
          <WarningOutlined />
        </span>
      )}
      <div
        style={{
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {course.name}
      </div>
      {course.location && (
        <div
          style={{
            color: colorTextSecondary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {course.location}
        </div>
      )}
      {course.teacher && (
        <div
          style={{
            color: colorTextTertiary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {course.teacher}
        </div>
      )}
    </div>
  );
}
