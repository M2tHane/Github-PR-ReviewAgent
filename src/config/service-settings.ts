import type { Pool } from "pg";
import type { Config } from "./config.js";
import { transaction } from "../persistence/transaction.js";
import { log } from "../logging.js";
import { HEALTH_LIMITS } from "../health/health.service.js";

// 管理端可以修改的服务设置。值按 Config 里的单位保存（毫秒、天、token），页面按 scale 换算成分钟、小时等显示。
// 没有记录的项用启动时 .env 或代码里的默认值；凭据、地址、允许的仓库列表不在这里，只能改 .env。
export type SettingValue = number | boolean | string | null;

export interface SettingDefinition {
  key: string;
  group: string;
  label: string;
  help?: string;
  kind: "integer" | "boolean" | "text" | "choice";
  // 页面显示单位：存储值除以 scale 后显示。
  unit?: string;
  scale?: number;
  min?: number;
  max?: number;
  // 允许 0 表示关闭或永久保留，此时 0 不受 min 限制。
  zero?: string;
  // 允许留空；空值的含义写在这里。
  empty?: string;
  choices?: Array<{ value: string; label: string }>;
  // 只在启用群内开发时有意义。
  development?: boolean;
  read(config: Config): SettingValue;
  write(config: Config, value: SettingValue): void;
}

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
export const DEFAULT_REDELIVERY_INTERVAL_MS = 5 * MINUTE;
export const DEFAULT_PURGE_INTERVAL_MS = 6 * HOUR;
const thinking = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const SETTINGS: SettingDefinition[] = [
  {
    key: "AGENT_TIMEOUT_MS",
    group: "时限",
    label: "审查、回复复核、规则抽取的时限",
    help: "单次运行超过这个时间就结束，超时不重试。",
    kind: "integer",
    unit: "分钟",
    scale: MINUTE,
    min: MINUTE,
    max: DAY,
    read: (c) => c.agentTimeoutMs,
    write: (c, v) => {
      c.agentTimeoutMs = v as number;
    },
  },
  {
    key: "HEALTH_TIMEOUT_MS",
    group: "时限",
    label: "健康检查的时限",
    kind: "integer",
    unit: "秒",
    scale: 1000,
    min: 30_000,
    max: HOUR,
    read: (c) => c.healthTimeoutMs ?? HEALTH_LIMITS.timeoutMs,
    write: (c, v) => {
      c.healthTimeoutMs = v as number;
    },
  },
  {
    key: "DEVELOPMENT_TIMEOUT_MS",
    group: "时限",
    label: "开发任务的时限",
    help: "包含建索引和自动重试。",
    kind: "integer",
    unit: "分钟",
    scale: MINUTE,
    min: MINUTE,
    max: DAY,
    development: true,
    read: (c) => c.development?.timeoutMs ?? null,
    write: (c, v) => {
      if (c.development) c.development.timeoutMs = v as number;
    },
  },
  {
    key: "WEBHOOK_REDELIVERY_INTERVAL_MS",
    group: "定时任务",
    label: "检查漏掉的 Webhook 的间隔",
    kind: "integer",
    unit: "分钟",
    scale: MINUTE,
    min: MINUTE,
    max: 6 * HOUR,
    read: (c) => c.webhookRedeliveryIntervalMs ?? DEFAULT_REDELIVERY_INTERVAL_MS,
    write: (c, v) => {
      c.webhookRedeliveryIntervalMs = v as number;
    },
  },
  {
    key: "DATA_PURGE_INTERVAL_MS",
    group: "定时任务",
    label: "清理过期数据的间隔",
    kind: "integer",
    unit: "小时",
    scale: HOUR,
    min: HOUR,
    max: 7 * DAY,
    read: (c) => c.dataPurgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS,
    write: (c, v) => {
      c.dataPurgeIntervalMs = v as number;
    },
  },
  {
    key: "WEBHOOK_REDELIVERY_ENABLED",
    group: "定时任务",
    label: "自动补回漏掉的 Webhook",
    kind: "boolean",
    read: (c) => c.webhookRedelivery,
    write: (c, v) => {
      c.webhookRedelivery = v as boolean;
    },
  },
  {
    key: "DATA_RETENTION_DAYS",
    group: "数据保留",
    label: "已结束任务的保留天数",
    help: "含审查结果和 Agent 执行记录。调小后，下一次清理就会删除更早的数据。",
    kind: "integer",
    unit: "天",
    scale: 1,
    min: 7,
    max: 3650,
    zero: "永久保留",
    read: (c) => c.dataRetentionDays,
    write: (c, v) => {
      c.dataRetentionDays = v as number;
    },
  },
  {
    key: "REVOKED_DATA_GRACE_DAYS",
    group: "数据保留",
    label: "撤销授权后多少天删除仓库数据",
    help: "卸载 App 或移除仓库后开始计时，删除包括团队规则；暂停安装不算。",
    kind: "integer",
    unit: "天",
    scale: 1,
    min: 1,
    max: 3650,
    zero: "不删除",
    read: (c) => c.revokedDataGraceDays,
    write: (c, v) => {
      c.revokedDataGraceDays = v as number;
    },
  },
  {
    key: "MODEL_NAME",
    group: "模型",
    label: "模型名称",
    help: "所有审查、健康检查和开发任务共用。名称写错时任务会失败；服务商和 API key 只能在 .env 修改。",
    kind: "text",
    read: (c) => c.modelName,
    write: (c, v) => {
      c.modelName = v as string;
    },
  },
  {
    key: "MODEL_THINKING",
    group: "模型",
    label: "思考强度",
    kind: "choice",
    empty: "不指定（用模型默认）",
    choices: thinking.map((value) => ({ value, label: value })),
    read: (c) => c.modelEndpoint?.thinkingLevel ?? null,
    write: (c, v) => {
      c.modelEndpoint ??= { api: "openai-completions" };
      c.modelEndpoint.thinkingLevel = (v ?? undefined) as NonNullable<Config["modelEndpoint"]>["thinkingLevel"];
    },
  },
  {
    key: "VULNERABILITY_SCAN_ENABLED",
    group: "健康检查",
    label: "查询依赖的已知漏洞（OSV）",
    help: "会把锁文件里的包名和版本发给 OSV，私有仓库的内部包名也会发出去。",
    kind: "boolean",
    read: (c) => c.vulnerabilityScan,
    write: (c, v) => {
      c.vulnerabilityScan = v as boolean;
    },
  },
  {
    key: "SAST_SCAN_ENABLED",
    group: "健康检查",
    label: "用 Semgrep 扫描源码",
    kind: "boolean",
    read: (c) => c.sastScan,
    write: (c, v) => {
      c.sastScan = v as boolean;
    },
  },
  {
    key: "WORKER_CONCURRENCY",
    group: "并发与额度",
    label: "每个实例同时执行的任务数",
    help: "同一个 PR 的任务仍然一个一个来。调小时正在跑的任务不受影响，跑完后才按新值领取。",
    kind: "integer",
    scale: 1,
    min: 1,
    max: 20,
    read: (c) => c.workerConcurrency,
    write: (c, v) => {
      c.workerConcurrency = v as number;
    },
  },
  {
    key: "DEVELOPMENT_CONCURRENCY",
    group: "并发与额度",
    label: "同时进行的开发任务数",
    kind: "integer",
    scale: 1,
    min: 1,
    max: 10,
    development: true,
    read: (c) => c.development?.concurrency ?? null,
    write: (c, v) => {
      if (c.development) c.development.concurrency = v as number;
    },
  },
  {
    key: "QUEUE_CAPACITY",
    group: "并发与额度",
    label: "开发任务排队上限",
    help: "排队和进行中的开发任务达到这个数时，新任务会被拒绝。",
    kind: "integer",
    scale: 1,
    min: 1,
    max: 1000,
    development: true,
    read: (c) => c.queueCapacity,
    write: (c, v) => {
      c.queueCapacity = v as number;
    },
  },
  {
    key: "DEVELOPMENT_BUDGET_TOKENS",
    group: "并发与额度",
    label: "每个开发任务的 token 上限",
    help: "整个任务（含重试）共用这一额度。",
    kind: "integer",
    unit: "token",
    scale: 1,
    min: 1000,
    max: 1_000_000_000,
    empty: "不限制",
    development: true,
    read: (c) => c.development?.budgetTokens ?? null,
    write: (c, v) => {
      if (c.development) c.development.budgetTokens = (v ?? undefined) as number | undefined;
    },
  },
];

const byKey = new Map(SETTINGS.map((item) => [item.key, item]));

// 校验一个值，返回错误说明；通过时返回 undefined。存储的值和页面提交的值都用它检查。
export function settingError(definition: SettingDefinition, value: unknown): string | undefined {
  if (value === null) return definition.empty ? undefined : "不能为空";
  if (definition.kind === "boolean") return typeof value === "boolean" ? undefined : "只能是开或关";
  if (definition.kind === "text") {
    if (typeof value !== "string" || !value.trim()) return "不能为空";
    return /^[\w.:/@-]{1,100}$/.test(value) ? undefined : "只能包含字母、数字和 . _ - : / @，最多 100 个字符";
  }
  if (definition.kind === "choice")
    return definition.choices!.some((choice) => choice.value === value) ? undefined : "不是可选的值";
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "必须是整数";
  if (value === 0 && definition.zero) return undefined;
  const scale = definition.scale ?? 1;
  if (value % scale) return `必须是整${definition.unit ?? ""}`;
  if (value < definition.min! || value > definition.max!)
    return `范围是 ${definition.min! / scale}–${definition.max! / scale}${definition.unit ? ` ${definition.unit}` : ""}${definition.zero ? `，或 0（${definition.zero}）` : ""}`;
  return undefined;
}

export interface SettingState {
  key: string;
  value: SettingValue;
  defaultValue: SettingValue;
  updatedBy?: string;
  updatedAt?: string;
}

export interface SettingAudit {
  key: string;
  oldValue: SettingValue | undefined;
  newValue: SettingValue | undefined;
  actor: string;
  createdAt: string;
}

export class SettingsValidationError extends Error {}

// 启动时记下默认值，之后定时（默认 30 秒）读数据库，把管理端改过的值写进共享的 config 对象。
// 各处在用到时读 config，所以改完后下一个任务就按新值走；多个实例最多晚 30 秒一致。
export class ServiceSettings {
  private readonly defaults = new Map<string, SettingValue>();
  private rows = new Map<string, { value: SettingValue; updatedBy: string; updatedAt: string }>();
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly pool: Pool,
    private readonly onChange: (keys: string[]) => void = () => undefined,
  ) {
    for (const item of SETTINGS) this.defaults.set(item.key, item.read(config));
  }

  // 表还不存在（没跑迁移）或数据库暂时不可用时保留当前值，记日志，不影响服务运行。
  refresh(): Promise<void> {
    this.refreshing ??= this.load()
      .catch((error) => log("error", "service_settings_refresh_failed", {}, error))
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async load() {
    const rows = (await this.pool.query("SELECT key,value,updated_by,updated_at FROM service_settings")).rows;
    const next = new Map<string, { value: SettingValue; updatedBy: string; updatedAt: string }>();
    for (const row of rows) {
      const definition = byKey.get(row.key);
      if (!definition) continue;
      const error = settingError(definition, row.value);
      if (error) {
        log("error", "service_setting_invalid", { key: row.key, error });
        continue;
      }
      next.set(row.key, {
        value: row.value,
        updatedBy: row.updated_by,
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    }
    this.rows = next;
    const changed: string[] = [];
    for (const item of SETTINGS) {
      if (item.development && !this.config.development) continue;
      const value = next.has(item.key) ? next.get(item.key)!.value : this.defaults.get(item.key)!;
      if (item.read(this.config) === value) continue;
      item.write(this.config, value);
      changed.push(item.key);
    }
    if (changed.length) {
      log("info", "service_settings_applied", { keys: changed });
      this.onChange(changed);
    }
  }

  async list(): Promise<{ settings: SettingState[]; audits: SettingAudit[] }> {
    await this.load();
    const audits = (
      await this.pool.query(
        "SELECT key,old_value,new_value,actor,created_at FROM service_setting_audits ORDER BY created_at DESC,id DESC LIMIT 20",
      )
    ).rows.map((row) => ({
      key: row.key,
      oldValue: row.old_value ? row.old_value.v : undefined,
      newValue: row.new_value ? row.new_value.v : undefined,
      actor: row.actor,
      createdAt: new Date(row.created_at).toISOString(),
    }));
    return {
      settings: SETTINGS.filter((item) => !item.development || this.config.development).map((item) => {
        const row = this.rows.get(item.key);
        return {
          key: item.key,
          value: row ? row.value : this.defaults.get(item.key)!,
          defaultValue: this.defaults.get(item.key)!,
          ...(row ? { updatedBy: row.updatedBy, updatedAt: row.updatedAt } : {}),
        };
      }),
      audits,
    };
  }

  // changes 里的 value 为 undefined 表示恢复默认（删除记录）。全部校验通过才写入，同一个事务。
  async update(changes: Record<string, SettingValue | undefined>, actor: string) {
    const entries = Object.entries(changes);
    if (!entries.length) throw new SettingsValidationError("没有要修改的设置");
    const errors: string[] = [];
    for (const [key, value] of entries) {
      const definition = byKey.get(key);
      if (!definition || (definition.development && !this.config.development)) errors.push(`${key}：不能修改`);
      else if (value !== undefined) {
        const error = settingError(definition, value);
        if (error) errors.push(`${definition.label}：${error}`);
      }
    }
    if (errors.length) throw new SettingsValidationError(errors.join("；"));
    const client = await this.pool.connect();
    try {
      await transaction(client, async () => {
        for (const [key, value] of entries) {
          const old = await client.query("SELECT value FROM service_settings WHERE key=$1 FOR UPDATE", [key]);
          const oldValue = old.rows[0] ? old.rows[0].value : null;
          if (value === undefined) {
            if (!old.rowCount) continue;
            await client.query("DELETE FROM service_settings WHERE key=$1", [key]);
          } else {
            if (old.rowCount && oldValue === value) continue;
            await client.query(
              "INSERT INTO service_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()",
              [key, JSON.stringify(value), actor],
            );
          }
          await client.query(
            "INSERT INTO service_setting_audits(key,old_value,new_value,actor) VALUES($1,$2,$3,$4)",
            // 包一层 {v}：值本身可能是 null（不限制、不指定），和“默认值”（SQL NULL）区分开。
            [key, old.rowCount ? { v: oldValue } : null, value === undefined ? null : { v: value }, actor],
          );
        }
      });
    } finally {
      client.release();
    }
    log("info", "service_settings_updated", { keys: entries.map(([key]) => key), actor });
    return this.list();
  }
}
