import assert from "node:assert/strict";
import test from "node:test";
import { loadWecomConfig } from "../../src/notifications/config.js";
import { parseNotificationMember } from "../../src/notifications/members.js";
import { notificationMessage, WecomClient } from "../../src/notifications/wecom.js";

const env = {
  WECOM_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret",
};
const notification = {
  jobId: "job",
  repositoryId: 1,
  installationId: 1,
  repository: "owner/repo",
  prNumber: 12,
  headSha: "abcdef012345",
  partial: false,
  attempt: 1,
};

test("企微配置：默认关闭、哈希绑定目标群", () => {
  assert.equal(loadWecomConfig({}), undefined);
  const config = loadWecomConfig(env)!;
  assert.equal(config.channel.length, 64);
  assert(!config.channel.includes("test-secret"));
  assert.notEqual(config.channel, loadWecomConfig({ WECOM_WEBHOOK_URL: env.WECOM_WEBHOOK_URL + "2" })!.channel);
});

test("企微配置：拒绝非官方 Webhook，错误不带密钥", () => {
  for (const url of [
    "https://evil.example/send?key=test-secret",
    "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret",
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret&key=other",
    "https://user:test-secret@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret",
    "test-secret",
  ])
    assert.throws(
      () => loadWecomConfig({ WECOM_WEBHOOK_URL: url }),
      (error: Error) => !error.message.includes("test-secret"),
    );
});

test("成员输入：规范化登录名、拒绝额外字段、非法成员 ID 和 @all", () => {
  assert.deepEqual(parseNotificationMember({ githubLogin: " Alice ", wecomUserId: " ZhangSan " }), {
    githubLogin: "alice",
    wecomUserId: "ZhangSan",
  });
  for (const input of [
    null,
    [],
    {},
    { githubLogin: "alice" },
    { githubLogin: "alice", wecomUserId: "@all" },
    { githubLogin: "alice", wecomUserId: "@ALL" },
    { githubLogin: "alice", wecomUserId: "<@all>" },
    { githubLogin: "alice", wecomUserId: 123 },
    { githubLogin: "bad login", wecomUserId: "userid" },
    { githubLogin: "alice", wecomUserId: "userid", repositoryId: 99 },
  ])
    assert.equal(parseNotificationMember(input), undefined);
});

test("通知首行 @ 成员，分行展示状态、项目及短链接，不含提交 SHA", () => {
  const message = notificationMessage(notification, "zhangsan", "修复订单金额计算");
  assert.equal(message.msgtype, "markdown");
  assert(message.markdown.content.startsWith("<@zhangsan>\n\n"));
  assert(!message.markdown.content.includes(notification.headSha.slice(0, 7)));
  assert.match(message.markdown.content, /\n> 项目：owner\/repo\n> PR：#12 修复订单金额计算\n> \[查看审查结果\]/);
  assert.match(message.markdown.content, /AI 审查已完成/);
  assert.match(message.markdown.content, /https:\/\/github.com\/owner\/repo\/pull\/12/);
  assert.match(
    notificationMessage({ ...notification, partial: true }, "zhangsan", "修复订单金额计算").markdown.content,
    /部分检查未完成/,
  );
});

test("企微发送：使用普通 Markdown 首行 @，不跟随跳转，只有 errcode=0 才标为发送成功", async () => {
  let requests = 0;
  const client = new WecomClient(env.WECOM_WEBHOOK_URL, async (url, init) => {
    requests++;
    assert.equal(url, env.WECOM_WEBHOOK_URL);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert(init?.signal);
    assert(JSON.parse(init?.body as string).markdown.content.startsWith("<@zhangsan>\n"));
    return Response.json({ errcode: 0, errmsg: "ok" });
  });
  assert.deepEqual(
    await client.send(notificationMessage(notification, "zhangsan", "修复订单金额计算"), new AbortController().signal),
    {
      status: "sent",
    },
  );
  assert.equal(requests, 1);
});

test("企微发送：仅明确限流/繁忙可重试，超时或坏响应保留 uncertain 且不泄露密钥", async () => {
  const cases: [() => Promise<Response>, string][] = [
    [async () => Response.json({ errcode: 45009 }), "pending"],
    [async () => Response.json({ errcode: -1 }), "pending"],
    [async () => Response.json({ errcode: 93000, errmsg: env.WECOM_WEBHOOK_URL }), "failed"],
    [async () => Response.json({ errcode: "0" }), "uncertain"],
    [async () => new Response("bad json"), "uncertain"],
    [async () => new Response("error", { status: 500 }), "uncertain"],
    [
      async () => {
        throw new Error(env.WECOM_WEBHOOK_URL);
      },
      "uncertain",
    ],
  ];
  for (const [request, status] of cases) {
    const result = await new WecomClient(env.WECOM_WEBHOOK_URL, request).send(
      notificationMessage(notification, "zhangsan", "修复订单金额计算"),
      new AbortController().signal,
    );
    assert.equal(result.status, status);
    assert(!JSON.stringify(result).includes("test-secret"));
  }
});

test("PR 标题中的换行、链接和 @ 语法不会改变通知结构", () => {
  const message = notificationMessage(notification, "zhangsan", "fix\n<@all> [fake](https://example.com)");
  assert.equal(message.markdown.content.match(/<@/g)?.length, 1);
  assert(message.markdown.content.includes("PR：#12 fix &lt;@all&gt;"));
  assert(!message.markdown.content.includes("[fake](https://example.com)"));
  assert.equal(message.markdown.content.split("\n").length, 6);
});
