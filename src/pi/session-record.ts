import { redactSecrets } from "../health/secrets.js";

// 保存前的处理：去掉模型思考过程和图片数据，单个字符串最多保留 2 万字符，整份最多 10 MB，全部打码。
const MAX_TEXT = 20_000;
const MAX_BYTES = 10 * 1024 * 1024;
// 时间线里每一步的详情最多显示这么多字符，完整内容在原始记录里。
const DETAIL_CHARS = 8_000;
const OMITTED = "pi-service.omitted";

// 服务从 Pi 的事件流里记下的耗时；Pi 会话文件只有每条记录写入的时刻，算不出并行工具各自的耗时。
export interface SessionTimings {
  // 没有 durationMs 表示还在建索引。
  codegraph?: { startedAt: number; durationMs?: number; ok?: boolean };
  models: Array<{ startedAt: number; durationMs?: number }>;
  tools: Record<string, { startedAt: number; name: string; durationMs?: number }>;
}
// 服务自己的步骤（准备工作区、创建提交和 PR 等）；没有 durationMs 表示还在进行。
export interface ServiceEvent {
  name: string;
  startedAt: number;
  durationMs?: number;
  ok?: boolean;
  detail?: string;
}
export type SessionStatus = "running" | "succeeded" | "failed" | "timeout" | "cancelled";
export interface RecordedSession {
  // 同一次运行的多次保存共用一个 id：运行中定时保存，结束时再保存一次。
  id: string;
  status: SessionStatus;
  error?: string;
  startedAt: Date;
  durationMs: number;
  steps: number;
  bytes: number;
  truncated: boolean;
  timings: SessionTimings;
  content: string;
}
export interface SessionStep {
  // 距离 Agent 启动的毫秒数
  at: number;
  kind: "service" | "input" | "model" | "tool" | "note";
  title: string;
  durationMs?: number;
  tokens?: number;
  error?: boolean;
  detail?: string;
}

export function sanitizeSession(raw: string) {
  let truncated = false,
    steps = 0;
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") {
      const text = redactSecrets(value);
      if (text.length <= MAX_TEXT) return text;
      truncated = true;
      return `${text.slice(0, MAX_TEXT)}\n…[已截断，原文 ${text.length} 字符]`;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  let lines: string[] = [];
  for (const line of raw.split("\n")) {
    const entry = parse(line);
    if (!entry) continue;
    const message = entry.type === "message" ? entry.message : undefined;
    if (Array.isArray(message?.content))
      message.content = message.content
        .filter((block: { type?: string }) => block?.type !== "thinking" && block?.type !== "redacted_thinking")
        .map((block: Record<string, any>) =>
          block?.type === "image" ? { type: "image", mimeType: block.mimeType, data: "", omitted: true } : block,
        );
    if (message?.role === "assistant" || message?.role === "toolResult") steps++;
    lines.push(JSON.stringify(clean(entry)));
  }
  const size = (line: string) => Buffer.byteLength(line) + 1;
  if (lines.reduce((sum, line) => sum + size(line), 0) > MAX_BYTES) {
    truncated = true;
    const head: string[] = [],
      tail: string[] = [];
    let room = MAX_BYTES / 2;
    for (const line of lines) {
      if (size(line) > room) break;
      head.push(line);
      room -= size(line);
    }
    room = MAX_BYTES / 2 - 1024;
    for (let index = lines.length - 1; index >= head.length && size(lines[index]!) <= room; index--) {
      tail.unshift(lines[index]!);
      room -= size(lines[index]!);
    }
    const timestamp = parse(tail[0] ?? "")?.timestamp ?? parse(head.at(-1) ?? "")?.timestamp;
    const omitted = {
      type: "custom",
      customType: OMITTED,
      timestamp,
      data: { entries: lines.length - head.length - tail.length },
    };
    lines = [...head, JSON.stringify(omitted), ...tail];
  }
  const content = lines.length ? `${lines.join("\n")}\n` : "";
  return { content, steps, truncated, bytes: Buffer.byteLength(content) };
}

// 把会话记录整理成时间线：模型每次回复、每次工具调用、服务的每个步骤各一步，耗时取服务记下的时间。
// running 表示任务还在进行，没结束的步骤显示为进行中而不是失败。
export function sessionSteps(
  content: string,
  timings: SessionTimings,
  startedAt: number,
  durationMs: number,
  events: Record<string, ServiceEvent> = {},
  running = false,
) {
  const steps: SessionStep[] = [];
  const offset = (time: number) => Math.max(0, time - startedAt);
  const end = startedAt + durationMs;
  for (const event of Object.values(events))
    steps.push({
      at: offset(event.startedAt),
      kind: "service",
      title: event.durationMs === undefined && !running ? `${event.name}（未完成）` : event.name,
      durationMs: event.durationMs ?? Math.max(0, end - event.startedAt),
      error: event.ok === false || (event.durationMs === undefined && !running),
      detail: event.detail,
    });
  const index = timings.codegraph;
  if (index) {
    const unfinished = index.durationMs === undefined && !running;
    steps.push({
      at: offset(index.startedAt),
      kind: "service",
      title:
        index.ok === false
          ? "建 codegraph 索引失败，本次不加载 codegraph 工具"
          : unfinished
            ? "建 codegraph 索引（未完成）"
            : "建 codegraph 索引",
      durationMs: index.durationMs ?? Math.max(0, startedAt + durationMs - index.startedAt),
      error: index.ok === false || unfinished,
    });
  }
  const calls = new Map<string, { name: string; arguments?: Record<string, unknown> }>();
  const finished = new Set<string>();
  let models = 0,
    prompts = 0;
  for (const line of content.split("\n")) {
    const entry = parse(line);
    if (!entry) continue;
    const at = offset(Date.parse(entry.timestamp));
    if (entry.type === "custom" && entry.customType === OMITTED)
      steps.push({ at, kind: "note", title: `记录过大，中间 ${entry.data?.entries ?? 0} 条未保存` });
    if (entry.type !== "message") continue;
    const message = entry.message ?? {};
    if (message.role === "system") {
      const sections = Object.entries(message.sections ?? {}).map(([name, text]) => `## ${name}\n${text}`);
      const tools = (message.toolsAdded ?? []).map((tool: { name: string }) => tool.name);
      steps.push({
        at,
        kind: "input",
        title: tools.length ? `系统提示（工具：${tools.join("、")}）` : "系统提示",
        detail: clip([message.content, ...sections].filter(Boolean).join("\n\n")),
      });
    } else if (message.role === "user") {
      steps.push({
        at,
        kind: "input",
        title: prompts++ ? "追加要求" : "任务输入",
        detail: clip(textOf(message.content)),
      });
    } else if (message.role === "assistant") {
      const timing = timings.models[models++];
      const blocks: Array<Record<string, any>> = Array.isArray(message.content) ? message.content : [];
      const toolCalls = blocks.filter((block) => block.type === "toolCall");
      for (const call of toolCalls) calls.set(call.id, call as { name: string; arguments?: Record<string, unknown> });
      const text = textOf(blocks);
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      steps.push({
        at: timing ? offset(timing.startedAt) : at,
        kind: "model",
        title: failed
          ? `模型请求失败：${message.errorMessage ?? message.stopReason}`
          : !toolCalls.length && /^\s*(```(json)?\s*)?\{/.test(text)
            ? "输出结果"
            : firstLine(text) ||
              (toolCalls.length ? `调用 ${toolCalls.map((call) => call.name).join("、")}` : "模型回复"),
        durationMs: timing?.durationMs,
        tokens: Number(message.usage?.totalTokens) || undefined,
        error: failed,
        detail: clip(
          [text, ...toolCalls.map((call) => `→ ${call.name} ${JSON.stringify(call.arguments ?? {})}`)]
            .filter(Boolean)
            .join("\n\n"),
        ),
      });
    } else if (message.role === "toolResult") {
      finished.add(message.toolCallId);
      const call = calls.get(message.toolCallId);
      const timing = timings.tools[message.toolCallId];
      steps.push({
        at: timing ? offset(timing.startedAt) : at,
        kind: "tool",
        title: `${message.toolName} ${summary(call?.arguments)}`.trim(),
        durationMs: timing?.durationMs,
        error: Boolean(message.isError),
        detail: clip(`参数\n${JSON.stringify(call?.arguments ?? {}, null, 2)}\n\n结果\n${textOf(message.content)}`),
      });
    }
  }
  // 还没完成的工具调用和模型请求：任务进行中显示为进行中；任务已结束（超时或被取消）则标为未完成。
  for (const [id, timing] of Object.entries(timings.tools))
    if (!finished.has(id))
      steps.push({
        at: offset(timing.startedAt),
        kind: "tool",
        title: `${timing.name} ${summary(calls.get(id)?.arguments)}`.trim(),
        durationMs: Math.max(0, end - timing.startedAt),
        error: !running,
        detail: running ? "正在运行…" : "任务结束时这一步仍在运行，没有结果。",
      });
  for (const timing of timings.models.slice(models))
    steps.push({
      at: offset(timing.startedAt),
      kind: "model",
      title: running ? "等待模型回复…" : "模型请求未完成",
      durationMs: Math.max(0, end - timing.startedAt),
      error: !running,
      detail: running ? undefined : "任务结束时仍在等待模型返回。",
    });
  return steps.sort((a, b) => a.at - b.at);
}

function parse(line: string): Record<string, any> | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? block.text : block?.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");
}
function firstLine(text: string) {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
// 工具调用的一行摘要：命令、路径或搜索词。
function summary(args: Record<string, unknown> = {}) {
  const pick = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const main =
    pick("command") ??
    pick("pattern") ??
    pick("query") ??
    pick("symbol") ??
    pick("url") ??
    pick("path") ??
    pick("file");
  const path = pick("path");
  const text = main
    ? `${main}${path && main !== path ? ` · ${path}` : ""}`
    : Object.keys(args).length
      ? JSON.stringify(args)
      : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
function clip(text: string) {
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}\n…[完整内容见原始记录]` : text;
}
