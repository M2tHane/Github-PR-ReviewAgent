import type { Config } from "../config/config.js";
import { GitHubApiError, GitHubClient } from "../github/client.js";
import { log } from "../logging.js";
import type {
  NotificationRepository,
  NotificationSession,
  ReviewNotification,
} from "../persistence/repositories/notification.repository.js";
import type { WecomConfig } from "./config.js";
import { notificationMessage, WecomClient } from "./wecom.js";

type NotificationGitHub = Pick<GitHubClient, "installationToken" | "getPullRequest">;

export class NotificationWorker {
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;

  constructor(
    private readonly config: Pick<Config, "allowedRepositories">,
    private readonly wecom: WecomConfig,
    private readonly store: NotificationRepository,
    private readonly github: NotificationGitHub,
    private readonly client = new WecomClient(wecom.webhookUrl),
  ) {}

  start() {
    this.timer = setInterval(() => this.poll(), 4000);
    this.poll();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.active;
  }

  private poll() {
    if (this.active || this.abort.signal.aborted) return;
    this.active = this.tick()
      .catch((error) => log("error", "wecom_notification_poll_failed", {}, error))
      .finally(() => {
        this.active = undefined;
      });
  }

  async tick() {
    if (this.abort.signal.aborted) return;
    await this.store.withChannel(this.wecom.channel, async (session) => {
      const notification = await session.claim();
      if (notification) await this.deliver(session, notification);
    });
  }

  private async deliver(session: NotificationSession, notification: ReviewNotification) {
    const { jobId, repository, repositoryId, installationId, prNumber, headSha, attempt } = notification;
    const finish = async (
      status: "pending" | "sent" | "failed" | "uncertain" | "cancelled",
      error?: string,
      retrySeconds = 60,
    ) => {
      const finalStatus = status === "pending" && attempt >= 3 ? "failed" : status;
      await session.finish(jobId, finalStatus, error, retrySeconds);
      log(finalStatus === "sent" || finalStatus === "cancelled" ? "info" : "error", "wecom_notification_result", {
        jobId,
        repositoryId,
        prNumber,
        status: finalStatus,
        reason: error,
      });
    };
    if (!this.config.allowedRepositories.has(repository.toLowerCase()) || !(await session.enabled(notification))) {
      await finish("cancelled", "repository_disabled");
      return;
    }
    let pr: Awaited<ReturnType<NotificationGitHub["getPullRequest"]>>;
    try {
      const token = await this.github.installationToken(installationId, this.abort.signal);
      pr = await this.github.getPullRequest(token, repository, prNumber, this.abort.signal);
    } catch (error) {
      const denied =
        error instanceof GitHubApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429 &&
        error.retryAfterSeconds === undefined;
      const retrySeconds =
        error instanceof GitHubApiError && error.retryAfterSeconds !== undefined
          ? Math.max(60, Math.min(3600, error.retryAfterSeconds))
          : 60;
      await finish(
        denied ? "failed" : "pending",
        denied ? "github_access_denied" : "github_lookup_failed",
        retrySeconds,
      );
      return;
    }
    // PR 作者来自 GitHub 的 user，而不是触发 synchronize 的操作者或提交作者。
    if (
      !pr ||
      typeof pr.title !== "string" ||
      typeof pr.state !== "string" ||
      typeof pr.draft !== "boolean" ||
      typeof pr.head?.sha !== "string" ||
      !Number.isSafeInteger(pr.user?.id) ||
      typeof pr.user?.login !== "string"
    ) {
      await finish("failed", "github_invalid_pull_request");
      return;
    }
    if (pr.state !== "open" || pr.draft || pr.head.sha !== headSha) {
      await finish("cancelled", "pull_request_changed");
      return;
    }
    const userid = await session.member(repositoryId, pr.user.login);
    if (!userid) {
      await finish("failed", "author_mapping_missing");
      return;
    }
    if (this.abort.signal.aborted) {
      await finish("pending", "service_stopping");
      return;
    }
    if (!(await session.enabled(notification))) {
      await finish("cancelled", "repository_disabled");
      return;
    }
    if (!(await session.sending(jobId))) return;
    const result = await this.client.send(notificationMessage(notification, userid, pr.title), this.abort.signal);
    await finish(result.status, "error" in result ? result.error : undefined);
  }
}
