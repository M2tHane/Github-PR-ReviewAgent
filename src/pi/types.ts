import { redactSecrets } from "../health/secrets.js";

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  unreportedTokens: number;
}
export const emptyUsage = (): AgentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  unreportedTokens: 0,
});
export function addUsage(total: AgentUsage, usage: Partial<AgentUsage>) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "unreportedTokens"] as const)
    total[key] += Math.max(0, Number(usage[key]) || 0);
  total.totalTokens += Math.max(
    0,
    Number(usage.totalTokens) ||
      Number(usage.input ?? 0) +
        Number(usage.output ?? 0) +
        Number(usage.cacheRead ?? 0) +
        Number(usage.cacheWrite ?? 0),
  );
}

// 仓库没有单独设置时，每个审查类任务（含重试）的 token 总预算。Pi 进程审查一个小 PR 实测约 7–9 万。
export const DEFAULT_BUDGET_TOKENS = 500_000;

export class BudgetError extends Error {
  constructor(message = "Agent 总 Token 预算不足，未发送后续模型请求") {
    super(message);
  }
}

// ponytail: 用 UTF-8 字节数加协议余量保守预留输入；接入 provider tokenizer 后可减少过度拒绝。
export function requestTokenBudget(context: unknown, remaining: number, images: Array<{ data: string }> = []) {
  let payload = JSON.stringify(context);
  for (const image of images) payload = payload.replaceAll(image.data, "[image]");
  // 开发入口只接收最大 2048px 的截图；每图保守预留 32768 tokens，避免把 base64 当正文逐字计费。
  const inputUpperBound = Buffer.byteLength(payload, "utf8") + 1024 + images.length * 32768;
  if (remaining < inputUpperBound + 128)
    throw new BudgetError(
      `Agent Token 预算不足：输入与输出至少需预留 ${inputUpperBound + 128}，剩余 ${remaining}；未发送请求`,
    );
  const maxTokens = Math.min(16_384, remaining - inputUpperBound);
  return { maxTokens, reservedTokens: inputUpperBound + maxTokens };
}

export class TimeoutError extends Error {
  constructor() {
    super("Pi 执行超时");
  }
}

// 规则参照 Pi SDK 的 isRetryableAssistantError（该函数没有从包里导出）：限流、过载、5xx、网络和流中断可以重试；
// 额度或账单用完属于确定性错误，重试也不会好。"Upstream request failed" 是模型网关间歇返回的上游故障，按临时错误重试。
const RETRYABLE_PROVIDER =
  /overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|524|529)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(?:error|refused|lost|reset)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|upstream.?connect|socket hang up|timed? out|timeout|terminated|ended without|stream ended before|try (?:your request )?again|retry your request|ResourceExhausted|upstream.?request.?failed/i;
const PERMANENT_PROVIDER =
  /insufficient_quota|quota exceeded|out of budget|billing|usage limit reached|available balance|invalid.?api.?key|unauthorized|authentication/i;

// 模型服务返回的错误。带上服务方的原始说明（打码、截断），任务记录里能看出是限流还是参数错误。
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(detail = "") {
    const text = redactSecrets(detail).replace(/\s+/g, " ").trim().slice(0, 300);
    super(`模型服务请求失败${text ? `：${text}` : ""}`);
    this.retryable = !PERMANENT_PROVIDER.test(detail) && RETRYABLE_PROVIDER.test(detail);
  }
}
