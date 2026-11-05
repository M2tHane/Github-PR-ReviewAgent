// 模型输出的通用解析与结构校验。模型输出是不可信数据，各处的信任边界（parseReviewResult、parseHealthResult 等）都从这里开始。

// 去掉 ``` 包裹后按 JSON 解析。报错只带长度和出错位置、不带原文：
// 原文可能含仓库代码，而这些报错会进日志、limitations，甚至 PR 总评。
export function parseModelJson(raw: string, label: string, maxLength = Number.POSITIVE_INFINITY): unknown {
  if (raw.length > maxLength) throw new Error(`${label}过长（${raw.length} 字符，上限 ${maxLength}）`);
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const position = /position (\d+)/.exec(error instanceof Error ? error.message : "")?.[1];
    throw new Error(
      `${label}不是合法 JSON（共 ${trimmed.length} 字符${position === undefined ? "" : `，第 ${position} 个字符处出错`}）`,
    );
  }
}

// 只允许列出的字段：多一个字段就当结构无效，防止模型夹带身份、链接等服务端字段。
export function strictObject(value: unknown, allowed: string[], label: string): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(`${label} 结构无效`);
  return value as Record<string, any>;
}

export function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} 文本无效`);
  return value.trim();
}
