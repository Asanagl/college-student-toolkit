// 日程新增/编辑对话框：使用 Ant Design Modal + Form。
// 提醒偏移用 InputNumber + Select 单位组合，存储时统一转换为分钟。
// 编辑模式额外提供删除按钮（左下角）。
import { useEffect } from 'react';
import { Button, DatePicker, Form, Input, InputNumber, message, Modal, Select } from 'antd';
import dayjs from 'dayjs';
import type { RepeatRule, Schedule } from '../../../shared/types';

interface ScheduleDialogProps {
  open: boolean;
  mode: 'add' | 'edit';
  /** 编辑时传入原日程；新增时为 null */
  schedule?: Schedule | null;
  /** 新增时预选的日期，用于填充默认时间 */
  defaultDate?: Date;
  onCancel: () => void;
  /** 保存/删除成功后回调，父组件据此刷新数据并关闭对话框 */
  onSuccess: () => void;
}

interface FormValues {
  title: string;
  startTime: dayjs.Dayjs;
  endTime: dayjs.Dayjs;
  reminderValue: number;
  reminderUnit: ReminderUnit;
  repeatRule: RepeatRule;
}

type ReminderUnit = 'minute' | 'hour' | 'day';

const REPEAT_OPTIONS = [
  { label: '不重复', value: 'none' as const },
  { label: '每日', value: 'daily' as const },
  { label: '每周', value: 'weekly' as const },
  { label: '每月', value: 'monthly' as const },
];

const UNIT_OPTIONS = [
  { label: '分钟', value: 'minute' as const },
  { label: '小时', value: 'hour' as const },
  { label: '天', value: 'day' as const },
];

// 单位转分钟系数，存储统一用分钟
const UNIT_TO_MINUTES: Record<ReminderUnit, number> = {
  minute: 1,
  hour: 60,
  day: 1440,
};

/** 将分钟数反推为最大可整除单位与数值，便于表单回显 */
function offsetToValueUnit(offset: number): { value: number; unit: ReminderUnit } {
  if (offset >= 1440 && offset % 1440 === 0) {
    return { value: offset / 1440, unit: 'day' };
  }
  if (offset >= 60 && offset % 60 === 0) {
    return { value: offset / 60, unit: 'hour' };
  }
  return { value: offset, unit: 'minute' };
}

export default function ScheduleDialog({
  open,
  mode,
  schedule,
  defaultDate,
  onCancel,
  onSuccess,
}: ScheduleDialogProps) {
  const [form] = Form.useForm<FormValues>();
  const isEdit = mode === 'edit';

  // 打开时根据模式填充表单
  useEffect(() => {
    if (!open) return;
    if (isEdit && schedule) {
      const { value, unit } = offsetToValueUnit(schedule.reminderOffset);
      form.setFieldsValue({
        title: schedule.title,
        startTime: dayjs(schedule.startTime),
        endTime: dayjs(schedule.endTime),
        reminderValue: value,
        reminderUnit: unit,
        repeatRule: schedule.repeatRule,
      });
    } else {
      // 新增：预填默认日期 09:00-10:00，提前 15 分钟
      const base = defaultDate ? dayjs(defaultDate) : dayjs();
      form.setFieldsValue({
        title: '',
        startTime: base.hour(9).minute(0).second(0),
        endTime: base.hour(10).minute(0).second(0),
        reminderValue: 15,
        reminderUnit: 'minute',
        repeatRule: 'none',
      });
    }
  }, [open, isEdit, schedule, defaultDate, form]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const reminderValue = values.reminderValue ?? 0;
      const reminderOffset = reminderValue * UNIT_TO_MINUTES[values.reminderUnit];
      const payload = {
        title: values.title.trim(),
        startTime: values.startTime.toISOString(),
        endTime: values.endTime.toISOString(),
        reminderOffset,
        repeatRule: values.repeatRule,
      };

      if (isEdit && schedule) {
        const res = await window.api.schedule.update(schedule.id, payload);
        if (!res.ok) {
          message.error(res.error ?? '保存失败');
          return;
        }
        message.success('已更新');
      } else {
        const res = await window.api.schedule.add(payload);
        if (!res.ok) {
          message.error(res.error ?? '保存失败');
          return;
        }
        message.success('已添加');
      }
      onSuccess();
    } catch {
      // 校验失败由 antd Form 自动展示错误，无需额外处理
    }
  };

  const handleDelete = async () => {
    if (!schedule) return;
    const res = await window.api.schedule.remove(schedule.id);
    if (!res.ok) {
      message.error(res.error ?? '删除失败');
      return;
    }
    message.success('已删除');
    onSuccess();
  };

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑日程' : '新增日程'}
      onCancel={onCancel}
      footer={[
        // 删除按钮放左下角，与取消/保存区分
        isEdit ? (
          <Button key="delete" danger onClick={handleDelete} style={{ float: 'left' }}>
            删除
          </Button>
        ) : null,
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={handleSave}>
          保存
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="title"
          label="标题"
          rules={[{ required: true, message: '请输入标题' }]}
        >
          <Input placeholder="如：高数课、小组会议" maxLength={50} />
        </Form.Item>
        <Form.Item
          name="startTime"
          label="开始时间"
          rules={[{ required: true, message: '请选择开始时间' }]}
        >
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="endTime"
          label="结束时间"
          dependencies={['startTime']}
          rules={[
            { required: true, message: '请选择结束时间' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                const start = getFieldValue('startTime');
                if (!value || !start) return Promise.resolve();
                if (!dayjs(value).isAfter(dayjs(start))) {
                  return Promise.reject(new Error('结束时间必须晚于开始时间'));
                }
                return Promise.resolve();
              },
            }),
          ]}
        >
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="提醒提前时间">
          <div style={{ display: 'flex', gap: 8 }}>
            <Form.Item name="reminderValue" noStyle>
              <InputNumber min={0} style={{ flex: 1 }} placeholder="数量" />
            </Form.Item>
            <Form.Item name="reminderUnit" noStyle>
              <Select style={{ width: 100 }} options={UNIT_OPTIONS} />
            </Form.Item>
          </div>
        </Form.Item>
        <Form.Item name="repeatRule" label="重复规则" rules={[{ required: true }]}>
          <Select options={REPEAT_OPTIONS} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
