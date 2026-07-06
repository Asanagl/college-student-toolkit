// GPA 公式编辑器对话框
// 同时导出渲染进程共用的 GPA 计算工具函数（computeGpa / validateFormula），
// 供 GradePage 计算统计卡片使用。
//
// 注意：主进程 GradeService 有同名逻辑，但因 Electron contextIsolation 隔离
// 渲染进程无法直接 import 主进程模块，故此处维护一份等价实现。
import { useEffect, useMemo, useState } from 'react';
import { Parser } from 'expr-eval';
import {
  Modal,
  Form,
  Input,
  Button,
  message,
  Space,
  Alert,
  Card,
  Descriptions,
  Typography,
} from 'antd';
import type { Grade, GpaFormula } from '../../../shared/types';

const { Text, Paragraph } = Typography;

/** 默认 GPA 公式：学分加权绩点 */
export const DEFAULT_FORMULA = 'SUM(credit * gradePoint) / SUM(credit)';

// 复用单个 Parser 实例：expr-eval Parser 解析后产生独立 Expression，无状态可全局复用
const parser = new Parser();

/**
 * 将公式中的每个 SUM(inner) 替换为对全体 grades 求 inner 之和的数值。
 * 用括号包裹替换值，避免负数与相邻运算符产生解析歧义。
 */
function expandSumExpressions(formula: string, grades: Grade[]): string {
  let result = formula;
  let searchFrom = 0;
  for (;;) {
    const sumStart = result.indexOf('SUM(', searchFrom);
    if (sumStart === -1) break;

    // 用深度计数找到 SUM( 对应的右括号，支持内部嵌套括号
    let depth = 1;
    let i = sumStart + 4;
    while (i < result.length && depth > 0) {
      const ch = result[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth !== 0) {
      throw new Error('SUM(...) 括号不匹配');
    }

    const innerExpr = result.substring(sumStart + 4, i);
    const sumValue = sumOverGrades(innerExpr, grades);
    const replacement = `(${sumValue})`;
    result = result.substring(0, sumStart) + replacement + result.substring(i + 1);
    searchFrom = sumStart + replacement.length;
  }
  return result;
}

/** 对每条 grade 求内部表达式的值并汇总；score 缺失时以 0 代入 */
function sumOverGrades(innerExpr: string, grades: Grade[]): number {
  const expr = parser.parse(innerExpr);
  let sum = 0;
  for (const g of grades) {
    // 兜底：credit/gradePoint 异常时以 0 代入，避免抛错导致白屏
    const credit = typeof g.credit === 'number' && Number.isFinite(g.credit) ? g.credit : 0;
    const gradePoint =
      typeof g.gradePoint === 'number' && Number.isFinite(g.gradePoint) ? g.gradePoint : 0;
    const score = typeof g.score === 'number' && Number.isFinite(g.score) ? g.score : 0;
    const v = expr.evaluate({ credit, gradePoint, score });
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    sum += n;
  }
  return sum;
}

/**
 * 计算给定成绩集合的 GPA，保留 2 位小数。
 * 空集合返回 0，避免除零。
 * 公式解析或求值失败时返回 0，避免渲染进程白屏。
 */
export function computeGpa(grades: Grade[], formula: GpaFormula): number {
  if (grades.length === 0) return 0;
  try {
    const expanded = expandSumExpressions(formula.formula, grades);
    const expr = parser.parse(expanded);
    const raw = expr.evaluate();
    const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return Math.round(num * 100) / 100;
  } catch (err) {
    console.error('[computeGpa] 计算失败，返回 0:', (err as Error).message);
    return 0;
  }
}

/**
 * 校验公式语法：用示例数据尝试完整计算一次，失败则返回错误信息。
 * 校验通过返回 { ok: true }。
 */
export function validateFormula(formula: string): { ok: boolean; error?: string } {
  const trimmed = formula.trim();
  if (!trimmed) {
    return { ok: false, error: '公式不能为空' };
  }
  try {
    const sample: Grade[] = [
      {
        id: 't1',
        courseName: '示例课程A',
        semester: '2025-2026-1',
        credit: 4,
        gradePoint: 4.0,
        score: 90,
        isDegreeCourse: true,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 't2',
        courseName: '示例课程B',
        semester: '2025-2026-1',
        credit: 3,
        gradePoint: 3.0,
        score: 80,
        isDegreeCourse: true,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const expanded = expandSumExpressions(trimmed, sample);
    const expr = parser.parse(expanded);
    const result = expr.evaluate();
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      return { ok: false, error: '公式计算结果不是有效数字' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** "测试"按钮使用的 3 门示例课程 */
const TEST_GRADES: Grade[] = [
  {
    id: 't1',
    courseName: '课程A',
    semester: '2025-2026-1',
    credit: 4,
    gradePoint: 4.0,
    score: 90,
    isDegreeCourse: true,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 't2',
    courseName: '课程B',
    semester: '2025-2026-1',
    credit: 3,
    gradePoint: 3.0,
    score: 80,
    isDegreeCourse: true,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 't3',
    courseName: '课程C',
    semester: '2025-2026-1',
    credit: 2,
    gradePoint: 2.0,
    score: 70,
    isDegreeCourse: false,
    createdAt: '',
    updatedAt: '',
  },
];

export interface GpaFormulaDialogProps {
  open: boolean;
  /** 当前默认公式，用于初始化编辑器 */
  currentFormula: GpaFormula | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function GpaFormulaDialog({
  open,
  currentFormula,
  onClose,
  onSaved,
}: GpaFormulaDialogProps) {
  const [formulaText, setFormulaText] = useState(DEFAULT_FORMULA);
  const [formulaName, setFormulaName] = useState('默认公式');
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // 打开时用当前公式初始化
  useEffect(() => {
    if (open) {
      setFormulaText(currentFormula?.formula ?? DEFAULT_FORMULA);
      setFormulaName(currentFormula?.name ?? '默认公式');
      setTestResult(null);
      setValidationError(null);
    }
  }, [open, currentFormula]);

  // 公式变化时清除旧的反馈权态
  useEffect(() => {
    setTestResult(null);
    setValidationError(null);
  }, [formulaText]);

  const handleResetDefault = () => {
    setFormulaText(DEFAULT_FORMULA);
    message.info('已恢复为默认公式');
  };

  const handleTest = () => {
    const validation = validateFormula(formulaText);
    if (!validation.ok) {
      setValidationError(validation.error ?? '公式无效');
      setTestResult(null);
      return;
    }
    setValidationError(null);
    const fakeFormula: GpaFormula = {
      id: 'test',
      name: 'test',
      formula: formulaText.trim(),
      isDefault: false,
      createdAt: '',
      updatedAt: '',
    };
    const gpa = computeGpa(TEST_GRADES, fakeFormula);
    setTestResult(
      `示例数据（学分 4/绩点 4.0、学分 3/绩点 3.0、学分 2/绩点 2.0）计算 GPA = ${gpa.toFixed(2)}`
    );
  };

  const handleSave = async () => {
    const validation = validateFormula(formulaText);
    if (!validation.ok) {
      setValidationError(validation.error ?? '公式无效');
      message.error('公式语法错误，无法保存');
      return;
    }

    setSaving(true);
    try {
      // 类型约束：window.api.formula.save 的签名是 Omit<GpaFormula, keyof BaseEntity>
      // 但仓库 save 支持可选 id（用于更新而非新建），运行时会透传，故此处带 id 保存以更新默认公式
      const payload = {
        id: currentFormula?.id ?? 'default',
        name: formulaName.trim() || '默认公式',
        formula: formulaText.trim(),
        isDefault: true,
      } as Omit<GpaFormula, 'id' | 'createdAt' | 'updatedAt'>;
      const res = await window.api.formula.save(payload);
      if (!res.ok) {
        message.error(res.error ?? '保存失败');
        return;
      }
      message.success('公式已保存');
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // 变量说明面板内容，复用避免重复 JSX
  const variableHelp = useMemo(
    () => (
      <Card size="small" title="变量与函数说明" style={{ marginBottom: 12 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="credit">学分（每门课程）</Descriptions.Item>
          <Descriptions.Item label="gradePoint">绩点（每门课程）</Descriptions.Item>
          <Descriptions.Item label="score">百分制成绩（每门课程，可能为空）</Descriptions.Item>
          <Descriptions.Item label="SUM(expr)">
            对所有课程求 expr 之和
          </Descriptions.Item>
          <Descriptions.Item label="运算符">+ &nbsp; - &nbsp; * &nbsp; / &nbsp; ( )</Descriptions.Item>
        </Descriptions>
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          示例：<Text code>SUM(credit * gradePoint) / SUM(credit)</Text>
        </Paragraph>
      </Card>
    ),
    []
  );

  return (
    <Modal
      title="GPA 公式设置"
      open={open}
      onCancel={onClose}
      destroyOnClose
      width={640}
      footer={
        <Space>
          <Button onClick={handleResetDefault}>恢复默认</Button>
          <Button onClick={onClose}>取消</Button>
          <Button onClick={handleTest}>测试</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>
            保存
          </Button>
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item label="公式名称">
          <Input
            value={formulaName}
            onChange={(e) => setFormulaName(e.target.value)}
            placeholder="如 默认公式"
            maxLength={50}
          />
        </Form.Item>

        {variableHelp}

        <Form.Item label="公式表达式">
          <Input.TextArea
            value={formulaText}
            onChange={(e) => setFormulaText(e.target.value)}
            rows={3}
            placeholder={DEFAULT_FORMULA}
            style={{ fontFamily: 'monospace' }}
          />
        </Form.Item>

        {validationError && (
          <Alert
            type="error"
            message="公式语法错误"
            description={validationError}
            showIcon
            style={{ marginBottom: 12 }}
          />
        )}

        {testResult && (
          <Alert
            type="success"
            message="测试结果"
            description={testResult}
            showIcon
            style={{ marginBottom: 12 }}
          />
        )}
      </Form>
    </Modal>
  );
}
