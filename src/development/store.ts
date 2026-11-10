import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Config } from "../config/config.js";
import { SESSION_SUMMARY } from "../persistence/repositories/agent-session.repository.js";
import { isStartCommand } from "./policy.js";
import {
  DevelopmentError,
  type DevelopmentSettings,
  type DevelopmentTask,
  type GroupRequest,
  type PullRequestCommentInput,
  type TaskStatus,
} from "./types.js";

export class DevelopmentStore {
  constructor(readonly pool: Pool) {}
  async isDevelopmentPullRequest(repositoryId: number, prNumber: number, branch: string | undefined, headSha: string) {
    const known = await this.pool.query("SELECT 1 FROM development_tasks WHERE repository_id=$1 AND pr_number=$2", [
      repositoryId,
      prNumber,
    ]);
    if (known.rowCount) return true;
    if (!branch?.startsWith("bot/development/")) return false;
    const matched = await this.pool.query(
      `UPDATE development_tasks SET pr_number=$2 WHERE repository_id=$1 AND branch=$3 AND head_sha=$4
      AND pr_number IS NULL AND status IN ('publishing','succeeded','uncertain') RETURNING id`,
      [repositoryId, prNumber, branch, headSha],
    );
    return Boolean(matched.rowCount);
  }
  async settings(repositoryId: number): Promise<DevelopmentSettings | undefined> {
    return (
      await this.pool.query(
        `SELECT chat_id AS "chatId",target_branch AS "targetBranch",enabled,members,protections,version
      FROM development_settings WHERE repository_id=$1`,
        [repositoryId],
      )
    ).rows[0];
  }
  async saveSettings(repositoryId: number, value: DevelopmentSettings, actor: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM repositories WHERE id=$1 FOR UPDATE", [repositoryId]);
      const current = (
        await client.query("SELECT version FROM development_settings WHERE repository_id=$1 FOR UPDATE", [repositoryId])
      ).rows[0];
      if ((current?.version ?? 0) !== value.version) throw new DevelopmentError("设置已被其他人修改，请刷新后再保存");
      await client.query(
        `INSERT INTO development_settings(repository_id,chat_id,target_branch,enabled,members,protections,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(repository_id) DO UPDATE SET chat_id=$2,target_branch=$3,enabled=$4,members=$5,
        protections=$6,updated_by=$7,version=development_settings.version+1,updated_at=now()`,
        [
          repositoryId,
          value.chatId,
          value.targetBranch,
          value.enabled,
          JSON.stringify(value.members),
          JSON.stringify(value.protections),
          actor,
        ],
      );
      await client.query("INSERT INTO development_settings_audits(repository_id,actor,settings) VALUES($1,$2,$3)", [
        repositoryId,
        actor,
        JSON.stringify(value),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new DevelopmentError("该群已经绑定其他仓库");
      throw error;
    } finally {
      client.release();
    }
    return this.settings(repositoryId);
  }
  async accept(botId: string, input: GroupRequest, config: Pick<Config, "allowedRepositories" | "queueCapacity">) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4897040)");
      if (
        (
          await client.query("SELECT id FROM development_tasks WHERE bot_id=$1 AND message_id=$2", [
            botId,
            input.messageId,
          ])
        ).rowCount
      ) {
        await client.query("COMMIT");
        return "duplicate" as const;
      }
      const binding = (
        await client.query(
          `SELECT s.*,r.full_name,r.installation_id FROM development_settings s JOIN repositories r ON r.id=s.repository_id
        WHERE s.chat_id=$1 AND s.enabled AND r.enabled AND r.revoked_at IS NULL FOR SHARE OF s,r`,
          [input.chatId],
        )
      ).rows[0];
      if (!binding || !config.allowedRepositories.has(binding.full_name.toLowerCase()))
        throw new DevelopmentError("此群未绑定已启用的开发仓库，请联系管理员。", "refused");
      const member = (binding.members as DevelopmentSettings["members"]).find((m) => m.userid === input.requester);
      if (!member) throw new DevelopmentError("你尚未被设置为该仓库的管理员或开发，不能发起开发任务。", "refused");
      const count = (
        await client.query(
          "SELECT count(*)::int n FROM development_tasks WHERE bot_id=$1 AND status IN ('queued','running','publishing')",
          [botId],
        )
      ).rows[0].n;
      if (count >= config.queueCapacity)
        throw new DevelopmentError("开发任务队列已满，请稍后重新发起任务。", "refused");
      const id = randomUUID();
      await client.query(
        `INSERT INTO development_tasks(id,bot_id,message_id,chat_id,requester,repository_id,installation_id,repository,target_branch,branch,
        settings_version,role,prompt,images,reply_req_id,reply_expires_at,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued')`,
        [
          id,
          botId,
          input.messageId,
          input.chatId,
          input.requester,
          binding.repository_id,
          binding.installation_id,
          binding.full_name,
          binding.target_branch,
          `bot/development/${id}`,
          binding.version,
          member.role,
          input.text,
          JSON.stringify(input.images),
          input.replyRequestId,
          new Date(input.receivedAt.getTime() + 24 * 60 * 60 * 1000),
        ],
      );
      await client.query("COMMIT");
      return "accepted" as const;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  // 同一项目排在这条消息前面、还没结束的任务数（含正在做的）。
  async ahead(botId: string, messageId: string): Promise<number> {
    return (
      (
        await this.pool.query(
          `SELECT count(*)::int n FROM development_tasks me JOIN development_tasks t ON t.repository_id=me.repository_id AND t.id<>me.id
         WHERE me.bot_id=$1 AND me.message_id=$2 AND t.status IN ('queued','running','publishing')
           AND (t.status<>'queued' OR (t.created_at,t.id) < (me.created_at,me.id))`,
          [botId, messageId],
        )
      ).rows[0]?.n ?? 0
    );
  }
  // 按发送顺序领取。开发任务同一项目一个一个来，先做其他项目的；issue 讨论只读代码，不等开发任务，
  // 但同一个 issue 的讨论回复一次只跑一条，避免同时回两遍；同一个 PR 的评论修改也一次一条。
  async claim(botId: string): Promise<DevelopmentTask | undefined> {
    return (
      await this.pool.query(
        `UPDATE development_tasks SET status='running',owner_token=$2,started_at=now(),updated_at=now() WHERE id=(
      SELECT t.id FROM development_tasks t WHERE t.bot_id=$1 AND t.status='queued'
        AND NOT EXISTS (SELECT 1 FROM development_tasks r WHERE r.repository_id=t.repository_id AND r.status IN ('running','publishing')
          AND (CASE WHEN t.kind='develop' THEN r.kind='develop'
            WHEN t.kind='revise' THEN r.kind='revise' AND r.pr_number=t.pr_number
            ELSE r.kind IN ('discuss','notice') AND r.issue_number=t.issue_number END))
      ORDER BY t.created_at,t.id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
        [botId, randomUUID()],
      )
    ).rows[0];
  }

  // GitHub 上 issue 的一条新评论。讨论中的 issue：提需求的人说“开始”就排一个开发任务，别人说“开始”回一条提示，
  // 其他评论排一个讨论回复。开发中或已完成的 issue 不再处理。按评论 id 去重，重投的 Webhook 不会重复排任务。
  async acceptIssueComment(
    input: { repositoryId: number; issueNumber: number; commentId: number; login: string; body: string },
    config: Pick<Config, "allowedRepositories" | "queueCapacity">,
  ): Promise<{ kind: "accepted" | "duplicate" | "ignored"; taskKind?: "develop" | "discuss" | "notice" }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4897040)");
      const issue = (
        await client.query(
          `SELECT i.status,t.bot_id,t.chat_id,t.requester,t.installation_id,t.repository,t.target_branch
          FROM development_issues i JOIN development_tasks t ON t.id=i.origin_task_id
          WHERE i.repository_id=$1 AND i.issue_number=$2 FOR UPDATE OF i`,
          [input.repositoryId, input.issueNumber],
        )
      ).rows[0];
      if (!issue || issue.status === "done" || !config.allowedRepositories.has(issue.repository.toLowerCase())) {
        await client.query("COMMIT");
        return { kind: "ignored" };
      }
      const messageId = `issue-comment:${input.commentId}`;
      if (
        (
          await client.query("SELECT 1 FROM development_tasks WHERE bot_id=$1 AND message_id=$2", [
            issue.bot_id,
            messageId,
          ])
        ).rowCount
      ) {
        await client.query("COMMIT");
        return { kind: "duplicate" };
      }
      const settings = (
        await client.query(
          `SELECT s.version,s.members FROM development_settings s JOIN repositories r ON r.id=s.repository_id
          WHERE s.repository_id=$1 AND s.chat_id=$2 AND s.enabled AND r.enabled AND r.revoked_at IS NULL FOR SHARE OF s`,
          [input.repositoryId, issue.chat_id],
        )
      ).rows[0];
      const member = (settings?.members as DevelopmentSettings["members"] | undefined)?.find(
        (m) => m.userid === issue.requester,
      );
      const logins = await this.requesterLogins(input.repositoryId, issue.requester, client);
      let kind: "develop" | "discuss" | "notice";
      let prompt: string;
      if (!settings || !member) {
        kind = "notice";
        prompt =
          "这个仓库的群内开发已关闭，或提需求的人已不是开发成员，这个 issue 不能继续了。需要的话请在群里重新发起。";
      } else if (issue.status === "developing") {
        kind = "notice";
        prompt = "已经在开发了，这条回复不会用上。PR 建好后会贴在这里，有新要求可以在 PR 里说。";
      } else if (!isStartCommand(input.body)) {
        kind = "discuss";
        prompt = input.body;
      } else if (logins.includes(input.login.toLowerCase())) {
        kind = "develop";
        prompt = `issue #${input.issueNumber} 的讨论（开发时从 GitHub 读取）`;
      } else {
        kind = "notice";
        prompt = logins.length
          ? `只有提需求的 ${logins.map((login) => `@${login}`).join("、")} 回复“开始”才会开工。`
          : "提需求的人还没有关联 GitHub 账号，“开始”不会生效。请管理员在管理页「仓库 → 群内开发 → 成员关联」里关联后，由本人回复“开始”。";
      }
      const count = (
        await client.query(
          "SELECT count(*)::int n FROM development_tasks WHERE bot_id=$1 AND status IN ('queued','running','publishing')",
          [issue.bot_id],
        )
      ).rows[0].n;
      if (count >= config.queueCapacity) throw new DevelopmentError("开发任务队列已满", "refused");
      const id = randomUUID();
      await client.query(
        `INSERT INTO development_tasks(id,bot_id,message_id,chat_id,requester,repository_id,installation_id,repository,target_branch,branch,
        settings_version,role,prompt,images,status,kind,issue_number,notification_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'[]','queued',$14,$15,$16)`,
        [
          id,
          issue.bot_id,
          messageId,
          issue.chat_id,
          issue.requester,
          input.repositoryId,
          issue.installation_id,
          issue.repository,
          issue.target_branch,
          `bot/development/${id}`,
          settings?.version ?? 0,
          member?.role ?? "developer",
          prompt,
          kind,
          input.issueNumber,
          // 讨论回复和提示只在 issue 里出现；开发结果照常通知群里。
          kind === "develop" ? "pending" : "skipped",
        ],
      );
      if (kind === "develop")
        await client.query(
          "UPDATE development_issues SET status='developing',updated_at=now() WHERE repository_id=$1 AND issue_number=$2",
          [input.repositoryId, input.issueNumber],
        );
      await client.query("COMMIT");
      return { kind: "accepted", taskKind: kind };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 开发 PR 下的一条新评论（PR 对话、代码行评论或 review 正文）。有仓库权限的人的每条评论都排一个 revise 任务，
  // Agent 读完再决定改代码、回复还是不处理。按评论 id 去重；不是开发 PR、PR 已关闭由调用方或这里忽略。
  async acceptPullRequestComment(
    input: PullRequestCommentInput,
    config: Pick<Config, "allowedRepositories" | "queueCapacity">,
  ): Promise<{ kind: "accepted" | "duplicate" | "ignored"; taskKind?: "revise" | "notice" }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4897040)");
      const origin = (
        await client.query(
          `SELECT bot_id,chat_id,requester,installation_id,repository,target_branch,branch FROM development_tasks
          WHERE repository_id=$1 AND pr_number=$2 AND kind='develop' ORDER BY created_at LIMIT 1`,
          [input.repositoryId, input.prNumber],
        )
      ).rows[0];
      if (!origin || !config.allowedRepositories.has(origin.repository.toLowerCase())) {
        await client.query("COMMIT");
        return { kind: "ignored" };
      }
      const messageId = `pr-${input.source}:${input.commentId}`;
      if (
        (
          await client.query("SELECT 1 FROM development_tasks WHERE bot_id=$1 AND message_id=$2", [
            origin.bot_id,
            messageId,
          ])
        ).rowCount
      ) {
        await client.query("COMMIT");
        return { kind: "duplicate" };
      }
      const settings = (
        await client.query(
          `SELECT s.version,s.members FROM development_settings s JOIN repositories r ON r.id=s.repository_id
          WHERE s.repository_id=$1 AND s.chat_id=$2 AND s.enabled AND r.enabled AND r.revoked_at IS NULL FOR SHARE OF s`,
          [input.repositoryId, origin.chat_id],
        )
      ).rows[0];
      // 评论人关联的成员是管理员时按管理员身份（可以改管理员专属的保护文件），其余人按开发身份。
      const mapped = (
        await client.query(
          "SELECT wecom_userid FROM repository_notification_members WHERE repository_id=$1 AND github_login=lower($2)",
          [input.repositoryId, input.login],
        )
      ).rows.map((row) => String(row.wecom_userid));
      const admin = (settings?.members as DevelopmentSettings["members"] | undefined)?.find(
        (m) => m.role === "admin" && mapped.includes(m.userid),
      );
      const kind = settings ? "revise" : "notice";
      const count = (
        await client.query(
          "SELECT count(*)::int n FROM development_tasks WHERE bot_id=$1 AND status IN ('queued','running','publishing')",
          [origin.bot_id],
        )
      ).rows[0].n;
      if (count >= config.queueCapacity) throw new DevelopmentError("开发任务队列已满", "refused");
      await client.query(
        `INSERT INTO development_tasks(id,bot_id,message_id,chat_id,requester,repository_id,installation_id,repository,target_branch,branch,
        settings_version,role,prompt,images,status,kind,pr_number,notification_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'[]','queued',$14,$15,$16)`,
        [
          randomUUID(),
          origin.bot_id,
          messageId,
          origin.chat_id,
          admin?.userid ?? origin.requester,
          input.repositoryId,
          origin.installation_id,
          origin.repository,
          origin.target_branch,
          origin.branch,
          settings?.version ?? 0,
          admin ? "admin" : "developer",
          settings ? input.body : "这个仓库的群内开发已关闭，PR 里的评论不会再处理。",
          kind,
          input.prNumber,
          // 改了代码才通知群里，由处理结果决定；提示只在 PR 里出现。
          kind === "revise" ? "pending" : "skipped",
        ],
      );
      await client.query("COMMIT");
      return { kind: "accepted", taskKind: kind };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 开发 PR 关闭或合并：任务到此结束。还在排队或正在跑的评论修改全部取消；正在跑的会在下一次权限检查时
  // 发现执行权没了，结束 Agent 和它启动的进程，删掉工作区。已经在推送提交的不打断。
  async closePullRequest(repositoryId: number, prNumber: number) {
    await this.pool.query(
      `UPDATE development_tasks SET status='cancelled',result='PR 已关闭，评论不再处理。',owner_token=NULL,images='[]',
      notification_status=CASE WHEN notification_status='pending' THEN 'skipped' ELSE notification_status END,updated_at=now()
      WHERE repository_id=$1 AND pr_number=$2 AND kind IN ('revise','notice') AND status IN ('queued','running')`,
      [repositoryId, prNumber],
    );
  }

  // 同一个 PR 后面还有排队的评论修改时，这一条不用跑：后面那条会读到全部评论。
  async laterRevision(task: DevelopmentTask) {
    return Boolean(
      (
        await this.pool.query(
          `SELECT 1 FROM development_tasks WHERE repository_id=$1 AND pr_number=$2 AND kind='revise' AND status='queued'
          AND (created_at,id) > ((SELECT created_at FROM development_tasks WHERE id=$3),$3::uuid) LIMIT 1`,
          [task.repository_id, task.pr_number, task.id],
        )
      ).rowCount,
    );
  }

  // 上一次处理完这个 PR 评论的开始时间；之后的评论算新评论。
  async lastRevisionAt(task: DevelopmentTask): Promise<Date | undefined> {
    return (
      (
        await this.pool.query(
          `SELECT max(started_at) at FROM development_tasks WHERE repository_id=$1 AND pr_number=$2 AND kind='revise'
        AND status='succeeded' AND id<>$3`,
          [task.repository_id, task.pr_number, task.id],
        )
      ).rows[0]?.at ?? undefined
    );
  }

  // 最初在群里提的需求原文。
  async pullRequestOrigin(task: DevelopmentTask): Promise<string> {
    return (
      (
        await this.pool.query(
          `SELECT t.prompt,i.prompt issue_prompt FROM development_tasks t
          LEFT JOIN development_issues di ON di.repository_id=t.repository_id AND di.issue_number=t.issue_number
          LEFT JOIN development_tasks i ON i.id=di.origin_task_id
          WHERE t.repository_id=$1 AND t.pr_number=$2 AND t.kind='develop' ORDER BY t.created_at LIMIT 1`,
          [task.repository_id, task.pr_number],
        )
      ).rows.map((row) => String(row.issue_prompt ?? row.prompt))[0] ?? ""
    );
  }

  // 提需求的人（企微成员）在这个仓库关联的 GitHub 账号，来自管理页的成员关联。
  async requesterLogins(repositoryId: number, requester: string, client: Pool | PoolClient = this.pool) {
    return (
      await client.query(
        "SELECT github_login FROM repository_notification_members WHERE repository_id=$1 AND wecom_userid=$2 ORDER BY github_login",
        [repositoryId, requester],
      )
    ).rows.map((row) => String(row.github_login));
  }

  async recordIssue(task: DevelopmentTask, issueNumber: number) {
    await this.pool.query(
      "INSERT INTO development_issues(repository_id,issue_number,origin_task_id,status) VALUES($1,$2,$3,'discussing')",
      [task.repository_id, issueNumber, task.id],
    );
  }

  async setIssueStatus(task: DevelopmentTask, status: "discussing" | "developing") {
    await this.pool.query(
      "UPDATE development_issues SET status=$3,updated_at=now() WHERE repository_id=$1 AND issue_number=$2",
      [task.repository_id, task.issue_number, status],
    );
  }

  // PR 建好：issue 结束，最初开 issue 的任务不再显示“已开 issue 讨论”。
  async finishIssue(task: DevelopmentTask, prNumber: number) {
    await this.pool.query(
      `WITH issue AS (
        UPDATE development_issues SET status='done',updated_at=now() WHERE repository_id=$1 AND issue_number=$2
        RETURNING origin_task_id
      )
      UPDATE development_tasks t SET status='succeeded',result=$3,updated_at=now()
      FROM issue WHERE t.id=issue.origin_task_id AND t.status='discussing'`,
      [task.repository_id, task.issue_number, `issue #${task.issue_number} 讨论后已建 PR #${prNumber}。`],
    );
  }

  // 讨论 issue 的来历：群里最初的需求原文。
  async issueOrigin(task: DevelopmentTask) {
    return (
      await this.pool.query(
        `SELECT i.status,t.prompt FROM development_issues i JOIN development_tasks t ON t.id=i.origin_task_id
        WHERE i.repository_id=$1 AND i.issue_number=$2`,
        [task.repository_id, task.issue_number],
      )
    ).rows[0] as { status: string; prompt: string } | undefined;
  }

  // 同一个 issue 后面还有排队的讨论回复时，这一条不用回：后面那条会读到全部讨论。
  async laterDiscussion(task: DevelopmentTask) {
    return Boolean(
      (
        await this.pool.query(
          `SELECT 1 FROM development_tasks WHERE repository_id=$1 AND issue_number=$2 AND kind='discuss' AND status='queued'
          AND (created_at,id) > ((SELECT created_at FROM development_tasks WHERE id=$3),$3::uuid) LIMIT 1`,
          [task.repository_id, task.issue_number, task.id],
        )
      ).rowCount,
    );
  }
  async permission(task: DevelopmentTask, config: Pick<Config, "allowedRepositories">) {
    const row = (
      await this.pool.query(
        `SELECT s.protections FROM development_settings s JOIN repositories r ON r.id=s.repository_id
      WHERE s.repository_id=$1 AND s.version=$2 AND s.chat_id=$3 AND s.target_branch=$4 AND s.enabled AND r.enabled
      AND EXISTS (SELECT 1 FROM development_tasks t WHERE t.id=$9 AND t.owner_token=$10 AND t.status IN ('running','publishing'))
      AND r.revoked_at IS NULL AND r.installation_id=$5 AND r.full_name=$6 AND ($11 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.members) m WHERE m->>'userid'=$7 AND m->>'role'=$8))`,
        [
          task.repository_id,
          task.settings_version,
          task.chat_id,
          task.target_branch,
          task.installation_id,
          task.repository,
          task.requester,
          task.role,
          task.id,
          task.owner_token,
          // PR 评论的发起人可以不是群成员：按开发身份处理时不要求是成员。
          task.kind === "revise" && task.role === "developer",
        ],
      )
    ).rows[0];
    if (!row || !config.allowedRepositories.has(task.repository.toLowerCase()))
      throw new DevelopmentError(
        "任务已取消：仓库、群绑定、成员身份或保护设置已变化，请按新设置重新发起。",
        "cancelled",
      );
    return {
      protections: row.protections as DevelopmentSettings["protections"],
    };
  }
  async finish(task: DevelopmentTask, status: TaskStatus, result: string) {
    await this.pool.query(
      "UPDATE development_tasks SET status=$2,result=$3,images='[]',duration_ms=(EXTRACT(EPOCH FROM (now()-started_at))*1000)::integer,updated_at=now() WHERE id=$1 AND owner_token=$4",
      [task.id, status, result, task.owner_token],
    );
  }
  // 不在群里通知：讨论回复、没改代码的 PR 评论处理等。
  async skipNotification(task: DevelopmentTask) {
    await this.pool.query(
      "UPDATE development_tasks SET notification_status='skipped' WHERE id=$1 AND owner_token=$2 AND notification_status='pending'",
      [task.id, task.owner_token],
    );
  }
  async checkpoint(
    task: DevelopmentTask,
    fields: {
      baseSha?: string;
      headSha?: string;
      title?: string;
      rules?: unknown;
      usage?: unknown;
      durationMs?: number;
      publishing?: boolean;
      prNumber?: number;
      model?: string;
      issueNumber?: number;
    },
  ) {
    const result = await this.pool.query(
      `UPDATE development_tasks SET base_sha=COALESCE($3,base_sha),head_sha=COALESCE($4,head_sha),
      title=COALESCE($5,title),rule_snapshot=COALESCE($6,rule_snapshot),usage=COALESCE($7,usage),duration_ms=COALESCE($8,duration_ms),
      status=CASE WHEN $9 THEN 'publishing' ELSE status END,pr_number=COALESCE($10,pr_number),model=COALESCE($11,model),
      issue_number=COALESCE($12,issue_number),updated_at=now()
      WHERE id=$1 AND owner_token=$2 AND status IN ('running','publishing')`,
      [
        task.id,
        task.owner_token,
        fields.baseSha,
        fields.headSha,
        fields.title,
        fields.rules === undefined ? null : JSON.stringify(fields.rules),
        fields.usage === undefined ? null : JSON.stringify(fields.usage),
        fields.durationMs,
        fields.publishing ?? false,
        fields.prNumber,
        fields.model,
        fields.issueNumber,
      ],
    );
    if (!result.rowCount) throw new DevelopmentError("任务执行权已失效", "cancelled");
  }
  async recover(botId: string) {
    await this.pool.query(
      `UPDATE development_tasks SET status=CASE WHEN status='publishing' THEN 'uncertain' ELSE 'cancelled' END,
      result=CASE WHEN status='publishing' THEN '服务中断，PR 发布结果待核对；不会自动重复提交。' ELSE '服务中断，开发任务已取消，请重新发起。' END,
      images='[]',owner_token=NULL,updated_at=now() WHERE bot_id=$1 AND status IN ('running','publishing')`,
      [botId],
    );
    await this.pool.query(
      "UPDATE development_tasks SET notification_status='uncertain',notification_error='delivery_interrupted' WHERE bot_id=$1 AND notification_status='sending'",
      [botId],
    );
    // 开发中断的 issue 回到讨论中，提需求的人可以再说“开始”。
    await this.pool.query(
      `UPDATE development_issues i SET status='discussing',updated_at=now() WHERE status='developing'
      AND EXISTS (SELECT 1 FROM development_tasks o WHERE o.id=i.origin_task_id AND o.bot_id=$1)
      AND NOT EXISTS (SELECT 1 FROM development_tasks t WHERE t.repository_id=i.repository_id AND t.issue_number=i.issue_number
        AND t.kind='develop' AND t.status IN ('queued','running','publishing','uncertain'))`,
      [botId],
    );
  }
  async list(repositoryId: number) {
    return (
      await this.pool.query(
        `SELECT t.id,requester,status,kind,issue_number,branch,target_branch,base_sha,head_sha,pr_number,title,result,model,usage,t.duration_ms,
      notification_status,notification_error,created_at,
      COALESCE((SELECT jsonb_agg(${SESSION_SUMMARY("s")} ORDER BY s.started_at) FROM agent_sessions s WHERE s.development_task_id=t.id),'[]') agent_sessions
      FROM development_tasks t WHERE repository_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [repositoryId],
      )
    ).rows;
  }
  async withLeader(botId: string, run: (client: PoolClient) => Promise<void>) {
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    try {
      locked = (await client.query("SELECT pg_try_advisory_lock(4897041,hashtext($1)) locked", [botId])).rows[0].locked;
      if (locked) await run(client);
    } finally {
      if (locked)
        await client.query("SELECT pg_advisory_unlock(4897041,hashtext($1))", [botId]).catch(() => {
          broken = true;
        });
      client.release(broken);
    }
  }
}
