// DOM 与 OCR 结果冲突比对 UI
// 按 (weekday, startPeriod) 匹配课程槽位，高亮差异字段（红色边框）。
// 用户每行可选 DOM 版本/OCR 版本/手动修改，确认后回传统一后的 ParsedCourse[]。
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, InputNumber, Modal, Radio, Select, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ParsedCourse, Weekday } from '../../../shared/types';

const { Text } = Typography;

interface ConflictResolverProps {
  open: boolean;
  domCourses: ParsedCourse[];
  ocrCourses: ParsedCourse[];
  submitting?: boolean;
  onConfirm: (courses: ParsedCourse[]) => void;
  onCancel: () => void;
}

type Choice = 'dom' | 'ocr' | 'manual';

interface SlotRow {
  key: string;
  weekday?: number;
  startPeriod?: number;
  dom?: ParsedCourse;
  ocr?: ParsedCourse;
  choice: Choice;
  manual: ParsedCourse;
}

const WEEKDAY_OPTIONS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 },
];

/** 生成 slot key：同 (weekday, startPeriod) 视为同一槽位 */
function slotKey(c: ParsedCourse): string {
  return `${c.weekday ?? 0}-${c.startPeriod ?? 0}`;
}

/**
 * 该条目能否定位到具体槽位。
 * OCR 链路只在文本里出现「周X」时才填 weekday、出现「第X节」时才填 startPeriod
 * （见 OcrService.parseLine），而课表截图的表头是「星期一」不含「周」字，
 * 表头行、被切碎的教师/地点行都会以「只有 name」的形态进入结果，
 * 这类条目全部落在同一个兜底 key 上，并不代表真的同处一格。
 */
function isLocatable(c: ParsedCourse): boolean {
  return typeof c.weekday === 'number' && typeof c.startPeriod === 'number';
}

/**
 * 按槽位分桶，桶内保持解析器输出顺序。
 * 解析器会把一个单元格里的多门课（如「1-8周高数 / 9-16周线代」）拆成多条，
 * 且段内没写「第X-Y节」时会统一回落到同一个节次，因此同一 key 天然可能对应多条课程，
 * 用 Map<key, 单条> 存会互相覆盖并静默丢课。
 */
function groupBySlot(list: ParsedCourse[]): Map<string, ParsedCourse[]> {
  const map = new Map<string, ParsedCourse[]>();
  for (const c of list) {
    const k = slotKey(c);
    const bucket = map.get(k);
    if (bucket) bucket.push(c);
    else map.set(k, [c]);
  }
  return map;
}

/** 比较两个 ParsedCourse 的字段差异，返回差异字段名列表 */
function diffFields(a?: ParsedCourse, b?: ParsedCourse): string[] {
  if (!a || !b) return [];
  const fields: (keyof ParsedCourse)[] = ['name', 'teacher', 'location', 'startWeek', 'endWeek', 'weekday', 'startPeriod', 'endPeriod'];
  const diffs: string[] = [];
  for (const f of fields) {
    const va = a[f];
    const vb = b[f];
    if (va !== vb) diffs.push(f);
  }
  return diffs;
}

export default function ConflictResolver({
  open,
  domCourses,
  ocrCourses,
  submitting = false,
  onConfirm,
  onCancel,
}: ConflictResolverProps) {
  const [slots, setSlots] = useState<SlotRow[]>([]);

  // 每次 open 或数据变化时重建槽位
  useEffect(() => {
    if (!open) return;
    const domBuckets = groupBySlot(domCourses);
    const ocrBuckets = groupBySlot(ocrCourses);
    // key 顺序：先 DOM 出现过的槽位，再补只有 OCR 的槽位
    const keys = new Set([...domBuckets.keys(), ...ocrBuckets.keys()]);
    const rows: SlotRow[] = [];
    for (const base of keys) {
      const doms = domBuckets.get(base) ?? [];
      const ocrs = ocrBuckets.get(base) ?? [];
      // 同槽位内两条链路各按出现顺序 zip 配对，数量不等的多余条目单独成行，避免任何一条被丢弃。
      // 但只对「能定位到具体格子」的桶这么做：定位缺失的条目共用一个兜底 key，
      // 展开它们等于把 OCR 噪声逐条送进写库循环（弹窗没有「不导入」选项，
      // 且 TimetablePage 会把缺失字段兜底成周一第 1 节），故仍折叠成一行。
      const sample = doms[0] ?? ocrs[0];
      const count = sample && isLocatable(sample) ? Math.max(doms.length, ocrs.length) : 1;
      for (let i = 0; i < count; i++) {
        const dom: ParsedCourse | undefined = doms[i];
        const ocr: ParsedCourse | undefined = ocrs[i];
        // count 取两者最大长度，i < count 时至少有一侧存在
        const source = dom ?? (ocr as ParsedCourse);
        rows.push({
          // 行内序号保证 key 唯一，否则 Table rowKey 冲突且同格多课会互相覆盖
          key: `${base}#${i}`,
          weekday: source.weekday,
          startPeriod: source.startPeriod,
          dom,
          ocr,
          // 仅有 OCR 版本时默认选 OCR
          choice: dom ? 'dom' : 'ocr',
          // manual 以本行实际采用的版本为副本，避免与 DOM/OCR 列显示的课程对不上
          manual: { ...source },
        });
      }
    }
    setSlots(rows);
  }, [open, domCourses, ocrCourses]);

  const handleChoiceChange = (key: string, choice: Choice) => {
    setSlots((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        // 切换到 dom/ocr 时同步 manual 为对应版本，便于后续切到 manual 编辑
        const base = choice === 'dom' ? row.dom : choice === 'ocr' ? row.ocr : row.manual;
        return { ...row, choice, manual: { ...(base ?? {}) } };
      })
    );
  };

  const handleManualChange = (key: string, patch: Partial<ParsedCourse>) => {
    setSlots((prev) =>
      prev.map((row) => (row.key === key ? { ...row, manual: { ...row.manual, ...patch } } : row))
    );
  };

  const handleConfirm = () => {
    // 校验：所有行必须有课程名
    for (const row of slots) {
      const final = pickFinal(row);
      if (!final.name) {
        message.error(`第${row.weekday ?? '?'}天第${row.startPeriod ?? '?'}节课程名为空`);
        return;
      }
    }
    onConfirm(slots.map(pickFinal));
  };

  const columns: ColumnsType<SlotRow> = useMemo(
    () => [
      {
        title: '星期',
        dataIndex: 'weekday',
        width: 80,
        render: (_, row) => <Text>{WEEKDAY_OPTIONS.find((w) => w.value === row.weekday)?.label ?? row.weekday}</Text>,
      },
      {
        title: '节次',
        dataIndex: 'startPeriod',
        width: 60,
        render: (_, row) => <Text>{row.startPeriod}</Text>,
      },
      {
        title: 'DOM 版本',
        key: 'dom',
        render: (_, row) => <CourseText course={row.dom} diffAgainst={row.ocr} />,
      },
      {
        title: 'OCR 版本',
        key: 'ocr',
        render: (_, row) => <CourseText course={row.ocr} diffAgainst={row.dom} />,
      },
      {
        title: '选择',
        key: 'choice',
        width: 120,
        render: (_, row) => (
          <Radio.Group
            value={row.choice}
            onChange={(e) => handleChoiceChange(row.key, e.target.value as Choice)}
            size="small"
          >
            <Radio value="dom" disabled={!row.dom}>
              DOM
            </Radio>
            <Radio value="ocr" disabled={!row.ocr}>
              OCR
            </Radio>
            <Radio value="manual">手动</Radio>
          </Radio.Group>
        ),
      },
      {
        title: '手动修改',
        key: 'manual',
        render: (_, row) => (
          <ManualEditor
            row={row}
            disabled={row.choice !== 'manual'}
            onChange={(patch) => handleManualChange(row.key, patch)}
          />
        ),
      },
    ],
    [slots]
  );

  return (
    <Modal
      open={open}
      title="DOM 与 OCR 结果冲突比对"
      onCancel={onCancel}
      width={960}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={submitting}>
          取消
        </Button>,
        <Button key="confirm" type="primary" onClick={handleConfirm} loading={submitting} disabled={submitting}>
          确认导入
        </Button>,
      ]}
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        红色边框字段为 DOM 与 OCR 不一致的字段，请逐行选择采用哪个版本或手动修改。
      </Text>
      <Table
        columns={columns}
        dataSource={slots}
        rowKey="key"
        pagination={false}
        size="small"
        scroll={{ y: 400 }}
      />
    </Modal>
  );
}

/** 根据 choice 取最终课程 */
function pickFinal(row: SlotRow): ParsedCourse {
  if (row.choice === 'dom') return row.dom ?? row.manual;
  if (row.choice === 'ocr') return row.ocr ?? row.manual;
  return row.manual;
}

/** 渲染课程文本，差异字段用红色边框高亮 */
function CourseText({ course, diffAgainst }: { course?: ParsedCourse; diffAgainst?: ParsedCourse }) {
  if (!course) return <Text type="secondary">—</Text>;
  const diffs = diffFields(course, diffAgainst);
  const style = (field: keyof ParsedCourse): React.CSSProperties =>
    diffs.includes(field as string)
      ? { border: '1px solid #ff4d4f', padding: '0 4px', borderRadius: 3, margin: 1 }
      : { padding: '0 4px', margin: 1 };
  return (
    <div style={{ fontSize: 12 }}>
      <div>
        <span style={style('name')}>{course.name ?? '—'}</span>
      </div>
      <div style={{ color: '#666' }}>
        {course.teacher && <span style={style('teacher')}>{course.teacher}</span>}
        {course.location && <span style={style('location')}>@{course.location}</span>}
      </div>
      <div style={{ color: '#888' }}>
        <span style={style('startWeek')}>{course.startWeek ?? '?'}</span>
        <span>-</span>
        <span style={style('endWeek')}>{course.endWeek ?? '?'}</span>
        <span>周</span>
        {course.startPeriod && (
          <>
            <span style={style('startPeriod')}>{course.startPeriod}</span>
            <span>-</span>
            <span style={style('endPeriod')}>{course.endPeriod}</span>
            <span>节</span>
          </>
        )}
      </div>
    </div>
  );
}

/** 手动修改编辑器：课程名/教师/地点/周次/节次 */
interface ManualEditorProps {
  row: SlotRow;
  disabled: boolean;
  onChange: (patch: Partial<ParsedCourse>) => void;
}

function ManualEditor({ row, disabled, onChange }: ManualEditorProps) {
  const m = row.manual;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Input
        size="small"
        placeholder="课程名"
        value={m.name}
        disabled={disabled}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <div style={{ display: 'flex', gap: 4 }}>
        <Input
          size="small"
          placeholder="教师"
          value={m.teacher}
          disabled={disabled}
          onChange={(e) => onChange({ teacher: e.target.value })}
        />
        <Input
          size="small"
          placeholder="地点"
          value={m.location}
          disabled={disabled}
          onChange={(e) => onChange({ location: e.target.value })}
        />
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <InputNumber
          size="small"
          placeholder="起周"
          min={1}
          max={30}
          value={m.startWeek}
          disabled={disabled}
          onChange={(v) => onChange({ startWeek: v ?? undefined })}
          style={{ width: 70 }}
        />
        <InputNumber
          size="small"
          placeholder="止周"
          min={1}
          max={30}
          value={m.endWeek}
          disabled={disabled}
          onChange={(v) => onChange({ endWeek: v ?? undefined })}
          style={{ width: 70 }}
        />
        <Select
          size="small"
          placeholder="星期"
          value={m.weekday}
          disabled={disabled}
          options={WEEKDAY_OPTIONS}
          onChange={(v: Weekday) => onChange({ weekday: v })}
          style={{ width: 90 }}
        />
        <InputNumber
          size="small"
          placeholder="起节"
          min={1}
          max={20}
          value={m.startPeriod}
          disabled={disabled}
          onChange={(v) => onChange({ startPeriod: v ?? undefined })}
          style={{ width: 60 }}
        />
        <InputNumber
          size="small"
          placeholder="止节"
          min={1}
          max={20}
          value={m.endPeriod}
          disabled={disabled}
          onChange={(v) => onChange({ endPeriod: v ?? undefined })}
          style={{ width: 60 }}
        />
      </div>
    </div>
  );
}
