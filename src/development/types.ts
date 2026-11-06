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
  | "uncertain";
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
