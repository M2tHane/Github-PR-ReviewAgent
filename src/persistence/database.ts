import { Pool } from "pg";
import { DevelopmentStore } from "../development/store.js";
import type { JobAcceptor } from "./repositories/job.repository.js";
import { JobRepository } from "./repositories/job.repository.js";
import { RepositoryRepository } from "./repositories/repository.repository.js";
import { ReviewPublicationRepository } from "./repositories/review-publication.repository.js";
import { FindingRepository } from "./repositories/finding.repository.js";
import { ReplyRepository } from "./repositories/reply.repository.js";
import { AgentRunRepository } from "./repositories/agent-run.repository.js";
import { AgentSessionRepository } from "./repositories/agent-session.repository.js";
import { HealthRepository } from "./repositories/health.repository.js";
import { MemoryRepository } from "./repositories/memory.repository.js";
import { RetentionRepository } from "./repositories/retention.repository.js";
import { WebhookRedeliveryRepository } from "./repositories/webhook-redelivery.repository.js";
import { migrate } from "./migrations.js";
import type { ReviewReplyInput } from "./repositories/reply.repository.js";
import type { ReviewJob } from "../jobs/types.js";

export type { JobAcceptor, ReviewReplyInput };

// Keep the existing Database API while SQL is owned by business repositories.
const poolSize = (concurrency: number) => 5 + concurrency * 3;

export class Database extends JobRepository implements JobAcceptor {
  private readonly development = new DevelopmentStore(this.pool);
  readonly isDevelopmentPullRequest = this.development.isDevelopmentPullRequest.bind(this.development);
  readonly acceptIssueComment = this.development.acceptIssueComment.bind(this.development);
  readonly acceptPullRequestComment = this.development.acceptPullRequestComment.bind(this.development);
  readonly closeDevelopmentPullRequest = this.development.closePullRequest.bind(this.development);
  private readonly repositories = new RepositoryRepository(this.pool);
  private readonly publications = new ReviewPublicationRepository(this.pool);
  private readonly findings = new FindingRepository(this.pool);
  private readonly replies = new ReplyRepository(this.pool, this.findings);
  private readonly agents = new AgentRunRepository(this.pool);
  private readonly agentSessions = new AgentSessionRepository(this.pool);
  private readonly health = new HealthRepository(this.pool, () => this.isStopping());
  private readonly memories = new MemoryRepository(this.pool);
  private readonly retention = new RetentionRepository(this.pool);
  private readonly webhookRedelivery = new WebhookRedeliveryRepository(this.pool);

  // 每个并发任务会同时占用几条连接（领取、续租、写结果），连接池随并发数放大。
  constructor(
    url: string,
    concurrency = 1,
    private readonly notificationChannel?: string,
  ) {
    super(new Pool({ connectionString: url, max: poolSize(concurrency), connectionTimeoutMillis: 3000 }));
  }
  // 并发数在运行中修改时同步连接池上限；调小时已有连接用完归还后才回落。
  resizePool(concurrency: number) {
    this.pool.options.max = poolSize(concurrency);
  }
  async close() {
    await this.pool.end();
  }
  async check() {
    await this.pool.query("SELECT 1");
  }
  migrate = (directory?: string) => migrate(this.pool, directory);
  readonly isRepositoryEnabled = this.repositories.isRepositoryEnabled.bind(this.repositories);
  readonly setHealthSchedule = this.repositories.setHealthSchedule.bind(this.repositories);
  readonly getRepositoryConfig = this.repositories.getRepositoryConfig.bind(this.repositories);
  readonly beginPublication = this.publications.beginPublication.bind(this.publications);
  readonly finishPublication = (job: ReviewJob, status: "published" | "failed" | "uncertain") =>
    this.publications.finishPublication(job, status, this.notificationChannel);
  readonly saveReviewResult = this.publications.saveReviewResult.bind(this.publications);
  readonly saveFindings = this.findings.saveFindings.bind(this.findings);
  readonly bindFindings = this.findings.bindFindings.bind(this.findings);
  readonly getFinding = this.findings.getFinding.bind(this.findings);
  readonly getOpenFindings = this.findings.getOpenFindings.bind(this.findings);
  readonly getFindingByRoot = this.findings.getFindingByRoot.bind(this.findings);
  readonly acceptReply = this.replies.acceptReply.bind(this.replies);
  readonly retargetReply = this.replies.retargetReply.bind(this.replies);
  readonly isOlderReply = this.replies.isOlderReply.bind(this.replies);
  readonly requeueReply = this.replies.requeueReply.bind(this.replies);
  readonly getReplyPublication = this.replies.getReplyPublication.bind(this.replies);
  readonly finishReply = this.replies.finishReply.bind(this.replies);
  readonly markReplyPublication = this.replies.markReplyPublication.bind(this.replies);
  readonly getDecisionClues = this.replies.getDecisionClues.bind(this.replies);
  readonly checkpointAgentUsage = this.agents.checkpointAgentUsage.bind(this.agents);
  readonly startAgentRun = this.agents.startAgentRun.bind(this.agents);
  readonly jobUsage = this.agents.jobUsage.bind(this.agents);
  readonly finishAgentRun = this.agents.finishAgentRun.bind(this.agents);
  readonly saveAgentSession = this.agentSessions.saveAgentSession.bind(this.agentSessions);
  readonly getAgentSession = this.agentSessions.getAgentSession.bind(this.agentSessions);
  readonly activeHealthJob = this.health.activeHealthJob.bind(this.health);
  readonly enqueueHealth = this.health.enqueueHealth.bind(this.health);
  readonly retryHealth = this.health.retryHealth.bind(this.health);
  readonly healthUsage = this.health.healthUsage.bind(this.health);
  readonly getHealthReport = this.health.getHealthReport.bind(this.health);
  readonly finishHealthReport = this.health.finishHealthReport.bind(this.health);
  readonly insertCandidates = this.memories.insertCandidates.bind(this.memories);
  readonly purgeExpired = this.retention.purgeExpired.bind(this.retention);
  readonly withWebhookRedeliveryLock = <T>(run: () => Promise<T>) => this.webhookRedelivery.withLock(run);
}
