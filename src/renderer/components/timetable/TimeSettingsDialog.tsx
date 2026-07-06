// 自定义时间设置对话框：编辑每节课的起止时间、课间休息、实验标记、提醒提前时间。
// 使用 Form.List 渲染节次配置表，内部 load/save 走 window.api.periodConfig。
import { useEffect, useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Spin, Switch, TimePicker, message } from 'antd';
import type { PeriodConfig } from '../../../shared/types';
import dayjs from 'dayjs';

interface TimeSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface FormValues {
  periods: PeriodConfig[];
}

export default function TimeSettingsDialog({ open, onClose }: TimeSettingsDialogProps) {
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 打开时加载节次配置
  useEffect(() => {
    if (!open) return;
    void loadPeriods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadPeriods = async () => {
    setLoading(true);
    try {
      const res = await window.api.periodConfig.get();
      if (res.ok && res.data) {
        form.setFieldsValue({ periods: res.data });
      } else {
        message.error(res.error ?? '加载节次配置失败');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const res = await window.api.periodConfig.save(values.periods);
      if (!res.ok) {
        message.error(res.error ?? '保存失败');
        return;
      }
      message.success('节次配置已保存');
      onClose();
    } catch {
      // 校验失败由 Form 自动展示
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="节次时间设置"
      onCancel={onClose}
      width={720}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={handleSave}>
          保存
        </Button>,
      ]}
    >
      <Spin spinning={loading}>
        <Form form={form} layout="vertical">
          <Form.List name="periods">
            {(fields) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '40px 1fr 1fr 80px 60px 100px',
                    gap: 8,
                    fontWeight: 600,
                    fontSize: 13,
                    color: '#666',
                    padding: '0 4px',
                  }}
                >
                  <span>节次</span>
                  <span>开始</span>
                  <span>结束</span>
                  <span>课间(分)</span>
                  <span>实验</span>
                  <span>提前提醒(分)</span>
                </div>
                {fields.map((field) => (
                  <PeriodRow key={field.key} field={field} />
                ))}
              </div>
            )}
          </Form.List>
        </Form>
      </Spin>
    </Modal>
  );
}

/** 单行节次配置：节次序号只读，其余字段可编辑 */
interface PeriodRowProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  field: any;
}

function PeriodRow({ field }: PeriodRowProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr 1fr 80px 60px 100px',
        gap: 8,
        alignItems: 'center',
      }}
    >
      {/* 节次序号：仅展示，不可编辑 */}
      <Form.Item {...field} name={[field.name, 'index']} noStyle>
        <Input readOnly style={{ textAlign: 'center' }} />
      </Form.Item>
      {/* 开始时间：TimePicker format HH:mm */}
      <Form.Item
        {...field}
        name={[field.name, 'startTime']}
        rules={[{ required: true, message: '请选择开始时间' }]}
        noStyle
        // 时间值存为 HH:mm 字符串，与 PeriodConfig 一致；TimePicker 需 dayjs 对象
        getValueFromEvent={(time) => (time ? time.format('HH:mm') : undefined)}
        getValueProps={(value) => ({
          value: typeof value === 'string' ? dayjs(value, 'HH:mm') : undefined,
        })}
      >
        <TimePicker format="HH:mm" style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        {...field}
        name={[field.name, 'endTime']}
        rules={[{ required: true, message: '请选择结束时间' }]}
        noStyle
        getValueFromEvent={(time) => (time ? time.format('HH:mm') : undefined)}
        getValueProps={(value) => ({
          value: typeof value === 'string' ? dayjs(value, 'HH:mm') : undefined,
        })}
      >
        <TimePicker format="HH:mm" style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item {...field} name={[field.name, 'breakAfter']} noStyle>
        <InputNumber min={0} max={240} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item {...field} name={[field.name, 'isLab']} noStyle valuePropName="checked">
        <Switch size="small" />
      </Form.Item>
      <Form.Item {...field} name={[field.name, 'reminderOffset']} noStyle>
        <InputNumber min={0} max={120} style={{ width: '100%' }} />
      </Form.Item>
    </div>
  );
}
