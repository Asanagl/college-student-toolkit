// 实验新增/编辑对话框：使用 Ant Design Modal + Form。
// 字段：实验名（必填）、日期、开始/结束时间、地点、指导教师、注意事项、多档提醒。
import { useEffect } from 'react';
import { Button, DatePicker, Form, Input, Modal, Select, TimePicker, message } from 'antd';
import dayjs from 'dayjs';
import type { Lab } from '../../../shared/types';

interface LabDialogProps {
  open: boolean;
  /** 编辑模式时传入原实验；新增时为 undefined */
  lab?: Lab;
  onOk: (data: Omit<Lab, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
}

interface FormValues {
  name: string;
  date: dayjs.Dayjs;
  startTime: dayjs.Dayjs;
  endTime: dayjs.Dayjs;
  location?: string;
  instructor?: string;
  notes?: string;
  reminderOffsets: number[];
}

// 多档提醒预设：与 ExamDialog 一致
const REMINDER_OPTIONS = [
  { label: '提前1周', value: 10080 },
  { label: '提前3天', value: 4320 },
  { label: '提前1天', value: 1440 },
  { label: '提前3小时', value: 180 },
  { label: '提前1小时', value: 60 },
];

const DEFAULT_REMINDERS = [1440, 60];

export default function LabDialog({ open, lab, onOk, onCancel }: LabDialogProps) {
  const [form] = Form.useForm<FormValues>();
  const isEdit = !!lab;

  useEffect(() => {
    if (!open) return;
    if (lab) {
      form.setFieldsValue({
        name: lab.name,
        date: dayjs(lab.date),
        startTime: dayjs(`${lab.date} ${lab.startTime}`),
        endTime: dayjs(`${lab.date} ${lab.endTime}`),
        location: lab.location,
        instructor: lab.instructor,
        notes: lab.notes,
        reminderOffsets: lab.reminderOffsets ?? [],
      });
    } else {
      const today = dayjs();
      form.setFieldsValue({
        name: '',
        date: today,
        startTime: today.hour(14).minute(0).second(0),
        endTime: today.hour(16).minute(0).second(0),
        location: '',
        instructor: '',
        notes: '',
        reminderOffsets: DEFAULT_REMINDERS,
      });
    }
  }, [open, lab, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      if (!values.endTime.isAfter(values.startTime)) {
        message.error('结束时间必须晚于开始时间');
        return;
      }
      onOk({
        name: values.name.trim(),
        date: values.date.format('YYYY-MM-DD'),
        startTime: values.startTime.format('HH:mm'),
        endTime: values.endTime.format('HH:mm'),
        location: values.location?.trim() || undefined,
        instructor: values.instructor?.trim() || undefined,
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
      title={isEdit ? '编辑实验' : '新增实验'}
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
          name="name"
          label="实验名"
          rules={[{ required: true, message: '请输入实验名' }]}
        >
          <Input placeholder="如 电路基础实验" maxLength={50} />
        </Form.Item>
        <Form.Item
          name="date"
          label="实验日期"
          rules={[{ required: true, message: '请选择实验日期' }]}
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
            <Input placeholder="如 实验楼B201" maxLength={50} />
          </Form.Item>
          <Form.Item name="instructor" label="指导教师" style={{ flex: 1 }}>
            <Input placeholder="如 张老师" maxLength={30} />
          </Form.Item>
        </div>
        <Form.Item name="notes" label="注意事项">
          <Input.TextArea rows={2} placeholder="如 穿实验服" maxLength={200} />
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
