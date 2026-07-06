// 实验 DOM 与 OCR 结果冲突比对 UI
// 按 (name, date) 匹配实验槽位，高亮差异字段（红色边框）。
// 用户每行可选 DOM 版本/OCR 版本/手动修改，确认后回传统一后的 ParsedLab[]。
import { useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Input, Modal, Radio, Table, TimePicker, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { ParsedLab } from '../../../shared/types';

const { Text } = Typography;

interface LabConflictResolverProps {
  open: boolean;
  domLabs: ParsedLab[];
  ocrLabs: ParsedLab[];
  onConfirm: (labs: ParsedLab[]) => void;
  onCancel: () => void;
}

type Choice = 'dom' | 'ocr' | 'manual';

interface SlotRow {
  key: string;
  dom?: ParsedLab;
  ocr?: ParsedLab;
  choice: Choice;
  manual: ParsedLab;
}

/** 生成 slot key：同 (name, date) 视为同一实验 */
function slotKey(l: ParsedLab): string {
  return `${l.name ?? ''}-${l.date ?? ''}`;
}

/** 比较两个 ParsedLab 的字段差异 */
function diffFields(a?: ParsedLab, b?: ParsedLab): string[] {
  if (!a || !b) return [];
  const fields: (keyof ParsedLab)[] = ['name', 'date', 'startTime', 'endTime', 'location', 'instructor', 'notes'];
  const diffs: string[] = [];
  for (const f of fields) {
    if (a[f] !== b[f]) diffs.push(f);
  }
  return diffs;
}

export default function LabConflictResolver({
  open,
  domLabs,
  ocrLabs,
  onConfirm,
  onCancel,
}: LabConflictResolverProps) {
  const [slots, setSlots] = useState<SlotRow[]>([]);

  useEffect(() => {
    if (!open) return;
    const map = new Map<string, SlotRow>();
    for (const l of domLabs) {
      const k = slotKey(l);
      const row: SlotRow = map.get(k) ?? {
        key: k,
        choice: 'dom' as Choice,
        manual: { ...l },
      };
      row.dom = l;
      map.set(k, row);
    }
    for (const l of ocrLabs) {
      const k = slotKey(l);
      const row: SlotRow = map.get(k) ?? {
        key: k,
        choice: 'ocr' as Choice,
        manual: { ...l },
      };
      row.ocr = l;
      if (!row.dom) row.choice = 'ocr';
      map.set(k, row);
    }
    setSlots(Array.from(map.values()));
  }, [open, domLabs, ocrLabs]);

  const handleChoiceChange = (key: string, choice: Choice) => {
    setSlots((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        const base = choice === 'dom' ? row.dom : choice === 'ocr' ? row.ocr : row.manual;
        return { ...row, choice, manual: { ...(base ?? {}) } };
      })
    );
  };

  const handleManualChange = (key: string, patch: Partial<ParsedLab>) => {
    setSlots((prev) =>
      prev.map((row) => (row.key === key ? { ...row, manual: { ...row.manual, ...patch } } : row))
    );
  };

  const handleConfirm = () => {
    for (const row of slots) {
      const final = pickFinal(row);
      if (!final.name) {
        message.error(`存在实验名为空的实验，请检查`);
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
        render: (_, row) => <LabText lab={row.dom} diffAgainst={row.ocr} />,
      },
      {
        title: 'OCR 版本',
        key: 'ocr',
        render: (_, row) => <LabText lab={row.ocr} diffAgainst={row.dom} />,
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
      title="实验 DOM 与 OCR 结果冲突比对"
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

function pickFinal(row: SlotRow): ParsedLab {
  if (row.choice === 'dom') return row.dom ?? row.manual;
  if (row.choice === 'ocr') return row.ocr ?? row.manual;
  return row.manual;
}

function LabText({ lab, diffAgainst }: { lab?: ParsedLab; diffAgainst?: ParsedLab }) {
  if (!lab) return <Text type="secondary">—</Text>;
  const diffs = diffFields(lab, diffAgainst);
  const style = (field: keyof ParsedLab): React.CSSProperties =>
    diffs.includes(field as string)
      ? { border: '1px solid #ff4d4f', padding: '0 4px', borderRadius: 3, margin: 1 }
      : { padding: '0 4px', margin: 1 };
  return (
    <div style={{ fontSize: 12 }}>
      <div>
        <span style={style('name')}>{lab.name ?? '—'}</span>
      </div>
      <div style={{ color: '#666' }}>
        <span style={style('date')}>{lab.date ?? '?'}</span>
        <span style={style('startTime')}>{lab.startTime ?? '?'}</span>
        <span>-</span>
        <span style={style('endTime')}>{lab.endTime ?? '?'}</span>
      </div>
      <div style={{ color: '#888' }}>
        {lab.location && <span style={style('location')}>@{lab.location}</span>}
        {lab.instructor && <span style={style('instructor')}>{lab.instructor}</span>}
      </div>
    </div>
  );
}

interface ManualEditorProps {
  row: SlotRow;
  disabled: boolean;
  onChange: (patch: Partial<ParsedLab>) => void;
}

function ManualEditor({ row, disabled, onChange }: ManualEditorProps) {
  const m = row.manual;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Input
        size="small"
        placeholder="实验名"
        value={m.name}
        disabled={disabled}
        onChange={(e) => onChange({ name: e.target.value })}
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
          placeholder="教师"
          value={m.instructor}
          disabled={disabled}
          onChange={(e) => onChange({ instructor: e.target.value })}
          style={{ width: 100 }}
        />
      </div>
    </div>
  );
}
