import type { ReviewNotification } from "../persistence/repositories/notification.repository.js";
import { redactSecrets } from "../health/secrets.js";

export type DeliveryResult = { status: "sent" } | { status: "failed" | "uncertain" | "pending"; error: string };

export function notificationMessage(notification: ReviewNotification, userid: string, title: string) {
  const { repository, prNumber, partial } = notification;
  const result = partial ? "AI 审查结果已发布（部分检查未完成）" : "AI 审查已完成";
  const url = `https://github.com/${repository.split("/").map(encodeURIComponent).join("/")}/pull/${prNumber}`;
  // 标题来自 PR 作者，避免其中的换行、Markdown 或 @ 语法改变通知布局和提醒对象。
  const displayTitle = redactSecrets(title)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]()]/g, "\\$&");
  return {
    msgtype: "markdown",
    markdown: {
      content: `<@${userid}>\n\n**${result}**\n> 项目：${repository}\n> PR：#${prNumber} ${displayTitle}\n> [查看审查结果](${url})`,
    },
  };
}

export class WecomClient {
  constructor(
    private readonly webhookUrl: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async send(message: ReturnType<typeof notificationMessage>, signal: AbortSignal): Promise<DeliveryResult> {
    try {
      const response = await this.request(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
      });
      if (!response.ok) return { status: "uncertain", error: `wecom_http_${response.status}` };
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("errcode" in body) || !Number.isSafeInteger(body.errcode))
        return { status: "uncertain", error: "wecom_invalid_response" };
      if (body.errcode === 0) return { status: "sent" };
      // 只重试企微明确拒收的限流／系统繁忙；不保存上游 errmsg，避免回显 Webhook 密钥。
      return {
        status: body.errcode === 45009 || body.errcode === -1 ? "pending" : "failed",
        error: `wecom_error_${body.errcode}`,
      };
    } catch {
      // POST 超时、断网、响应体损坏或停止服务时，消息可能已经到达群里。
      return { status: "uncertain", error: "wecom_delivery_unknown" };
    }
  }
}
