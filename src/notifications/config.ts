import { createHash } from "node:crypto";

export interface WecomConfig {
  webhookUrl: string;
  channel: string;
}

export function loadWecomConfig(env: NodeJS.ProcessEnv): WecomConfig | undefined {
  const webhookUrl = env.WECOM_WEBHOOK_URL?.trim();
  if (!webhookUrl) return undefined;
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error("WECOM_WEBHOOK_URL 格式错误");
  }
  if (
    url.origin !== "https://qyapi.weixin.qq.com" ||
    url.pathname !== "/cgi-bin/webhook/send" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get("key") ||
    [...url.searchParams.keys()].some((key) => key !== "key") ||
    url.searchParams.getAll("key").length !== 1
  )
    throw new Error("WECOM_WEBHOOK_URL 必须是企业微信官方消息推送地址，仅包含 key 参数");
  return {
    webhookUrl: url.toString(),
    channel: createHash("sha256").update(url.searchParams.get("key")!).digest("hex"),
  };
}
