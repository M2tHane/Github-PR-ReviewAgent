import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// OpenAI 兼容的假模型服务：按顺序返回脚本里的回复，记录每次请求，供真实 Pi 进程测试使用。
export interface FakeReply {
  text?: string;
  // 模型的思考过程，按 OpenAI 兼容接口的 reasoning_content 返回。
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: object }>;
  usage?: { input: number; output: number; cacheRead?: number };
  // 不回应，直到连接被关闭；用于测试取消与超时。
  hang?: boolean;
  status?: number;
  error?: string;
}
export interface FakeRequest {
  body: Record<string, any>;
  headers: IncomingMessage["headers"];
}

export async function startFakeModel(script: FakeReply[] | ((request: FakeRequest, index: number) => FakeReply)) {
  const requests: FakeRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"), headers: request.headers };
    requests.push(entry);
    const index = requests.length - 1;
    const reply = typeof script === "function" ? script(entry, index) : (script[index] ?? { text: "{}" });
    if (reply.hang) return;
    if (reply.status) {
      response.writeHead(reply.status, { "content-type": "application/json" });
      return void response.end(JSON.stringify({ error: { message: reply.error ?? "error" } }));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: object) => response.write(`data: ${JSON.stringify(data)}\n\n`);
    const base = { id: `chatcmpl-${index}`, object: "chat.completion.chunk", created: 1, model: entry.body.model };
    if (reply.reasoning)
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reply.reasoning } }] });
    if (reply.text) send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text } }] });
    for (const [position, call] of (reply.toolCalls ?? []).entries())
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: position,
                  id: `call_${index}_${position}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            },
          },
        ],
      });
    send({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }],
    });
    const usage = reply.usage ?? { input: 100, output: 20 };
    send({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: usage.input + (usage.cacheRead ?? 0),
        completion_tokens: usage.output,
        total_tokens: usage.input + (usage.cacheRead ?? 0) + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cacheRead ?? 0 },
      },
    });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// 请求里最后一条工具结果的文本，用来断言服务对工具结果的处理。
export function lastToolResult(request: FakeRequest) {
  const message = [...request.body.messages].reverse().find((item: { role: string }) => item.role === "tool");
  if (!message) return undefined;
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part: { text?: string }) => part.text ?? "").join("");
}
