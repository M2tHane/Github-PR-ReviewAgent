import type { GitHubClient, WebhookDelivery } from "../client.js";
import { log } from "../../logging.js";
import { HANDLED_EVENTS } from "./handler.js";

// 漏投递补偿：入口回 5xx 或没响应时 GitHub 不会自己重投。这里定时查 App 的投递记录，
// 让 GitHub 把因为我们这边故障而失败的事件再发一遍；重投走原来的 Webhook 入口，验签和去重都不变。
// 判断全部来自 GitHub 返回的记录，本地不存状态。

// GitHub 只允许重投最近 3 天内的投递。
const WINDOW_MS = 3 * 24 * 60 * 60_000;
// 每轮最多翻 10 页（每页 100 条），避免故障期间积压很多时一直翻下去。
const MAX_PAGES = 10;
// 每个事件最多重投 3 次，距离它最新一次尝试分别过去 5 分钟、30 分钟、2 小时才发下一次：
// 短故障很快补上，长故障不会在几分钟内把次数用完。
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export interface RedeliveryPlan {
  // 要请求重投的事件，attemptId 是该事件最新一次尝试的 id；按时间从旧到新。
  redeliver: Array<{ guid: string; attemptId: number }>;
  // 已经重投满次数仍然失败的事件，不再重投。
  abandoned: string[];
}

export interface RedeliveryResult {
  redelivered: number;
  failed: number;
  abandoned: number;
  // 翻满页数上限仍没看完窗口内的记录。
  truncated: boolean;
}

// 0 或缺失表示 GitHub 没连上或等到超时，和 5xx 一样是我们这边的故障；
// 4xx（验签失败、请求体过大等）重投也会再失败，不补。
function failedOnOurSide(statusCode: number | null | undefined) {
  return !statusCode || statusCode >= 500;
}

export function planRedeliveries(deliveries: WebhookDelivery[], now: Date): RedeliveryPlan {
  const cutoff = now.getTime() - WINDOW_MS;
  // 同一个事件的每次尝试共用 guid，按它分组后一起判断。
  const groups = new Map<string, Array<{ delivery: WebhookDelivery; at: number }>>();
  for (const delivery of deliveries) {
    const at = Date.parse(delivery?.delivered_at);
    if (!Number.isSafeInteger(delivery?.id) || typeof delivery.guid !== "string" || !(at >= cutoff)) continue;
    const attempts = groups.get(delivery.guid);
    if (attempts) attempts.push({ delivery, at });
    else groups.set(delivery.guid, [{ delivery, at }]);
  }
  const plan: RedeliveryPlan = { redeliver: [], abandoned: [] };
  for (const [guid, attempts] of groups) {
    attempts.sort((a, b) => b.at - a.at || b.delivery.id - a.delivery.id);
    const latest = attempts[0];
    if (!HANDLED_EVENTS.has(latest.delivery.event)) continue;
    if (attempts.some(({ delivery }) => Number(delivery.status_code) >= 200 && Number(delivery.status_code) < 300))
      continue;
    if (!failedOnOurSide(latest.delivery.status_code)) continue;
    const retries = attempts.filter(({ delivery }) => delivery.redelivery === true).length;
    if (retries >= RETRY_DELAYS_MS.length) plan.abandoned.push(guid);
    else if (now.getTime() - latest.at >= RETRY_DELAYS_MS[retries])
      plan.redeliver.push({ guid, attemptId: latest.delivery.id });
  }
  // 记录是从新到旧的；先补旧事件，同一个 PR 的事件尽量按原来的先后到达。
  plan.redeliver.reverse();
  return plan;
}

export async function redeliverFailedWebhooks(
  github: Pick<GitHubClient, "listWebhookDeliveries" | "redeliverWebhook">,
  signal?: AbortSignal,
  now = new Date(),
): Promise<RedeliveryResult> {
  const cutoff = now.getTime() - WINDOW_MS;
  const deliveries: WebhookDelivery[] = [];
  let cursor: string | undefined;
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await github.listWebhookDeliveries(cursor, signal);
    deliveries.push(...batch.deliveries);
    cursor = batch.nextCursor;
    // 记录从新到旧：没有下一页，或已经翻到窗口之前的记录，就不用再往回看。
    if (!cursor || batch.deliveries.some((delivery) => Date.parse(delivery?.delivered_at) < cutoff)) {
      truncated = false;
      break;
    }
  }
  if (truncated) log("info", "webhook_redelivery_truncated", { pages: MAX_PAGES, deliveries: deliveries.length });

  const plan = planRedeliveries(deliveries, now);
  let redelivered = 0;
  let failed = 0;
  for (const { guid, attemptId } of plan.redeliver) {
    signal?.throwIfAborted();
    try {
      await github.redeliverWebhook(attemptId, signal);
      redelivered++;
    } catch (error) {
      if (signal?.aborted) throw error;
      // 单个事件重投失败（例如 GitHub 回 422）不影响其他事件，下一轮还会再判断它。
      failed++;
      log("error", "webhook_redelivery_request_failed", { deliveryId: guid, attemptId }, error);
    }
  }
  if (plan.redeliver.length)
    log("info", "webhook_redelivery", { redelivered, failed, abandoned: plan.abandoned.length });
  return { redelivered, failed, abandoned: plan.abandoned.length, truncated };
}
