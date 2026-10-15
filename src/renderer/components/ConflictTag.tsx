// 撞课标记：考试/实验/日程列表共用。悬停显示全部冲突课程及周次范围。
import { Tag, Tooltip } from 'antd';
import type { ConflictRef } from '../../shared/conflicts';

interface ConflictTagProps {
  refs: ConflictRef[];
}

export default function ConflictTag({ refs }: ConflictTagProps) {
  if (refs.length === 0) return null;
  const content = refs
    .map((r) => `与 ${r.label} 撞课（${r.detail}）`)
    .join('\n');
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{content}</span>}>
      <Tag color="error" style={{ marginInlineStart: 4 }}>
        撞课
      </Tag>
    </Tooltip>
  );
}
