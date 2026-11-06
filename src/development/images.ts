import { decryptFile } from "@wecom/aibot-node-sdk";
import { DevelopmentError, type ImageInput, type PromptImage } from "./types.js";

const MAX_BYTES = 2 * 1024 * 1024;
export function imageDimensions(bytes: Buffer): { mimeType: string; width: number; height: number } {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8)
        return {
          mimeType: "image/jpeg",
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      offset += length + 2;
    }
  }
  throw new DevelopmentError("图片格式不支持，请发送 PNG 或 JPEG 截图。", "refused");
}
export async function downloadImage(input: ImageInput, signal: AbortSignal, request = fetch): Promise<PromptImage> {
  const url = new URL(input.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    // 企微智能机器人图片使用官方专用 COS 存储桶，不能放行所有 myqcloud.com 租户。
    (url.hostname !== "ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com" &&
      ![".qpic.cn", ".work.weixin.qq.com"].some((domain) => url.hostname.endsWith(domain)))
  )
    throw new DevelopmentError("图片不是受支持的企微下载地址。", "refused");
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(input.aeskey)) throw new DevelopmentError("图片解密信息无效。", "refused");
  const response = await request(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "error",
  });
  if (!response.ok || !response.body) throw new DevelopmentError("图片下载失败，请重新发送图文消息。", "refused");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES + 32) throw new DevelopmentError("每张图片不能超过 2 MB。", "refused");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  const bytes = decryptFile(Buffer.concat(chunks), input.aeskey);
  const { mimeType, width, height } = imageDimensions(bytes);
  if (!width || !height || width > 2048 || height > 2048)
    throw new DevelopmentError("图片边长需在 1–2048 像素之间，请缩小后发送。", "refused");
  return { type: "image", data: bytes.toString("base64"), mimeType };
}
