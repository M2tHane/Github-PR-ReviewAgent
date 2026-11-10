import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSession, sessionSteps } from "../../src/pi/session-record.js";

const t0 = Date.parse("2026-11-09T10:00:00Z");
const at = (ms: number) => new Date(t0 + ms).toISOString();
const jsonl = (entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const result = (id: string, ms: number, text: string) => ({
  type: "message",
  id: `r-${id}`,
  timestamp: at(ms),
  message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }] },
});

test("保存前截断过长内容、去掉图片数据和思考过程", () => {
  const raw = jsonl([
    {
      type: "message",
      id: "u",
      timestamp: at(0),
      message: {
        role: "user",
        content: [
          { type: "text", text: "按图修改" },
          { type: "image", mimeType: "image/png", data: "A".repeat(50_000) },
        ],
      },
    },
    {
      type: "message",
      id: "a",
      timestamp: at(10),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "思考内容", thinkingSignature: "sig" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "big.txt" } },
        ],
      },
    },
    result("c1", 20, "x".repeat(30_000)),
  ]);
  const session = sanitizeSession(raw);
  assert.equal(session.steps, 2);
  assert.equal(session.truncated, true);
  assert(!session.content.includes("思考内容") && !session.content.includes("sig"));
  assert(!session.content.includes("A".repeat(100)), "图片数据不保存");
  assert.match(session.content, /已截断，原文 30000 字符/);
  assert.equal(session.bytes, Buffer.byteLength(session.content));
});

test("整份超过 10 MB 时保留开头和结尾，时间线标出中间省略的条数", () => {
  const entries = Array.from({ length: 800 }, (_, index) => result(`c${index}`, index, "y".repeat(19_000)));
  const session = sanitizeSession(jsonl(entries));
  assert(session.bytes <= 10 * 1024 * 1024);
  assert.equal(session.truncated, true);
  const steps = sessionSteps(session.content, { models: [], tools: {} }, t0, 1000);
  const note = steps.find((step) => step.kind === "note")!;
  const omitted = Number(note.title.match(/中间 (\d+) 条/)![1]);
  assert.equal(steps.filter((step) => step.kind === "tool").length + omitted, 800);
});

test("时间线：建索引、按服务记下的耗时排序，未完成的工具调用单独列出", () => {
  const content = sanitizeSession(
    jsonl([
      { type: "message", id: "u", timestamp: at(60_000), message: { role: "user", content: "任务" } },
      {
        type: "message",
        id: "a",
        timestamp: at(65_000),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "先读代码\n再跑测试" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.go" } },
            { type: "toolCall", id: "c2", name: "bash", arguments: { command: "go test ./service" } },
          ],
          usage: { totalTokens: 3_344_741 },
        },
      },
      result("c1", 66_000, "package a"),
    ]),
  ).content;
  const steps = sessionSteps(
    content,
    {
      codegraph: { startedAt: t0 + 100, durationMs: 52_000, ok: true },
      models: [{ startedAt: t0 + 61_000, durationMs: 4000 }],
      tools: {
        c1: { startedAt: t0 + 65_100, name: "read", durationMs: 50 },
        c2: { startedAt: t0 + 65_200, name: "bash" },
      },
    },
    t0,
    300_000,
  );
  assert.deepEqual(
    steps.map((step) => [step.at, step.kind, step.title, step.durationMs, step.error ?? false]),
    [
      [100, "service", "建 codegraph 索引", 52_000, false],
      [60_000, "input", "任务输入", undefined, false],
      [61_000, "model", "先读代码", 4000, false],
      [65_100, "tool", "read a.go", 50, false],
      [65_200, "tool", "bash go test ./service", 234_800, true],
    ],
  );
  assert.equal(steps[2]!.tokens, 3_344_741);
});
