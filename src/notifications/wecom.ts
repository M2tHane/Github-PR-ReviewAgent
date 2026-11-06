import type { ReviewNotification } from "../persistence/repositories/notification.repository.js";
import { redactSecrets } from "../health/secrets.js";

export type DeliveryResult =
  | { status: "sent" }
  | { status: "failed" | "uncertain" | "pending" | "cancelled"; error: string };

export class NotificationBindingChanged extends Error {}

export function reviewNotificationChannel(botId: string) {
  return `aibot:${botId}`;
}

export function notificationMessage(notification: ReviewNotification, title: string) {
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
    msgtype: "markdown" as const,
    markdown: {
      content: `**${result}**\n> 项目：${repository}\n> PR：#${prNumber} ${displayTitle}\n> [查看审查结果](${url})`,
    },
  };
}

export async function deliverBotNotification(send: () => Promise<void>): Promise<DeliveryResult> {
  try {
    await send();
    return { status: "sent" };
  } catch (error) {
    if (error instanceof NotificationBindingChanged)
      return { status: "cancelled", error: "repository_or_binding_changed" };
    // SDK 对明确拒收抛出回执帧；断线、超时等未知结果不自动重发。
    if (
      error &&
      typeof error === "object" &&
      "errcode" in error &&
      Number.isSafeInteger(error.errcode) &&
      error.errcode !== 0
    )
      return {
        status: error.errcode === 45009 || error.errcode === -1 ? "pending" : "failed",
        error: `wecom_error_${error.errcode}`,
      };
    return { status: "uncertain", error: "wecom_delivery_unknown" };
  }
}
