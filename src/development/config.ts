import { resolve } from "node:path";

export interface DevelopmentConfig {
  botId: string;
  secret: string;
  // 不设置时不限制 token；设置后整个任务（含重试）共用这一额度。
  budgetTokens?: number;
  timeoutMs: number;
  // 同时开发的任务数；不同项目并行，同一项目按顺序一个一个做。
  concurrency: number;
  // 依赖下载缓存，跨任务共享。
  cacheDir: string;
}
export function loadDevelopmentConfig(env: NodeJS.ProcessEnv): DevelopmentConfig | undefined {
  const botId = env.WECOM_BOT_ID?.trim(),
    secret = env.WECOM_BOT_SECRET?.trim();
  if (!botId && !secret) return;
  if (!botId || !secret) throw new Error("WECOM_BOT_ID 和 WECOM_BOT_SECRET 必须一起配置");
  const rawBudget = env.DEVELOPMENT_BUDGET_TOKENS?.trim();
  const budgetTokens = rawBudget ? Number(rawBudget) : undefined;
  if (budgetTokens !== undefined && (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1000))
    throw new Error("DEVELOPMENT_BUDGET_TOKENS 必须是至少 1000 的整数，或留空表示不限制");
  // 开发任务要建 codegraph 索引、改多个文件、运行检查，比审查耗时长得多，单独设置时限。
  const timeoutMs = Number(env.DEVELOPMENT_TIMEOUT_MS?.trim() || 3_600_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000)
    throw new Error("DEVELOPMENT_TIMEOUT_MS 必须是至少 60000 的整数");
  const concurrency = Number(env.DEVELOPMENT_CONCURRENCY?.trim() || 3);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10)
    throw new Error("DEVELOPMENT_CONCURRENCY 必须是 1 到 10 的整数");
  const cacheDir = resolve(env.DEVELOPMENT_CACHE_DIR?.trim() || "work/dev-cache");
  return { botId, secret, budgetTokens, timeoutMs, concurrency, cacheDir };
}
