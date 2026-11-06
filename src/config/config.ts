import { readFileSync } from "node:fs";
import { loadWecomConfig, type WecomConfig } from "../notifications/config.js";

import { loadDevelopmentConfig, type DevelopmentConfig } from "../development/config.js";

export interface Config {
  development?: DevelopmentConfig;
  wecom?: WecomConfig;
  appId: string;
  privateKey: string;
  webhookSecret: string;
  allowedRepositories: Set<string>;
  databaseUrl: string;
  modelProvider: string;
  modelName: string;
  modelApiKey: string;
  modelEndpoint?: ModelEndpoint;
  port: number;
  webhookMaxBytes: number;
  queueCapacity: number;
  agentTimeoutMs: number;
  githubClientId?: string;
  githubClientSecret?: string;
  githubOAuthCallbackUrl?: string;
  sessionSecret?: string;
  // 健康检查时把锁文件里的"包名 + 版本"发给 OSV 查已知漏洞；私有仓库的内部包名也会发出去。
  vulnerabilityScan: boolean;
  // 健康检查用本地规则跑 Semgrep；只解析代码，不构建、不运行仓库脚本。
  sastScan: boolean;
  semgrepPath: string;
  // 每个实例同时执行的任务数；同一仓库的 PR 任务仍然一个一个来。
  workerConcurrency: number;
  // 已结束任务（含审查结果、Agent 记录）保留天数，0 表示永久保留。
  dataRetentionDays: number;
  // 卸载 App 或移除仓库后，再等多少天删除该仓库的全部数据（含团队规则），0 表示不删除。
  revokedDataGraceDays: number;
}

// 自定义模型服务（OpenAI 兼容网关等）。不填 baseUrl 时使用 Pi 内置的厂商配置。
export interface ModelEndpoint {
  baseUrl?: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

const modelApis = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function modelEndpoint(env: NodeJS.ProcessEnv): ModelEndpoint {
  const baseUrl = env.MODEL_BASE_URL?.trim() || undefined;
  const api = env.MODEL_API?.trim() || "openai-completions";
  const thinkingLevel = env.MODEL_THINKING?.trim() || undefined;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error("配置 MODEL_BASE_URL 必须是 http(s) 地址");
  if (!modelApis.has(api)) throw new Error(`配置 MODEL_API 只能是 ${[...modelApis].join(" / ")}`);
  if (thinkingLevel && !thinkingLevels.has(thinkingLevel))
    throw new Error(`配置 MODEL_THINKING 只能是 ${[...thinkingLevels].join(" / ")}`);
  return { baseUrl, api: api as ModelEndpoint["api"], thinkingLevel: thinkingLevel as ModelEndpoint["thinkingLevel"] };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少配置 ${name}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`配置 ${name} 必须是正整数`);
  return value;
}

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]?.trim() || fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`配置 ${name} 必须是非负整数`);
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "on"].includes(value)) return true;
  if (["false", "0", "off"].includes(value)) return false;
  throw new Error(`配置 ${name} 只能是 true / false`);
}

export function loadConfig(env = process.env): Config {
  const repositories = required(env, "GITHUB_ALLOWED_REPOSITORIES")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!repositories.every((x) => /^[^/\s]+\/[^/\s]+$/.test(x)))
    throw new Error("配置 GITHUB_ALLOWED_REPOSITORIES 格式错误");
  const privateKeyPath = required(env, "GITHUB_PRIVATE_KEY_PATH");
  let privateKey: string;
  try {
    privateKey = readFileSync(privateKeyPath, "utf8");
  } catch {
    throw new Error("无法读取 GITHUB_PRIVATE_KEY_PATH");
  }
  return {
    wecom: loadWecomConfig(env),
    development: loadDevelopmentConfig(env),
    appId: required(env, "GITHUB_APP_ID"),
    privateKey,
    webhookSecret: required(env, "GITHUB_WEBHOOK_SECRET"),
    allowedRepositories: new Set(repositories),
    databaseUrl: required(env, "DATABASE_URL"),
    modelProvider: required(env, "MODEL_PROVIDER"),
    modelName: required(env, "MODEL_NAME"),
    modelApiKey: required(env, "MODEL_API_KEY"),
    modelEndpoint: modelEndpoint(env),
    port: positiveInt(env, "PORT", 3000),
    webhookMaxBytes: positiveInt(env, "WEBHOOK_MAX_BYTES", 1_048_576),
    queueCapacity: positiveInt(env, "QUEUE_CAPACITY", 20),
    agentTimeoutMs: positiveInt(env, "AGENT_TIMEOUT_MS", 300_000),
    githubClientId: env.GITHUB_CLIENT_ID?.trim() || undefined,
    githubClientSecret: env.GITHUB_CLIENT_SECRET?.trim() || undefined,
    githubOAuthCallbackUrl: env.GITHUB_OAUTH_CALLBACK_URL?.trim() || undefined,
    sessionSecret: env.SESSION_SECRET?.trim() || undefined,
    vulnerabilityScan: flag(env, "VULNERABILITY_SCAN_ENABLED", true),
    sastScan: flag(env, "SAST_SCAN_ENABLED", true),
    semgrepPath: env.SEMGREP_PATH?.trim() || "semgrep",
    workerConcurrency: positiveInt(env, "WORKER_CONCURRENCY", 2),
    dataRetentionDays: nonNegativeInt(env, "DATA_RETENTION_DAYS", 90),
    revokedDataGraceDays: nonNegativeInt(env, "REVOKED_DATA_GRACE_DAYS", 30),
  };
}
