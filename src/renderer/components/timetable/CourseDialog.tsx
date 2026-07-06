// 课程添加/编辑对话框：使用 Ant Design Modal + Form。
// 字段：课程名（必填）、教师、地点、起止周、星期、起止节、颜色（预设色板 8 种）。
// 编辑模式预填表单；保存时调用 onOk 回传 Omit<Course, keyof BaseEntity>。
import { useEffect } from 'react';
import { Button, ColorPicker, Form, Input, InputNumber, Modal, Select, message } from 'antd';
import type { Course, Weekday } from '../../../shared/types';

interface CourseDialogProps {
  open: boolean;
  /** 编辑模式时传入原课程；新增时为 undefined */
  course?: Course;
  onOk: (data: Omit<Course, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
}

interface FormValues {
  name: string;
  teacher?: string;
  location?: string;
  startWeek: number;
  endWeek: number;
  weekday: Weekday;
  startPeriod: number;
  endPeriod: number;
  color: string;
}

// 预设色板 8 种，覆盖常见课程配色
const PRESET_COLORS = [
  '#4285F4', '#34A853', '#FBBC05', '#EA4335',
  '#9C27B0', '#00BCD4', '#FF9800', '#795548',
];

const WEEKDAY_OPTIONS = [
  { label: '周一', value: 1 as Weekday },
  { label: '周二', value: 2 as Weekday },
  { label: '周三', value: 3 as Weekday },
  { label: '周四', value: 4 as Weekday },
  { label: '周五', value: 5 as Weekday },
  { label: '周六', value: 6 as Weekday },
  { label: '周日', value: 7 as Weekday },
];

export default function CourseDialog({ open, course, onOk, onCancel }: CourseDialogProps) {
  const [form] = Form.useForm<FormValues>();
  const isEdit = !!course;

  // 打开时根据模式预填表单
  useEffect(() => {
    if (!open) return;
    if (course) {
      form.setFieldsValue({
        name: course.name,
        teacher: course.teacher,
        location: course.location,
        startWeek: course.startWeek,
        endWeek: course.endWeek,
        weekday: course.weekday,
        startPeriod: course.startPeriod,
        endPeriod: course.endPeriod,
        color: course.color,
      });
    } else {
      // 新增默认值：第1-16周，周一第1-2节，蓝色
      form.setFieldsValue({
        name: '',
        teacher: '',
        location: '',
        startWeek: 1,
        endWeek: 16,
        weekday: 1,
        startPeriod: 1,
        endPeriod: 2,
        color: PRESET_COLORS[0],
      });
    }
  }, [open, course, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      // 校验：结束周 >= 起始周，结束节 >= 起始节
      if (values.endWeek < values.startWeek) {
        message.error('结束周不能早于起始周');
        return;
      }
      if (values.endPeriod < values.startPeriod) {
        message.error('结束节不能早于起始节');
        return;
      }
      onOk({
        name: values.name.trim(),
        teacher: values.teacher?.trim() || undefined,
        location: values.location?.trim() || undefined,
        startWeek: values.startWeek,
        endWeek: values.endWeek,
        weekday: values.weekday,
        startPeriod: values.startPeriod,
        endPeriod: values.endPeriod,
        color: values.color,
      });
    } catch {
      // 校验失败由 antd Form 自动展示错误
    }
  };

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑课程' : '新增课程'}
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
          label="课程名"
          rules={[{ required: true, message: '请输入课程名' }]}
        >
          <Input placeholder="如 高等数学" maxLength={50} />
        </Form.Item>
        <Form.Item name="teacher" label="教师">
          <Input placeholder="如 张三" maxLength={30} />
        </Form.Item>
        <Form.Item name="location" label="地点">
          <Input placeholder="如 教学楼A101" maxLength={50} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 8 }}>
          <Form.Item
            name="startWeek"
            label="起始周"
            rules={[{ required: true, message: '请输入起始周' }]}
            style={{ flex: 1 }}
          >
            <InputNumber min={1} max={30} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="endWeek"
            label="结束周"
            rules={[{ required: true, message: '请输入结束周' }]}
            style={{ flex: 1 }}
          >
            <InputNumber min={1} max={30} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item
          name="weekday"
          label="星期"
          rules={[{ required: true, message: '请选择星期' }]}
        >
          <Select options={WEEKDAY_OPTIONS} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 8 }}>
          <Form.Item
            name="startPeriod"
            label="起始节"
            rules={[{ required: true, message: '请输入起始节' }]}
            style={{ flex: 1 }}
          >
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="endPeriod"
            label="结束节"
            rules={[{ required: true, message: '请输入结束节' }]}
            style={{ flex: 1 }}
          >
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item
          name="color"
          label="颜色"
          rules={[{ required: true }]}
          // antd 5 ColorPicker 默认存 Color 对象，这里提取 hex 字符串便于持久化
          getValueFromEvent={(color) => (typeof color === 'string' ? color : color.toHexString())}
          getValueProps={(value) => ({
            value: typeof value === 'string' ? value : undefined,
          })}
        >
          <ColorPicker
            showText
            format="hex"
            presets={[{ label: '预设', colors: PRESET_COLORS }]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
