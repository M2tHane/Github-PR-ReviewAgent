import assert from "node:assert/strict";
import test from "node:test";
import { errorReason } from "../../frontend/error-reason.js";

test("运行记录把常见报错翻译成大白话，认不出的保留第一行并截断", () => {
  const cases: Array<[string | null, string]> = [
    [null, ""],
    ["模型服务请求失败：Upstream request failed with status 529 overloaded_error", "模型服务过载（529）"],
    ["模型服务请求失败：429 Too Many Requests", "模型请求太频繁，被限流（429）"],
    ["模型服务请求失败：401 invalid api key", "模型凭据无效或没有权限（401），检查模型 API Key"],
    ["模型服务请求失败：502 Bad Gateway", "模型服务出错（502）"],
    ["模型服务请求失败：insufficient_quota", "模型账户额度不足，需要充值或换 Key"],
    ["模型服务请求失败：fetch failed ECONNRESET", "调用模型时网络连接被意外断开"],
    ["Pi 执行超时", "执行超时"],
    ["Agent Token 预算不足：输入与输出至少需预留 1200，剩余 3；未发送请求", "超出 Token 额度，没有继续请求模型"],
    ["GitHub API /repos/acme/a/pulls/1 失败 (404)", "GitHub 上找不到对应内容（404），可能已删除或 App 没有权限"],
    ["GitHub API /repos/acme/a/pulls/1 失败 (503)", "GitHub 服务出错（503）"],
    ["getaddrinfo ENOTFOUND api.github.com", "域名解析失败，检查网络或 DNS"],
    ["\n执行实例失联，重新排队\nat foo", "执行实例失联，重新排队"],
  ];
  for (const [input, expected] of cases) assert.equal(errorReason(input), expected, String(input));
  const long = errorReason("x".repeat(300));
  assert.equal(long.length, 121);
  assert.ok(long.endsWith("…"));
});
