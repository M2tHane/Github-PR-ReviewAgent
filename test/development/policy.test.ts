import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  enforceProtections,
  parseDevelopmentResult,
  parseSettings,
  safePath,
  validBranch,
} from "../../src/development/policy.js";
import { parseGroupMessage, developmentMessage } from "../../src/development/messages.js";
import { downloadImage } from "../../src/development/images.js";
import { requestTokenBudget } from "../../src/review/agent.js";
import { loadDevelopmentConfig } from "../../src/development/config.js";
import type { DevelopmentTask } from "../../src/development/types.js";

const rules = [{ name: "账务保护", paths: ["src/billing/**", "config/prod.json"], reason: "由管理员维护" }];
test("保护规则覆盖文件、目录、删除和目录自身；管理员可修改且不改变规则", () => {
  const before = JSON.stringify(rules);
  for (const path of ["src/billing/a.ts", "src/billing", "config/prod.json"]) {
    assert.throws(() => enforceProtections(["safe.ts", path], "developer", rules), /已拒绝整个任务/);
    enforceProtections([path], "admin", rules);
  }
  enforceProtections(["src/billing-v2/a.ts"], "developer", rules);
  assert.throws(
    () => enforceProtections(["a.ts"], "developer", [{ name: "all", paths: ["**"], reason: "locked" }]),
    /仅管理员/,
  );
  assert.equal(JSON.stringify(rules), before);
});
test("管理输入拒绝身份伪造、重复成员、无管理员、无效路径和分支", () => {
  const settings = {
    chatId: "wr_group",
    targetBranch: "release/v2",
    enabled: true,
    version: 0,
    members: [{ userid: "alice", role: "admin" }],
    protections: rules,
  };
  assert.equal(parseSettings(settings).targetBranch, "release/v2");
  for (const members of [
    [{ userid: "@all", role: "admin" }],
    [{ userid: "alice", role: "developer" }],
    [{ userid: "alice", role: "owner" }],
    [...settings.members, ...settings.members],
  ])
    assert.throws(() => parseSettings({ ...settings, members }));
  assert.throws(() => parseSettings({ ...settings, repositoryId: 123 }));
  for (const path of [
    "../etc/passwd",
    "a/../../secret",
    "/tmp/x",
    "a\\b",
    ".git/config",
    "foo/.GIT/hooks/x",
    "a//b",
    "a\0b",
  ])
    assert.throws(() => safePath(path));
  for (const branch of ["--help", "x..y", "x.lock", "foo/.bar", "a b", "x@{1}", "a/"])
    assert.throws(() => validBranch(branch));
  assert.equal(
    parseSettings({ ...settings, protections: [{ ...rules[0], paths: ["src/billing/"] }] }).protections[0].paths[0],
    "src/billing/**",
  );
});
test("开发结果只含标题和说明，不得夹带身份或改动，refusal 拒绝整个任务", () => {
  const result = { title: "修复", summary: "修复内容", refusal: "" };
  assert.deepEqual(parseDevelopmentResult(result), { title: "修复", summary: "修复内容" });
  assert.throws(() => parseDevelopmentResult({ ...result, role: "admin" }));
  assert.throws(() => parseDevelopmentResult({ ...result, changes: [{ path: "file.ts", content: null }] }));
  assert.throws(() => parseDevelopmentResult({ ...result, title: "" }));
  assert.throws(() => parseDevelopmentResult({ ...result, refusal: "缺少明确目标" }), /缺少明确目标/);
});
test("图文从可信回调读取身份，拒绝其他 Bot、私聊、空需求及过量图片", () => {
  const body = {
    aibotid: "bot",
    msgid: "msg",
    chattype: "group",
    chatid: "group",
    from: { userid: "alice" },
    msgtype: "mixed",
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "按截图修改按钮" } },
        { msgtype: "image", image: { url: "https://wework.qpic.cn/a", aeskey: "key" } },
      ],
    },
  };
  const parsed = parseGroupMessage(body, "bot");
  assert.equal(parsed.requester, "alice");
  assert.equal(parsed.images.length, 1);
  for (const patch of [{ aibotid: "other" }, { chattype: "single" }, { from: { userid: "@all" } }, { msgtype: "file" }])
    assert.throws(() => parseGroupMessage({ ...body, ...patch }, "bot"));
  assert.throws(() =>
    parseGroupMessage({ ...body, mixed: { msg_item: Array(5).fill(body.mixed.msg_item[1]) } }, "bot"),
  );
});
test("图片下载限制地址、大小、跳转，解密 PNG 并保留真实图片输入", async () => {
  const key = randomBytes(32),
    png = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(100, 20);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([png, Buffer.alloc(32, 32)])), cipher.final()]);
  let calls = 0;
  const request: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    return new Response(encrypted);
  };
  const input = { url: "https://wework.qpic.cn/test", aeskey: key.toString("base64") };
  const image = await downloadImage(input, new AbortController().signal, request);
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.data, "base64"), png);
  const officialUrl = "https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/test?sign=example-signature";
  const officialImage = await downloadImage(
    { ...input, url: officialUrl },
    new AbortController().signal,
    async (url, init) => {
      assert.equal(String(url), officialUrl);
      return request(url, init);
    },
  );
  assert.deepEqual(Buffer.from(officialImage.data, "base64"), png);
  for (const url of [
    "http://wework.qpic.cn/a",
    "https://localhost/a",
    "https://wework.qpic.cn.evil.test/a",
    "https://user:pass@wework.qpic.cn/a",
    "http://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/a",
    "https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com.evil.test/a",
    "https://evil.ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/a",
    "https://other-bucket.cos.ap-guangzhou.myqcloud.com/a",
    "https://user:pass@ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/a",
    "https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com:8443/a",
  ])
    await assert.rejects(downloadImage({ ...input, url }, new AbortController().signal, request));
  assert.equal(calls, 2);
  await assert.rejects(
    downloadImage(input, new AbortController().signal, async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 33))),
    /2 MB/,
  );
});
test("图像预算保留视觉 token，不把 base64 当正文；机器人配置成对校验", () => {
  const data = "A".repeat(200_000);
  assert.throws(() => requestTokenBudget({ url: `data:image/png;base64,${data}` }, 20_000, [{ data }]));
  const budget = requestTokenBudget({ url: `data:image/png;base64,${data}` }, 160_000, [{ data }]);
  assert(budget.reservedTokens > 32768 && budget.reservedTokens < 60_000);
  assert.equal(loadDevelopmentConfig({}), undefined);
  assert.throws(() => loadDevelopmentConfig({ WECOM_BOT_ID: "bot" }));
  const bot = { WECOM_BOT_ID: "bot", WECOM_BOT_SECRET: "secret" };
  assert.equal(loadDevelopmentConfig(bot)?.budgetTokens, undefined, "未设置预算时不限制");
  assert.equal(loadDevelopmentConfig(bot)?.timeoutMs, 3_600_000, "开发任务默认 1 小时");
  assert.equal(loadDevelopmentConfig({ ...bot, DEVELOPMENT_BUDGET_TOKENS: "" })?.budgetTokens, undefined);
  assert.equal(loadDevelopmentConfig({ ...bot, DEVELOPMENT_BUDGET_TOKENS: "500000" })?.budgetTokens, 500_000);
  assert.throws(() => loadDevelopmentConfig({ ...bot, DEVELOPMENT_BUDGET_TOKENS: "abc" }));
  assert.throws(() => loadDevelopmentConfig({ ...bot, DEVELOPMENT_TIMEOUT_MS: "1000" }));
});
test("完成与拒绝消息去掉成员提及并转义用户标题", () => {
  const task = {
    requester: "alice",
    repository: "o/r",
    pr_number: 12,
    title: "修复\n<@all> [x]",
    status: "succeeded",
  } as DevelopmentTask;
  const text = developmentMessage(task).markdown.content;
  assert(text.startsWith("**AI 开发任务已完成**"));
  assert(!text.includes("<@alice>"));
  assert(!text.includes("<@all>"));
  assert(text.includes("查看 PR"));
  const refused = developmentMessage({ ...task, status: "refused", pr_number: null, result: "命中保护规则" }).markdown
    .content;
  assert(refused.includes("已拒绝"));
  assert(refused.includes("命中保护规则"));
  assert(!refused.includes("查看 PR"));
});
