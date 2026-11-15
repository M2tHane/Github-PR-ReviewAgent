import type { AgentUsage } from "../src/review/agent.js";

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

type UsageSource = Partial<AgentUsage> & {
  usage?: Partial<AgentUsage> | null;
  usage_input_tokens?: number | null;
  usage_output_tokens?: number | null;
};

function usageValue(source: UsageSource | null | undefined, key: keyof AgentUsage, legacy?: number | null) {
  const usage = source?.usage ?? source;
  return usage?.[key] ?? legacy;
}

// 用量分项：新数据按 AgentUsage 展示，旧的执行记录只回退到 input/output 两列。标签与数字之间用不换行空格，配合 .usage-text 只在分项之间换行。
export const usageText = (source?: UsageSource | null) =>
  [
    ["新输入", usageValue(source, "input", source?.usage_input_tokens)],
    ["缓存读取", usageValue(source, "cacheRead")],
    ["缓存写入", usageValue(source, "cacheWrite")],
    ["输出", usageValue(source, "output", source?.usage_output_tokens)],
  ]
    .map(([label, value]) => `${label}\u00a0${numberText(value as number | null | undefined)}`)
    .join(" · ");

// 总量也兼容早期只有 input/output 的执行记录；没有任何可用字段时保留“—”。
export const usageTotal = (source?: UsageSource | null) => {
  const usage = source?.usage ?? source;
  if (usage?.totalTokens !== null && usage?.totalTokens !== undefined) return usage.totalTokens;
  const values = [
    usageValue(source, "input", source?.usage_input_tokens),
    usageValue(source, "cacheRead"),
    usageValue(source, "cacheWrite"),
    usageValue(source, "output", source?.usage_output_tokens),
  ];
  if (!values.some((value) => value !== null && value !== undefined)) return undefined;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
};

export const jobLabels: Record<string, string> = {
  PR_REVIEW: "PR 审查",
  REPLY_HANDLE: "回复复核",
  DECISION_EXTRACT: "规则提取",
  HEALTH_AUDIT: "健康检查",
  RULES_SYNC: "规则文件同步",
};

// 占比：不足 1% 但不为零时写“<1%”，避免把有数的项显示成 0%。
export const percentText = (part: number, total: number) => {
  if (!(total > 0) || !Number.isFinite(part)) return "—";
  const value = (part / total) * 100;
  return part > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
};
