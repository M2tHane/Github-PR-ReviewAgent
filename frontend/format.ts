const pad = (value: number) => String(value).padStart(2, "0");

// 中文日期：今年省略年份，例如"11月4日 22:27"。
export const dateText = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const time = `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear() ? time : `${date.getFullYear()}年${time}`;
};

// 列表里用相对时间，一周以外回到具体日期。
export const relativeTime = (value?: string | null, now = Date.now()) => {
  if (!value) return "—";
  const date = new Date(value);
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return "—";
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)} 天前`;
  return dateText(value);
};

// token 等数字：整数加千分位，去掉浮点尾数。
export const numberText = (value?: number | null) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString("zh-CN");

export const jobLabels: Record<string, string> = {
  PR_REVIEW: "PR 审查",
  REPLY_HANDLE: "回复复核",
  DECISION_EXTRACT: "规则提取",
  HEALTH_AUDIT: "健康检查",
};
