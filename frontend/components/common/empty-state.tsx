import type React from "react";

// 空状态：一句话说明 + 至多一个能做的动作。
export function Empty({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// 列表加载中的占位行：不闪烁，只占住位置。
export function ListSkeleton({ rows = 3, label = "正在加载…" }: { rows?: number; label?: string }) {
  return (
    <div className="list list-skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="list-row" key={index} aria-hidden="true">
          <span className="skeleton-bar" style={{ width: `${60 - index * 12}%` }} />
        </div>
      ))}
    </div>
  );
}
