export type DevelopmentRole = "admin" | "developer";
export interface Protection {
  name: string;
  paths: string[];
  reason: string;
}
export interface DevelopmentSettings {
  chatId: string;
  targetBranch: string;
  enabled: boolean;
  members: Array<{ userid: string; role: DevelopmentRole }>;
  protections: Protection[];
  version: number;
}
export interface ImageInput {
  url: string;
  aeskey: string;
}
export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}
export interface GroupRequest {
  messageId: string;
  replyRequestId: string;
  receivedAt: Date;
  chatId: string;
  requester: string;
  text: string;
  images: PromptImage[];
}
export type TaskStatus =
  | "queued"
  | "running"
  | "publishing"
  | "succeeded"
  | "refused"
  | "failed"
  | "cancelled"
  | "uncertain"
  // 需求不清楚，已开 issue（或在 issue 里补充提问）讨论。
  | "discussing";
// develop：开发并提 PR；discuss：在 issue 里回复讨论；notice：在 issue 或 PR 里发一条固定提示，不调用模型；
// revise：开发 PR 下有新评论，读评论后按需在同一分支上改代码、在 PR 里回复。
export type TaskKind = "develop" | "discuss" | "notice" | "revise";
export interface DevelopmentTask {
  id: string;
  owner_token: string;
  bot_id: string;
  message_id: string;
  reply_req_id: string | null;
  reply_expires_at: Date | null;
  chat_id: string;
  requester: string;
  repository_id: number;
  installation_id: number;
  repository: string;
  target_branch: string;
  branch: string;
  settings_version: number;
  role: DevelopmentRole;
  prompt: string;
  images: PromptImage[];
  status: TaskStatus;
  base_sha: string | null;
  head_sha: string | null;
  pr_number: number | null;
  title: string | null;
  result: string | null;
  kind: TaskKind;
  issue_number: number | null;
}
// 开发 PR 下的一条评论：PR 对话里的评论（comment）、代码行上的评论（review_comment）或 review 的正文（review）。
export interface PullRequestCommentInput {
  repositoryId: number;
  prNumber: number;
  source: "comment" | "review_comment" | "review";
  commentId: number;
  login: string;
  body: string;
}
export class DevelopmentError extends Error {
  constructor(
    message: string,
    readonly status: "refused" | "cancelled" | "failed" = "failed",
  ) {
    super(message);
  }
}
export interface FileChange {
  path: string;
  content: string | null;
}
