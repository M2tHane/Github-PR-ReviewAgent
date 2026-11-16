import { StatusGlyph, type StatusShape } from "./icons.js";

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

// 形状表达阶段；颜色只给要人处理的状态（见 app.css 的 .status-*）。
const shapes: Record<string, StatusShape> = {
  queued: "queued",
  pending: "queued",
  running: "running",
  publishing: "running",
  sending: "running",
  succeeded: "done",
  published: "done",
  ACTIVE: "done",
  enabled: "done",
  FIXED: "done",
  sent: "done",
  CANDIDATE: "attention",
  partial: "attention",
  EXCEPTION_PENDING: "attention",
  NEEDS_CLARIFICATION: "attention",
  OPEN: "attention",
  discussing: "attention",
  failed: "failed",
  timeout: "failed",
  interrupted: "failed",
  uncertain: "alert",
  STILL_VALID: "alert",
  cancelled: "stopped",
  superseded: "stopped",
  REJECTED: "stopped",
  DEPRECATED: "stopped",
  SUPERSEDED: "stopped",
  WITHDRAWN: "stopped",
  paused: "stopped",
  refused: "stopped",
  skipped: "stopped",
};
const severityTones: Record<string, string> = {
  critical: "must",
  high: "must",
  medium: "should",
  low: "may",
  unknown: "none",
};

// icon：只显示图形（列表最左一列），文字留给读屏和悬停提示；
// plain：只显示文字（同一行左侧已经有图形时用），颜色规则不变。
export function Status({
  value,
  label,
  icon = false,
  plain = false,
}: {
  value: string;
  label?: string;
  icon?: boolean;
  plain?: boolean;
}) {
  const text = label ?? statusLabels[value] ?? value;
  const tone = severityTones[value];
  if (tone)
    return icon ? (
      <span className={`sev sev-${tone} sev-icon`} title={text}>
        <span className="sr-only">{text}</span>
      </span>
    ) : (
      <span className={`sev sev-${tone}`}>{text}</span>
    );
  const className = `status status-${value.toLowerCase()}`;
  return icon ? (
    <span className={`${className} status-icon`} title={text}>
      <StatusGlyph shape={shapes[value] ?? "queued"} />
      <span className="sr-only">{text}</span>
    </span>
  ) : (
    <span className={className}>
      {!plain && <StatusGlyph shape={shapes[value] ?? "queued"} />}
      {text}
    </span>
  );
}
