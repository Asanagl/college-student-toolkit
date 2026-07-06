// 成绩添加/编辑对话框
// 支持新增与编辑两种模式；编辑模式下额外提供"删除"操作
// 学期字段使用 Select tags 模式，既可从已有学期选择，也可手动输入新学期
import { useEffect, useState } from 'react';
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Button,
  Popconfirm,
  message,
  Space,
} from 'antd';
import type { Grade } from '../../../shared/types';

export interface GradeDialogProps {
  open: boolean;
  /** 非 null 表示编辑模式 */
  editing: Grade | null;
  /** 已有学期列表，用于 Select 选项 */
  semesters: string[];
  onClose: () => void;
  /** 保存/删除成功后回调（父组件刷新列表） */
  onSaved: () => void;
}

/** 表单提交时的成绩载荷
 * semester 为数组是因为 Select tags 模式返回数组；score 为 null 表示未录入（InputNumber 清空时返回 null）
 */
interface GradePayload {
  courseName: string;
  semester: string[];
  credit: number;
  gradePoint: number;
  score: number | null;
  isDegreeCourse: boolean;
}

export default function GradeDialog({
  open,
  editing,
  semesters,
  onClose,
  onSaved,
}: GradeDialogProps) {
  const [form] = Form.useForm<GradePayload>();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isEdit = editing !== null;

  // 对话框打开时根据模式初始化表单值
  useEffect(() => {
    if (!open) return;
    if (editing) {
      // Select tags 模式接收数组，因此把单个 semester 包成 [semester]
      form.setFieldsValue({
        courseName: editing.courseName,
        semester: [editing.semester],
        credit: editing.credit,
        gradePoint: editing.gradePoint,
        score: editing.score ?? null,
        isDegreeCourse: editing.isDegreeCourse,
      });
    } else {
      form.resetFields();
      // 新增模式给一组合理的默认值，减少重复输入
      form.setFieldsValue({
        isDegreeCourse: false,
        credit: 1,
        gradePoint: 4.0,
        score: null,
      });
    }
  }, [open, editing, form]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      // Select tags 模式返回数组，取第一个元素作为学期字符串
      const semesterRaw = Array.isArray(values.semester) ? values.semester[0] : values.semester;
      if (!semesterRaw || !semesterRaw.trim()) {
        message.error('请选择或输入学期');
        return;
      }
      const payload: Omit<Grade, 'id' | 'createdAt' | 'updatedAt'> = {
        courseName: values.courseName.trim(),
        semester: semesterRaw.trim(),
        credit: Number(values.credit),
        gradePoint: Number(values.gradePoint),
        // Grade 接口中 score?: number（undefined 表示未录入），将 null 转为 undefined
        score: values.score ?? undefined,
        isDegreeCourse: !!values.isDegreeCourse,
      };

      setSaving(true);
      if (isEdit && editing) {
        const res = await window.api.grade.update(editing.id, payload);
        if (!res.ok) {
          message.error(res.error ?? '保存失败');
          return;
        }
        message.success('已更新成绩');
      } else {
        const res = await window.api.grade.add(payload);
        if (!res.ok) {
          message.error(res.error ?? '添加失败');
          return;
        }
        message.success('已添加成绩');
      }
      onSaved();
      onClose();
    } catch {
      // validateFields 失败时表单已显示校验信息，这里无需额外提示
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    setDeleting(true);
    try {
      const res = await window.api.grade.remove(editing.id);
      if (!res.ok) {
        message.error(res.error ?? '删除失败');
        return;
      }
      message.success('已删除成绩');
      onSaved();
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={isEdit ? '编辑成绩' : '添加成绩'}
      open={open}
      onCancel={onClose}
      destroyOnClose
      width={520}
      footer={
        <Space>
          {/* 编辑模式下提供左侧删除入口，避免误触 */}
          {isEdit && (
            <Popconfirm
              title="确认删除该成绩？"
              description="删除后无法恢复"
              onConfirm={handleDelete}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button danger loading={deleting}>
                删除
              </Button>
            </Popconfirm>
          )}
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="courseName"
          label="课程名"
          rules={[{ required: true, message: '请输入课程名' }]}
        >
          <Input placeholder="如 高等数学" maxLength={100} />
        </Form.Item>

        <Form.Item
          name="semester"
          label="学期"
          rules={[{ required: true, message: '请选择或输入学期' }]}
          extra="格式 YYYY-YYYY-N，如 2025-2026-1，可直接输入新学期"
        >
          <Select
            mode="tags"
            maxCount={1}
            placeholder="选择已有学期或输入新学期"
            options={semesters.map((s) => ({ label: s, value: s }))}
            tokenSeparators={[',']}
          />
        </Form.Item>

        <Form.Item
          name="credit"
          label="学分"
          rules={[{ required: true, message: '请输入学分' }]}
        >
          <InputNumber min={0.5} max={20} step={0.5} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          name="gradePoint"
          label="绩点"
          rules={[{ required: true, message: '请输入绩点' }]}
        >
          <InputNumber min={0} max={5} step={0.1} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item name="score" label="成绩（可选）" extra="百分制分数，等级制可不填">
          <InputNumber
            min={0}
            max={100}
            step={1}
            style={{ width: '100%' }}
            placeholder="如 90"
          />
        </Form.Item>

        <Form.Item name="isDegreeCourse" label="学位课" valuePropName="checked">
          <Switch checkedChildren="是" unCheckedChildren="否" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
