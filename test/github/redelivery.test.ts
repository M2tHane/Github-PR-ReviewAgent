import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubApiError, GitHubClient, type WebhookDelivery } from "../../src/github/client.js";
import { planRedeliveries, redeliverFailedWebhooks } from "../../src/github/webhook/redelivery.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const now = new Date("2026-11-09T12:00:00Z");

function attempt(id: number, guid: string, agoMs: number, input: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id,
    guid,
    delivered_at: new Date(now.getTime() - agoMs).toISOString(),
    redelivery: false,
    status: "Service Unavailable",
    status_code: 503,
    event: "pull_request",
    action: "opened",
    ...input,
  };
}

test("补投判断：只补我们这边故障造成的失败", () => {
  const plan = planRedeliveries(
    [
      // 重投后已经成功，不再管它。
      attempt(11, "recovered", 10 * MINUTE, { redelivery: true, status_code: 202, status: "Accepted" }),
      attempt(10, "recovered", 60 * MINUTE),
      // 最新一次是 4xx：重投也会再失败。
      attempt(20, "bad-signature", 60 * MINUTE, { status_code: 401 }),
      attempt(31, "too-large", 10 * MINUTE, { redelivery: true, status_code: 413 }),
      attempt(30, "too-large", 60 * MINUTE),
      // GitHub 没连上或超时：status_code 是 0、null 或没有这个字段。
      attempt(40, "unreachable", 60 * MINUTE, { status_code: 0, status: "failed to connect to host" }),
      attempt(41, "timed-out", 61 * MINUTE, { status_code: null }),
      attempt(42, "no-code", 62 * MINUTE, { status_code: undefined }),
      attempt(50, "bad-gateway", 63 * MINUTE, { status_code: 502 }),
    ],
    now,
  );
  assert.deepEqual(plan, {
    redeliver: [
      { guid: "bad-gateway", attemptId: 50 },
      { guid: "no-code", attemptId: 42 },
      { guid: "timed-out", attemptId: 41 },
      { guid: "unreachable", attemptId: 40 },
    ],
    abandoned: [],
  });
});

test("补投判断：只补服务会处理的事件", () => {
  const plan = planRedeliveries(
    [
      attempt(1, "push", 60 * MINUTE, { event: "push", action: null }),
      attempt(2, "issue-comment", 60 * MINUTE, { event: "issue_comment", action: "created" }),
      attempt(3, "pr", 60 * MINUTE),
      attempt(4, "reply", 61 * MINUTE, { event: "pull_request_review_comment", action: "created" }),
      attempt(5, "install", 62 * MINUTE, { event: "installation", action: "deleted" }),
      attempt(6, "repos", 63 * MINUTE, { event: "installation_repositories", action: "removed" }),
    ],
    now,
  );
  assert.deepEqual(
    plan.redeliver.map((item) => item.attemptId),
    [6, 5, 4, 3],
  );
});

test("补投判断：最多重投 3 次，间隔 5 分钟、30 分钟、2 小时", () => {
  const SECOND = 1000;
  const delays = [5 * MINUTE, 30 * MINUTE, 120 * MINUTE];
  for (const [retries, delay] of delays.entries()) {
    // 已经重投过 retries 次，最新一次尝试距今 age。
    const history = (age: number) =>
      Array.from({ length: retries + 1 }, (_, index) =>
        attempt(100 + retries - index, "event", age + index * 3 * 60 * MINUTE, { redelivery: index < retries }),
      );
    assert.deepEqual(planRedeliveries(history(delay - SECOND), now), { redeliver: [], abandoned: [] });
    assert.deepEqual(planRedeliveries(history(delay), now), {
      redeliver: [{ guid: "event", attemptId: 100 + retries }],
      abandoned: [],
    });
  }
  // 已经重投 3 次仍失败：放弃，再久也不重投。
  const exhausted = [
    attempt(204, "event", 5 * 60 * MINUTE, { redelivery: true }),
    attempt(203, "event", 8 * 60 * MINUTE, { redelivery: true }),
    attempt(202, "event", 9 * 60 * MINUTE, { redelivery: true }),
    attempt(201, "event", 10 * 60 * MINUTE),
  ];
  assert.deepEqual(planRedeliveries(exhausted, now), { redeliver: [], abandoned: ["event"] });
});

test("补投判断：只看 3 天窗口内的记录，同一事件用最新一次尝试的 id", () => {
  const plan = planRedeliveries(
    [
      // 列表顺序不保证时也按时间取最新一次。
      attempt(300, "retried", 50 * MINUTE),
      attempt(301, "retried", 40 * MINUTE, { redelivery: true, status_code: 500 }),
      attempt(310, "edge", 3 * DAY),
      attempt(320, "expired", 3 * DAY + 1000),
      attempt(330, "broken-time", 0, { delivered_at: "not a date" }),
    ],
    now,
  );
  assert.deepEqual(plan, {
    redeliver: [
      { guid: "edge", attemptId: 310 },
      { guid: "retried", attemptId: 301 },
    ],
    abandoned: [],
  });
});

// GitHub 替身：按 cursor 分页返回投递记录，记录收到的重投请求。
function fakeGitHub(
  t: test.TestContext,
  pages: WebhookDelivery[][],
  redeliver: (attemptId: number) => Response = () => new Response("{}", { status: 202 }),
) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = { listed: [] as Array<string | null>, redelivered: [] as number[], authorization: new Set<string>() };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.authorization.add(String((init?.headers as Record<string, string> | undefined)?.authorization));
    const attemptId = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(url.pathname)?.[1];
    if (init?.method === "POST" && attemptId) {
      calls.redelivered.push(Number(attemptId));
      return redeliver(Number(attemptId));
    }
    assert.equal(url.pathname, "/app/hook/deliveries");
    assert.equal(url.searchParams.get("per_page"), "100");
    const cursor = url.searchParams.get("cursor");
    calls.listed.push(cursor);
    const page = cursor === null ? 0 : Number(cursor.replace("page-", ""));
    return new Response(JSON.stringify(pages[page] ?? []), {
      status: 200,
      headers:
        page + 1 < pages.length
          ? {
              link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=page-${page + 1}>; rel="next"`,
            }
          : {},
    });
  }) as typeof fetch;
  const logs: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: string) => logs.push(JSON.parse(line)));
  t.mock.method(console, "error", (line: string) => logs.push(JSON.parse(line)));
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { client: new GitHubClient("1", keys.privateKey), calls, logs };
}

test("补投：翻到窗口之前的记录就停，空响应体的 202 算成功，用 App JWT 认证", async (t) => {
  const { client, calls, logs } = fakeGitHub(
    t,
    [
      [attempt(3, "c", 10 * MINUTE), attempt(2, "b", 20 * MINUTE)],
      [attempt(1, "a", 30 * MINUTE), attempt(0, "old", 4 * DAY)],
      [attempt(-1, "never-read", 5 * DAY)],
    ],
    () => new Response(null, { status: 202 }),
  );
  const result = await redeliverFailedWebhooks(client, undefined, now);
  assert.deepEqual(calls.listed, [null, "page-1"]);
  assert.deepEqual(calls.redelivered, [1, 2, 3], "从旧到新重投");
  assert.deepEqual(result, { redelivered: 3, failed: 0, abandoned: 0, truncated: false });
  assert.deepEqual(logs, [{ event: "webhook_redelivery", redelivered: 3, failed: 0, abandoned: 0 }]);
  for (const authorization of calls.authorization) assert.match(authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.doesNotMatch(JSON.stringify(logs), /Bearer/);
});

test("补投：每轮最多翻 10 页，没看完时记日志", async (t) => {
  const pages = Array.from({ length: 12 }, (_, page) => [attempt(page + 1, `event-${page}`, (page + 10) * MINUTE)]);
  const { client, calls, logs } = fakeGitHub(t, pages);
  const result = await redeliverFailedWebhooks(client, undefined, now);
  assert.equal(calls.listed.length, 10);
  assert.deepEqual(calls.redelivered, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(result, { redelivered: 10, failed: 0, abandoned: 0, truncated: true });
  assert.deepEqual(logs[0], { event: "webhook_redelivery_truncated", pages: 10, deliveries: 10 });
});

test("补投：单个重投请求失败只记日志，其他事件照常重投", async (t) => {
  const { client, calls, logs } = fakeGitHub(
    t,
    [
      [
        attempt(3, "c", 10 * MINUTE),
        attempt(2, "b", 20 * MINUTE),
        attempt(1, "a", 30 * MINUTE),
        attempt(94, "gone", 40 * MINUTE, { redelivery: true }),
        attempt(93, "gone", 3 * 60 * MINUTE, { redelivery: true }),
        attempt(92, "gone", 4 * 60 * MINUTE, { redelivery: true }),
        attempt(91, "gone", 5 * 60 * MINUTE),
      ],
    ],
    (attemptId) => new Response("{}", { status: attemptId === 2 ? 422 : 202 }),
  );
  const result = await redeliverFailedWebhooks(client, undefined, now);
  assert.deepEqual(calls.redelivered, [1, 2, 3]);
  assert.deepEqual(result, { redelivered: 2, failed: 1, abandoned: 1, truncated: false });
  const failure = logs.find((entry) => entry.event === "webhook_redelivery_request_failed");
  assert.deepEqual(
    { deliveryId: failure?.deliveryId, attemptId: failure?.attemptId },
    { deliveryId: "b", attemptId: 2 },
  );
  assert.equal((failure?.error as { status?: number } | undefined)?.status, 422);
  assert.deepEqual(logs.at(-1), { event: "webhook_redelivery", redelivered: 2, failed: 1, abandoned: 1 });
});

test("补投：没有要重投的事件时不请求、不记日志；查询失败抛带状态码的错误", async (t) => {
  const { client, calls, logs } = fakeGitHub(t, [
    [attempt(2, "ok", 10 * MINUTE, { status_code: 202 }), attempt(1, "waiting", 2 * MINUTE)],
  ]);
  assert.deepEqual(await redeliverFailedWebhooks(client, undefined, now), {
    redelivered: 0,
    failed: 0,
    abandoned: 0,
    truncated: false,
  });
  assert.deepEqual(calls.redelivered, []);
  assert.deepEqual(logs, []);

  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  await assert.rejects(
    redeliverFailedWebhooks(client, undefined, now),
    (error) => error instanceof GitHubApiError && error.status === 503,
  );
});

test("补投：服务停止时中断本轮", async (t) => {
  const controller = new AbortController();
  const { client, calls } = fakeGitHub(t, [[attempt(2, "b", 10 * MINUTE), attempt(1, "a", 20 * MINUTE)]], () => {
    controller.abort(new Error("stopping"));
    return new Response("{}", { status: 202 });
  });
  await assert.rejects(redeliverFailedWebhooks(client, controller.signal, now), /stopping/);
  assert.deepEqual(calls.redelivered, [1]);
});
