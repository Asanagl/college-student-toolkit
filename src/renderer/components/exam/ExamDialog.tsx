// 考试新增/编辑对话框：使用 Ant Design Modal + Form。
// 字段：课程名（必填）、日期、开始/结束时间、地点、座位、备注、多档提醒。
// reminderOffsets 以分钟数组存储，Select multiple 用分钟数作为 tag 值。
import { useEffect } from 'react';
import { Button, DatePicker, Form, Input, Modal, Select, TimePicker, message } from 'antd';
import dayjs from 'dayjs';
import type { Exam } from '../../../shared/types';

interface ExamDialogProps {
  open: boolean;
  /** 编辑模式时传入原考试；新增时为 undefined */
  exam?: Exam;
  onOk: (data: Omit<Exam, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
}

interface FormValues {
  courseName: string;
  date: dayjs.Dayjs;
  startTime: dayjs.Dayjs;
  endTime: dayjs.Dayjs;
  location?: string;
  seat?: string;
  notes?: string;
  reminderOffsets: number[];
}

// 多档提醒预设：值=分钟数，便于直接存入 reminderOffsets
const REMINDER_OPTIONS = [
  { label: '提前1周', value: 10080 },
  { label: '提前3天', value: 4320 },
  { label: '提前1天', value: 1440 },
  { label: '提前3小时', value: 180 },
  { label: '提前1小时', value: 60 },
];

// 默认提醒档位：1天 + 1小时
const DEFAULT_REMINDERS = [1440, 60];

export default function ExamDialog({ open, exam, onOk, onCancel }: ExamDialogProps) {
  const [form] = Form.useForm<FormValues>();
  const isEdit = !!exam;

  // 打开时根据模式预填表单
  useEffect(() => {
    if (!open) return;
    if (exam) {
      form.setFieldsValue({
        courseName: exam.courseName,
        date: dayjs(exam.date),
        startTime: dayjs(`${exam.date} ${exam.startTime}`),
        endTime: dayjs(`${exam.date} ${exam.endTime}`),
        location: exam.location,
        seat: exam.seat,
        notes: exam.notes,
        reminderOffsets: exam.reminderOffsets ?? [],
      });
    } else {
      // 新增默认值：今天 + 09:00-11:00，提前1天+1小时提醒
      const today = dayjs();
      form.setFieldsValue({
        courseName: '',
        date: today,
        startTime: today.hour(9).minute(0).second(0),
        endTime: today.hour(11).minute(0).second(0),
        location: '',
        seat: '',
        notes: '',
        reminderOffsets: DEFAULT_REMINDERS,
      });
    }
  }, [open, exam, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      // 校验：结束时间必须晚于开始时间
      if (!values.endTime.isAfter(values.startTime)) {
        message.error('结束时间必须晚于开始时间');
        return;
      }
      onOk({
        courseName: values.courseName.trim(),
        date: values.date.format('YYYY-MM-DD'),
        startTime: values.startTime.format('HH:mm'),
        endTime: values.endTime.format('HH:mm'),
        location: values.location?.trim() || undefined,
        seat: values.seat?.trim() || undefined,
        notes: values.notes?.trim() || undefined,
        reminderOffsets: values.reminderOffsets ?? [],
      });
    } catch {
      // 校验失败由 antd Form 自动展示错误
    }
  };

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑考试' : '新增考试'}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={handleOk}>
          保存
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="courseName"
          label="课程名"
          rules={[{ required: true, message: '请输入课程名' }]}
        >
          <Input placeholder="如 高等数学" maxLength={50} />
        </Form.Item>
        <Form.Item
          name="date"
          label="考试日期"
          rules={[{ required: true, message: '请选择考试日期' }]}
        >
          <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 8 }}>
          <Form.Item
            name="startTime"
            label="开始时间"
            rules={[{ required: true, message: '请选择开始时间' }]}
            style={{ flex: 1 }}
          >
            <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="endTime"
            label="结束时间"
            rules={[{ required: true, message: '请选择结束时间' }]}
            style={{ flex: 1 }}
          >
            <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Form.Item name="location" label="地点" style={{ flex: 1 }}>
            <Input placeholder="如 教学楼A101" maxLength={50} />
          </Form.Item>
          <Form.Item name="seat" label="座位号" style={{ flex: 1 }}>
            <Input placeholder="如 5" maxLength={20} />
          </Form.Item>
        </div>
        <Form.Item name="notes" label="备注">
          <Input.TextArea rows={2} placeholder="如 带计算器" maxLength={200} />
        </Form.Item>
        <Form.Item
          name="reminderOffsets"
          label="提醒档位"
          tooltip="可多选，到点会弹出桌面通知"
        >
          <Select
            mode="multiple"
            options={REMINDER_OPTIONS}
            placeholder="选择提醒档位"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
