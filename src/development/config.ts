export interface DevelopmentConfig {
  botId: string;
  secret: string;
  budgetTokens: number;
}
export function loadDevelopmentConfig(env: NodeJS.ProcessEnv): DevelopmentConfig | undefined {
  const botId = env.WECOM_BOT_ID?.trim(),
    secret = env.WECOM_BOT_SECRET?.trim();
  if (!botId && !secret) return;
  if (!botId || !secret) throw new Error("WECOM_BOT_ID 和 WECOM_BOT_SECRET 必须一起配置");
  const budgetTokens = Number(env.DEVELOPMENT_BUDGET_TOKENS ?? 160_000);
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1000)
    throw new Error("DEVELOPMENT_BUDGET_TOKENS 必须是至少 1000 的整数");
  return { botId, secret, budgetTokens };
}
