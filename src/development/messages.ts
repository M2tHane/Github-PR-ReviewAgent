import { redactSecrets } from "../health/secrets.js";
import { DevelopmentError, type DevelopmentTask, type GroupRequest, type ImageInput } from "./types.js";

export function markdownText(value: string) {
  return redactSecrets(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]()]/g, "\\$&");
}
export function parseGroupMessage(
  value: unknown,
  botId: string,
): Omit<GroupRequest, "images"> & { images: ImageInput[] } {
  if (!value || typeof value !== "object") throw new DevelopmentError("消息格式无效", "refused");
  const v = value as Record<string, any>;
  if (
    v.aibotid !== botId ||
    v.chattype !== "group" ||
    typeof v.chatid !== "string" ||
    !/^[a-z\d_-]{1,200}$/i.test(v.chatid) ||
    typeof v.msgid !== "string" ||
    !v.msgid ||
    v.msgid.length > 200 ||
    typeof v.from?.userid !== "string" ||
    !/^[a-z\d_.@-]{1,64}$/i.test(v.from.userid) ||
    v.from.userid.toLowerCase() === "@all"
  )
    throw new DevelopmentError("仅接收已配置智能机器人的群内任务", "refused");
  const items =
    v.msgtype === "text" ? [{ msgtype: "text", text: v.text }] : v.msgtype === "mixed" ? v.mixed?.msg_item : undefined;
  if (!Array.isArray(items) || !items.length || items.length > 20)
    throw new DevelopmentError("请在群内 @Bot 并发送文字，可在同一条消息中附 PNG/JPEG 图片。", "refused");
  const texts: string[] = [],
    images: ImageInput[] = [];
  for (const item of items) {
    if (item?.msgtype === "text" && typeof item.text?.content === "string") texts.push(item.text.content);
    else if (
      item?.msgtype === "image" &&
      typeof item.image?.url === "string" &&
      item.image.url.length <= 4096 &&
      typeof item.image?.aeskey === "string"
    )
      images.push({ url: item.image.url, aeskey: item.image.aeskey });
    else throw new DevelopmentError("消息包含无法处理的内容，请重新发送文字和图片。", "refused");
  }
  const text = texts.join("\n").trim();
  if (!text || text.length > 12_000 || images.length > 4)
    throw new DevelopmentError("请提供 1–12000 字的开发描述，最多附 4 张图片。", "refused");
  return { messageId: v.msgid, chatId: v.chatid, requester: v.from.userid, text, images };
}
export function developmentMessage(task: DevelopmentTask) {
  const success = task.status === "succeeded" && task.pr_number;
  const status = success
    ? "AI 开发任务已完成"
    : task.status === "refused"
      ? "AI 开发任务已拒绝"
      : task.status === "uncertain"
        ? "AI 开发任务发布待核对"
        : task.status === "cancelled"
          ? "AI 开发任务已取消"
          : "AI 开发任务未完成";
  const url = `https://github.com/${task.repository.split("/").map(encodeURIComponent).join("/")}/pull/${task.pr_number}`;
  return {
    msgtype: "markdown" as const,
    markdown: {
      content:
        `<@${task.requester}>\n\n**${status}**\n> 项目：${markdownText(task.repository)}\n` +
        (success
          ? `> PR：#${task.pr_number} ${markdownText(task.title!)}\n> [查看 PR](${url})`
          : `> ${markdownText(task.result ?? "请查看管理页任务记录。")}`),
    },
  };
}
