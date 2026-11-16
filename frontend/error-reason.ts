// 把任务的 last_error 翻译成一句大白话，给运行记录列表用；原始报错仍在展开后的“原始错误”里。
// last_error 是错误的 message：ProviderError 以“模型服务请求失败”开头，GitHubApiError 是“GitHub API … 失败 (状态码)”，
// TimeoutError 含“超时”，BudgetError 含“预算”或“Token 上限”。认不出的返回第一行并截断。

const MAX = 120;

const networkReasons: Array<[RegExp, string]> = [
  [/ECONNRESET|socket hang up|other side closed/i, "网络连接被意外断开"],
  [/ETIMEDOUT|ESOCKETTIMEDOUT/i, "网络连接超时"],
  [/ECONNREFUSED/i, "连接被拒绝，对方服务可能没启动"],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "域名解析失败，检查网络或 DNS"],
  [/fetch failed|network.?error/i, "网络请求失败"],
];

function providerReason(text: string) {
  const status = Number(text.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? 0);
  if (status === 529 || /overloaded/i.test(text)) return "模型服务过载（529）";
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return "模型请求太频繁，被限流（429）";
  if (status === 401 || status === 403 || /invalid.?api.?key|unauthorized|authentication/i.test(text))
    return `模型凭据无效或没有权限${status ? `（${status}）` : ""}，检查模型 API Key`;
  if (/insufficient_quota|quota exceeded|billing|available balance|usage limit/i.test(text))
    return "模型账户额度不足，需要充值或换 Key";
  if (status >= 500) return `模型服务出错（${status}）`;
  for (const [pattern, reason] of networkReasons) if (pattern.test(text)) return `调用模型时${reason}`;
  return status ? `模型服务请求失败（${status}）` : "模型服务请求失败";
}

function githubReason(status: number) {
  if (status === 404) return "GitHub 上找不到对应内容（404），可能已删除或 App 没有权限";
  if (status === 401) return "GitHub App 凭据无效（401）";
  if (status === 403) return "GitHub 拒绝访问（403），可能缺少权限或触发限流";
  if (status === 409) return "GitHub 上的状态已变化（409），例如分支已更新";
  if (status === 422) return "GitHub 拒绝了提交的内容（422）";
  if (status === 429) return "GitHub 请求太频繁，被限流（429）";
  if (status >= 500) return `GitHub 服务出错（${status}）`;
  return `GitHub 请求失败（${status}）`;
}

export function errorReason(text: string | null | undefined): string {
  const value = text?.trim() ?? "";
  if (!value) return "";
  if (/ProviderError|模型服务请求失败|模型请求失败/.test(value)) return providerReason(value);
  const github = value.match(/GitHub API .*失败 \((\d{3})\)/) ?? value.match(/GitHubApiError\D*(\d{3})/);
  if (github) return githubReason(Number(github[1]));
  if (/BudgetError|预算|Token 上限/.test(value)) return "超出 Token 额度，没有继续请求模型";
  if (/TimeoutError|超时/.test(value)) return "执行超时";
  for (const [pattern, reason] of networkReasons) if (pattern.test(value)) return reason;
  const first = value
    .split("\n")
    .find((line) => line.trim())!
    .trim();
  return first.length > MAX ? `${first.slice(0, MAX)}…` : first;
}
