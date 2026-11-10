import { numberText } from "../../format.js";

// 翻页：显示当前条目范围和总数；只有一页时只显示总数。
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  disabled?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = Math.min(total, (page - 1) * pageSize + 1),
    last = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="翻页">
      <span className="muted" role="status">
        {total === 0
          ? "共 0 条"
          : pages === 1
            ? `共 ${numberText(total)} 条`
            : `第 ${numberText(first)}–${numberText(last)} 条，共 ${numberText(total)} 条`}
      </span>
      {pages > 1 && (
        <span className="pager-buttons">
          <button className="secondary" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>
            上一页
          </button>
          <span className="muted">
            {numberText(page)} / {numberText(pages)}
          </span>
          <button className="secondary" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>
            下一页
          </button>
        </span>
      )}
    </nav>
  );
}
