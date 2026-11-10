import { createSign } from "node:crypto";
import type { ReviewJob } from "../jobs/types.js";

const api = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    path: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`GitHub API ${path} 失败 (${status})`);
  }
}

// GitHub 限流时给出的等待秒数：优先 Retry-After；主限流用尽（403/429 且剩余 0）时按重置时间算。
function retryAfterOf(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && Number.isFinite(Number(retryAfter)) && Number(retryAfter) >= 0) return Number(retryAfter);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0)
    return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return undefined;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

// App Webhook 的一次投递尝试。guid 是事件的 delivery id，重投时不变；id 是这一次尝试。
export interface WebhookDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status: string;
  status_code?: number | null;
  event: string;
  action: string | null;
}

// 投递记录按 cursor 翻页，下一页的 cursor 只在响应头 Link 的 rel="next" 里。
function nextCursorOf(response: Response) {
  const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  if (!next) return undefined;
  try {
    return new URL(next).searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

export class GitHubClient {
  // 一个挂住的请求会一直占着 Worker 槽位，同一 PR 的后续任务也跟着排队，所以每个请求都有上限。
  constructor(
    private appId: string,
    private privateKey: string,
    private requestTimeoutMs = 30_000,
  ) {}

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
    label: string,
    check: (response: Response) => void,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await fetch(url, { ...init, signal });
      check(response);
      // 重投接口成功时响应体可能为空，直接 response.json() 会抛错。
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      if (timeout.aborted && !init.signal?.aborted) throw new Error(`GitHub 请求超时：${label}`, { cause: error });
      throw error;
    }
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.privateKey);
    return `${unsigned}.${base64url(signature)}`;
  }

  async installationToken(installationId: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const body = await this.fetchJson<{ token?: string }>(
      `${api}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${this.jwt()}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
      "installation token",
      (response) => {
        if (!response.ok) throw new Error(`GitHub installation 认证失败 (${response.status})`);
      },
    );
    if (!body.token) throw new Error("GitHub installation 响应缺少 token");
    return body.token;
  }

  // App 级接口用 App JWT 认证，不是 installation token。
  async listWebhookDeliveries(cursor?: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ per_page: "100", ...(cursor ? { cursor } : {}) });
    let nextCursor: string | undefined;
    const deliveries = await this.fetchJson<WebhookDelivery[]>(
      `${api}/app/hook/deliveries?${params}`,
      { signal, headers: this.appHeaders() },
      "webhook deliveries",
      (response) => {
        if (!response.ok) throw new GitHubApiError("/app/hook/deliveries", response.status, retryAfterOf(response));
        nextCursor = nextCursorOf(response);
      },
    );
    if (!Array.isArray(deliveries)) throw new Error("GitHub Webhook 投递记录响应无效");
    return { deliveries, nextCursor };
  }

  // 让 GitHub 把这一次投递尝试重新发一遍；成功返回 202，新的尝试稍后才出现在投递记录里。
  async redeliverWebhook(attemptId: number, signal?: AbortSignal) {
    const path = `/app/hook/deliveries/${attemptId}/attempts`;
    await this.fetchJson<unknown>(
      `${api}${path}`,
      { method: "POST", signal, headers: this.appHeaders() },
      "webhook redelivery",
      (response) => {
        if (!response.ok) throw new GitHubApiError(path, response.status, retryAfterOf(response));
      },
    );
  }

  private appHeaders() {
    return {
      authorization: `Bearer ${this.jwt()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
  }

  private async request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    };
    return this.fetchJson<T>(`${api}${path}`, { ...init, headers }, path, (response) => {
      if (response.ok) return;
      throw new GitHubApiError(path, response.status, retryAfterOf(response));
    });
  }

  getPullRequest(token: string, repository: string, number: number, signal?: AbortSignal) {
    return this.request<{
      number: number;
      title: string;
      body: string | null;
      state: string;
      draft: boolean;
      merged: boolean;
      merged_at: string | null;
      merge_commit_sha: string | null;
      base: { sha: string };
      head: { sha: string };
      user: { id: number; login: string };
    }>(token, `/repos/${repository}/pulls/${number}`, { signal });
  }

  // 公开仓库里的高危安全问题不在 PR 评论里写细节；拿不准时由调用方按公开处理。
  async isPrivateRepository(token: string, repository: string) {
    const info = await this.request<{ private?: boolean }>(token, `/repos/${repository}`);
    return info.private === true;
  }

  async repositorySnapshot(token: string, repository: string, repositoryId: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const info = await this.request<{ id: number; default_branch: string }>(token, `/repos/${repository}`, { signal });
    if (info.id !== repositoryId || typeof info.default_branch !== "string" || !info.default_branch)
      throw new Error("仓库归属或默认分支无效");
    const branch = await this.request<{ commit?: { sha?: string } }>(
      token,
      `/repos/${repository}/branches/${encodeURIComponent(info.default_branch)}`,
      { signal },
    );
    if (!branch.commit?.sha || !/^[a-f0-9]{40}$/i.test(branch.commit.sha)) throw new Error("默认分支没有可用提交");
    return { defaultBranch: info.default_branch, headSha: branch.commit.sha };
  }

  async developmentSnapshot(
    token: string,
    repository: string,
    repositoryId: number,
    branch: string,
    signal: AbortSignal,
  ) {
    const info = await this.request<{ id: number }>(token, `/repos/${repository}`, { signal });
    if (info.id !== repositoryId) throw new Error("开发仓库归属无效");
    const ref = await this.request<{ object: { sha: string } }>(
      token,
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
      { signal },
    );
    if (!/^[a-f0-9]{40}$/.test(ref.object?.sha)) throw new Error("开发分支 SHA 无效");
    const commit = await this.request<{ tree: { sha: string } }>(
      token,
      `/repos/${repository}/git/commits/${ref.object.sha}`,
      { signal },
    );
    if (!/^[a-f0-9]{40}$/.test(commit.tree?.sha)) throw new Error("开发分支 tree 无效");
    return { sha: ref.object.sha, tree: commit.tree.sha };
  }

  async createDevelopmentCommit(
    token: string,
    repository: string,
    base: { sha: string; tree: string },
    changes: Array<{ path: string; content: string | null; mode: string }>,
    title: string,
    signal: AbortSignal,
  ) {
    const tree = await this.request<{ sha: string }>(token, `/repos/${repository}/git/trees`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        base_tree: base.tree,
        tree: changes.map((c) => ({
          path: c.path,
          mode: c.mode,
          type: "blob",
          ...(c.content === null ? { sha: null } : { content: c.content }),
        })),
      }),
    });
    if (!/^[a-f0-9]{40}$/.test(tree.sha)) throw new Error("Git tree 响应无效");
    const commit = await this.request<{ sha: string }>(token, `/repos/${repository}/git/commits`, {
      method: "POST",
      signal,
      body: JSON.stringify({ message: title, tree: tree.sha, parents: [base.sha] }),
    });
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("Git commit 响应无效");
    return commit.sha;
  }

  createDevelopmentBranch(token: string, repository: string, branch: string, sha: string, signal: AbortSignal) {
    return this.request(token, `/repos/${repository}/git/refs`, {
      method: "POST",
      signal,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
  }

  async createDevelopmentPullRequest(
    token: string,
    repository: string,
    input: { head: string; base: string; title: string; body: string },
    signal: AbortSignal,
  ) {
    const pr = await this.request<{ number: number; head: { sha: string } }>(token, `/repos/${repository}/pulls`, {
      method: "POST",
      signal,
      body: JSON.stringify(input),
    });
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[a-f0-9]{40}$/.test(pr.head?.sha))
      throw new Error("PR 创建响应无效");
    return pr;
  }

  async findDevelopmentPullRequest(
    token: string,
    repository: string,
    branch: string,
    base: string,
    signal: AbortSignal,
  ) {
    const params = new URLSearchParams({
      state: "all",
      head: `${repository.split("/")[0]}:${branch}`,
      base,
      per_page: "100",
    });
    return this.request<
      Array<{ number: number; head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string } }>
    >(token, `/repos/${repository}/pulls?${params}`, { signal });
  }

  healthChecks(token: string, repository: string, sha: string, signal: AbortSignal) {
    return this.request<{ total_count: number; check_runs: Array<Record<string, any>> }>(
      token,
      `/repos/${repository}/commits/${sha}/check-runs?per_page=100`,
      { signal },
    );
  }

  healthWorkflows(token: string, repository: string, branch: string, start: string, end: string, signal: AbortSignal) {
    const params = new URLSearchParams({ branch, created: `${start}..${end}`, per_page: "100" });
    return this.request<{ total_count: number; workflow_runs: Array<Record<string, any>> }>(
      token,
      `/repos/${repository}/actions/runs?${params}`,
      { signal },
    );
  }

  private async pages<T>(token: string, path: string): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>(token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }

  getConversationComments(token: string, repository: string, number: number) {
    return this.pages<{
      id: number;
      html_url: string;
      body: string;
      user: { id: number; login: string; type: string };
    }>(token, `/repos/${repository}/issues/${number}/comments`);
  }
  getReviews(token: string, repository: string, number: number) {
    return this.pages<{
      id: number;
      html_url: string;
      body: string;
      state: string;
      commit_id: string;
      user: { id: number; login: string; type: string };
    }>(token, `/repos/${repository}/pulls/${number}/reviews`);
  }
  getReviewComments(token: string, repository: string, number: number) {
    return this.pages<{
      id: number;
      in_reply_to_id?: number;
      html_url: string;
      body: string;
      path: string;
      line: number | null;
      commit_id: string;
      created_at: string;
      user: { id: number; login: string; type: string };
    }>(token, `/repos/${repository}/pulls/${number}/comments`);
  }

  async getFiles(
    token: string,
    repository: string,
    number: number,
  ): Promise<Array<{ filename: string; status: string; patch?: string }>> {
    const files = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<Array<{ filename: string; status: string; patch?: string }>>(
        token,
        `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      files.push(...batch);
      if (batch.length < 100) return files;
    }
  }

  createReview(
    token: string,
    job: ReviewJob,
    body: string,
    comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }> = [],
  ) {
    return this.request<{ id: number; html_url: string }>(
      token,
      `/repos/${job.repository}/pulls/${job.prNumber}/reviews`,
      {
        method: "POST",
        body: JSON.stringify({ commit_id: job.headSha, event: "COMMENT", body, comments }),
      },
    );
  }

  getReviewCommentsForReview(token: string, repository: string, number: number, reviewId: number) {
    return this.pages<{ id: number; html_url: string; body: string }>(
      token,
      `/repos/${repository}/pulls/${number}/reviews/${reviewId}/comments`,
    );
  }

  replyToReviewComment(token: string, repository: string, number: number, rootCommentId: number, body: string) {
    return this.request<{ id: number; html_url: string }>(
      token,
      `/repos/${repository}/pulls/${number}/comments/${rootCommentId}/replies`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  }

  async exchangeOAuthCode(clientId: string, clientSecret: string, code: string) {
    let status = 0;
    const body = await this.fetchJson<{ access_token?: string; error_description?: string }>(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      },
      "oauth",
      (response) => {
        status = response.ok ? 0 : response.status;
      },
    );
    if (status || !body.access_token) throw new Error(body.error_description ?? `GitHub OAuth 失败 (${status})`);
    return body.access_token;
  }

  getUser(token: string) {
    return this.request<{ id: number; login: string }>(token, "/user");
  }

  async hasMaintainerPermission(token: string, repository: string) {
    const value = await this.request<{ permissions?: { admin?: boolean; maintain?: boolean } }>(
      token,
      `/repos/${repository}`,
    );
    return value.permissions?.admin === true || value.permissions?.maintain === true;
  }
}
