import { redactSecrets } from "./health/secrets.js";

// 结构化日志：一行一个 JSON，字段名固定为 event + 业务字段。
// 带上错误时自动展开 name、HTTP 状态、错误码、调用栈和 cause 链，排查时不用再复现；文字先打码，避免密钥进日志。
export function log(level: "info" | "error", event: string, fields: Record<string, unknown> = {}, error?: unknown) {
  const line = JSON.stringify({ event, ...fields, ...(error === undefined ? {} : { error: describeError(error) }) });
  if (level === "error") console.error(line);
  else console.info(line);
}

export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: redactSecrets(String(error)) };
  const extra = error as Error & { status?: unknown; code?: unknown };
  return {
    name: error.name,
    message: redactSecrets(error.message),
    ...(typeof extra.status === "number" ? { status: extra.status } : {}),
    ...(typeof extra.code === "string" ? { code: extra.code } : {}),
    ...(error.stack
      ? {
          stack: redactSecrets(error.stack)
            .split("\n")
            .slice(1, 9)
            .map((frame) => frame.trim()),
        }
      : {}),
    ...(error.cause !== undefined && depth < 3 ? { cause: describeError(error.cause, depth + 1) } : {}),
  };
}
