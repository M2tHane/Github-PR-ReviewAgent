export const statusLabels: Record<string, string> = {
  ACTIVE: "生效中",
  CANDIDATE: "待确认",
  REJECTED: "已忽略",
  DEPRECATED: "已停用",
  SUPERSEDED: "已替代",
  enabled: "已启用",
  paused: "已暂停",
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  timeout: "超时",
  cancelled: "已取消",
  interrupted: "已中断",
  superseded: "已过期",
  uncertain: "待核对发布",
  published: "已发布",
  OPEN: "待处理",
  FIXED: "已修复",
  WITHDRAWN: "已撤回",
  STILL_VALID: "仍需处理",
  NEEDS_CLARIFICATION: "待补充说明",
  EXCEPTION_PENDING: "例外待确认",
  // 严重度与 GitHub 评论一致，只展示三档。
  critical: "必须改",
  high: "必须改",
  medium: "建议改",
  low: "可以不改",
};
export function Status({ value, label }: { value: string; label?: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{label ?? statusLabels[value] ?? value}</span>;
}
