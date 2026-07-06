// 考试 DOM 与 OCR 结果冲突比对 UI
// 按 (courseName, date) 匹配考试槽位，高亮差异字段（红色边框）。
// 用户每行可选 DOM 版本/OCR 版本/手动修改，确认后回传统一后的 ParsedExam[]。
import { useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Input, Modal, Radio, Table, TimePicker, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { ParsedExam } from '../../../shared/types';

const { Text } = Typography;

interface ExamConflictResolverProps {
  open: boolean;
  domExams: ParsedExam[];
  ocrExams: ParsedExam[];
  onConfirm: (exams: ParsedExam[]) => void;
  onCancel: () => void;
}

type Choice = 'dom' | 'ocr' | 'manual';

interface SlotRow {
  key: string;
  dom?: ParsedExam;
  ocr?: ParsedExam;
  choice: Choice;
  manual: ParsedExam;
}

/** 生成 slot key：同 (courseName, date) 视为同一考试 */
function slotKey(e: ParsedExam): string {
  return `${e.courseName ?? ''}-${e.date ?? ''}`;
}

/** 比较两个 ParsedExam 的字段差异 */
function diffFields(a?: ParsedExam, b?: ParsedExam): string[] {
  if (!a || !b) return [];
  const fields: (keyof ParsedExam)[] = ['courseName', 'date', 'startTime', 'endTime', 'location', 'seat', 'notes'];
  const diffs: string[] = [];
  for (const f of fields) {
    if (a[f] !== b[f]) diffs.push(f);
  }
  return diffs;
}

export default function ExamConflictResolver({
  open,
  domExams,
  ocrExams,
  onConfirm,
  onCancel,
}: ExamConflictResolverProps) {
  const [slots, setSlots] = useState<SlotRow[]>([]);

  // 每次 open 或数据变化时重建槽位
  useEffect(() => {
    if (!open) return;
    const map = new Map<string, SlotRow>();
    for (const e of domExams) {
      const k = slotKey(e);
      const row: SlotRow = map.get(k) ?? {
        key: k,
        choice: 'dom' as Choice,
        manual: { ...e },
      };
      row.dom = e;
      map.set(k, row);
    }
    for (const e of ocrExams) {
      const k = slotKey(e);
      const row: SlotRow = map.get(k) ?? {
        key: k,
        choice: 'ocr' as Choice,
        manual: { ...e },
      };
      row.ocr = e;
      // 仅有 OCR 版本时默认选 OCR
      if (!row.dom) row.choice = 'ocr';
      map.set(k, row);
    }
    setSlots(Array.from(map.values()));
  }, [open, domExams, ocrExams]);

  const handleChoiceChange = (key: string, choice: Choice) => {
    setSlots((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        const base = choice === 'dom' ? row.dom : choice === 'ocr' ? row.ocr : row.manual;
        return { ...row, choice, manual: { ...(base ?? {}) } };
      })
    );
  };

  const handleManualChange = (key: string, patch: Partial<ParsedExam>) => {
    setSlots((prev) =>
      prev.map((row) => (row.key === key ? { ...row, manual: { ...row.manual, ...patch } } : row))
    );
  };

  const handleConfirm = () => {
    for (const row of slots) {
      const final = pickFinal(row);
      if (!final.courseName) {
        message.error(`存在课程名为空的考试，请检查`);
        return;
      }
    }
    onConfirm(slots.map(pickFinal));
  };

  const columns: ColumnsType<SlotRow> = useMemo(
    () => [
      {
        title: 'DOM 版本',
        key: 'dom',
        render: (_, row) => <ExamText exam={row.dom} diffAgainst={row.ocr} />,
      },
      {
        title: 'OCR 版本',
        key: 'ocr',
        render: (_, row) => <ExamText exam={row.ocr} diffAgainst={row.dom} />,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slots]
  );

  return (
    <Modal
      open={open}
      title="考试 DOM 与 OCR 结果冲突比对"
      onCancel={onCancel}
      width={960}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="confirm" type="primary" onClick={handleConfirm}>
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

/** 根据 choice 取最终考试 */
function pickFinal(row: SlotRow): ParsedExam {
  if (row.choice === 'dom') return row.dom ?? row.manual;
  if (row.choice === 'ocr') return row.ocr ?? row.manual;
  return row.manual;
}

/** 渲染考试文本，差异字段用红色边框高亮 */
function ExamText({ exam, diffAgainst }: { exam?: ParsedExam; diffAgainst?: ParsedExam }) {
  if (!exam) return <Text type="secondary">—</Text>;
  const diffs = diffFields(exam, diffAgainst);
  const style = (field: keyof ParsedExam): React.CSSProperties =>
    diffs.includes(field as string)
      ? { border: '1px solid #ff4d4f', padding: '0 4px', borderRadius: 3, margin: 1 }
      : { padding: '0 4px', margin: 1 };
  return (
    <div style={{ fontSize: 12 }}>
      <div>
        <span style={style('courseName')}>{exam.courseName ?? '—'}</span>
      </div>
      <div style={{ color: '#666' }}>
        <span style={style('date')}>{exam.date ?? '?'}</span>
        <span style={style('startTime')}>{exam.startTime ?? '?'}</span>
        <span>-</span>
        <span style={style('endTime')}>{exam.endTime ?? '?'}</span>
      </div>
      <div style={{ color: '#888' }}>
        {exam.location && <span style={style('location')}>@{exam.location}</span>}
        {exam.seat && <span style={style('seat')}>座位:{exam.seat}</span>}
      </div>
    </div>
  );
}

/** 手动修改编辑器 */
interface ManualEditorProps {
  row: SlotRow;
  disabled: boolean;
  onChange: (patch: Partial<ParsedExam>) => void;
}

function ManualEditor({ row, disabled, onChange }: ManualEditorProps) {
  const m = row.manual;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Input
        size="small"
        placeholder="课程名"
        value={m.courseName}
        disabled={disabled}
        onChange={(e) => onChange({ courseName: e.target.value })}
      />
      <div style={{ display: 'flex', gap: 4 }}>
        <DatePicker
          size="small"
          placeholder="日期"
          value={m.date ? dayjs(m.date) : null}
          disabled={disabled}
          format="YYYY-MM-DD"
          onChange={(v) => onChange({ date: v ? v.format('YYYY-MM-DD') : undefined })}
          style={{ width: 140 }}
        />
        <TimePicker
          size="small"
          placeholder="开始"
          value={m.startTime ? dayjs(m.startTime, 'HH:mm') : null}
          disabled={disabled}
          format="HH:mm"
          minuteStep={5}
          onChange={(v) => onChange({ startTime: v ? v.format('HH:mm') : undefined })}
          style={{ width: 90 }}
        />
        <TimePicker
          size="small"
          placeholder="结束"
          value={m.endTime ? dayjs(m.endTime, 'HH:mm') : null}
          disabled={disabled}
          format="HH:mm"
          minuteStep={5}
          onChange={(v) => onChange({ endTime: v ? v.format('HH:mm') : undefined })}
          style={{ width: 90 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <Input
          size="small"
          placeholder="地点"
          value={m.location}
          disabled={disabled}
          onChange={(e) => onChange({ location: e.target.value })}
        />
        <Input
          size="small"
          placeholder="座位"
          value={m.seat}
          disabled={disabled}
          onChange={(e) => onChange({ seat: e.target.value })}
          style={{ width: 80 }}
        />
      </div>
    </div>
  );
}
