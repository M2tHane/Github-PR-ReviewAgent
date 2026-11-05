import assert from "node:assert/strict";
import test from "node:test";
import { describeError } from "../src/logging.js";
import { GitHubApiError } from "../src/github/client.js";

// 拼出来的假 Token；不从 secrets.test 导入，避免把那边的用例也注册进来。
const FAKE_GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36);

test("错误日志带上状态码、调用栈和 cause 链，并给密钥打码", () => {
  const root = Object.assign(new Error(`connect ECONNRESET token=${FAKE_GITHUB_TOKEN}`), { code: "ECONNRESET" });
  const wrapped = new Error("GitHub 请求超时：createReview", { cause: root });
  const described = describeError(wrapped);
  assert.equal(described.message, "GitHub 请求超时：createReview");
  assert.ok(Array.isArray(described.stack) && (described.stack as string[]).length > 0);
  const cause = described.cause as Record<string, unknown>;
  assert.equal(cause.code, "ECONNRESET");
  assert.doesNotMatch(JSON.stringify(described), /a1B2c3/);
  assert.equal(describeError(new GitHubApiError("/repos/x", 403, 60)).status, 403);
  assert.deepEqual(describeError("plain"), { message: "plain" });
});
