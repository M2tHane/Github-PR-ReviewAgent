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

export class GitHubClient {
  // 一个挂住的请求会一直占着 Worker 槽位，同仓库的后续任务也跟着排队，所以每个请求都有上限。
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
      return (await response.json()) as T;
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
