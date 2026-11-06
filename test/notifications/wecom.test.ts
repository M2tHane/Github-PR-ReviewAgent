import assert from "node:assert/strict";
import test from "node:test";
import { loadWecomConfig } from "../../src/notifications/config.js";
import { parseNotificationMember } from "../../src/notifications/members.js";
import { notificationMessage, deliverBotNotification } from "../../src/notifications/wecom.js";

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
  chatId: "group",
  bindingVersion: 1,
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

test("审查通知直接展示状态、项目和链接，不含成员提及或提交 SHA", () => {
  const message = notificationMessage(notification, "修复订单金额计算");
  assert.equal(message.msgtype, "markdown");
  assert(message.markdown.content.startsWith("**AI 审查已完成**"));
  assert(!message.markdown.content.includes(notification.headSha.slice(0, 7)));
  assert.match(message.markdown.content, /\n> 项目：owner\/repo\n> PR：#12 修复订单金额计算\n> \[查看审查结果\]/);
  assert.match(message.markdown.content, /AI 审查已完成/);
  assert.match(message.markdown.content, /https:\/\/github.com\/owner\/repo\/pull\/12/);
  assert.match(
    notificationMessage({ ...notification, partial: true }, "修复订单金额计算").markdown.content,
    /部分检查未完成/,
  );
});

test("智能机器人发送：仅明确拒收可重试，未知结果不重发或记录原始错误", async () => {
  assert.deepEqual(await deliverBotNotification(async () => {}), { status: "sent" });
  for (const [error, status] of [
    [{ errcode: 45009 }, "pending"],
    [{ errcode: -1 }, "pending"],
    [{ errcode: 40008, errmsg: "test-secret" }, "failed"],
    [new Error("test-secret"), "uncertain"],
    [{ errcode: "0" }, "uncertain"],
  ] as const) {
    const result = await deliverBotNotification(async () => {
      throw error;
    });
    assert.equal(result.status, status);
    assert(!JSON.stringify(result).includes("test-secret"));
  }
});

test("PR 标题中的换行、链接和 @ 语法不会改变通知结构", () => {
  const message = notificationMessage(notification, "fix\n<@all> [fake](https://example.com)");
  assert(!message.markdown.content.includes("<@"));
  assert(message.markdown.content.includes("PR：#12 fix &lt;@all&gt;"));
  assert(!message.markdown.content.includes("[fake](https://example.com)"));
  assert.equal(message.markdown.content.split("\n").length, 4);
});
