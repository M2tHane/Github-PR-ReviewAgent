import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/persistence/database.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();
const DAY = 86_400_000;
const now = new Date("2026-11-05T00:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

test("数据清理：过期 PR 整组删除，活跃 PR、未结束任务和最近一份健康报告保留", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  try {
    const db = database.pool;
    const repo = 9_100_000_001;
    await db.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/retention')", [repo]);
    const delivery = async (id: string, days: number) =>
      db.query(
        "INSERT INTO webhook_deliveries(delivery_id,event,action,repository_id,installation_id,received_at) VALUES($1,'pull_request','opened',$2,1,$3)",
        [id, repo, ago(days)],
      );
    const job = async (pr: number | null, days: number, status = "succeeded", deliveryId: string | null = null) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO jobs(id,delivery_id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,status,created_at,updated_at) VALUES($1,$2,$3,$4,1,'owner/retention',$5,$6,$7,$8,$9,$9)",
        [
          id,
          deliveryId,
          pr === null ? "HEALTH_AUDIT" : "PR_REVIEW",
          repo,
          pr,
          randomUUID(),
          pr === null ? null : "base",
          status,
          ago(days),
        ],
      );
      return id;
    };
    // PR 1：最后一次活动在 100 天前，整组删除，连同审查结果、线程回复、规则线索和 Agent 记录。
    await delivery("old-delivery", 100);
    const stale = await job(1, 100, "succeeded", "old-delivery");
    await db.query("INSERT INTO review_publications(job_id,fingerprint,status) VALUES($1,'fp-stale','published')", [
      stale,
    ]);
    await db.query(
      "INSERT INTO review_findings(id,job_id,repository_id,pr_number,head_sha,fingerprint,category,severity,evidence_level,description,evidence,impact) VALUES('f-stale',$1,$2,1,'h','ff-stale','security','high','strong','d','e','i')",
      [stale, repo],
    );
    const replyJob = await job(1, 99);
    await db.query(
      "INSERT INTO reply_publications(source_comment_id,job_id,finding_id,status) VALUES(77,$1,'f-stale','published')",
      [replyJob],
    );
    await db.query(
      "INSERT INTO decision_clues(id,repository_id,pr_number,finding_id,source_human_comment_id,analysis_head_sha,type,summary) VALUES($1,$2,1,'f-stale',77,'h','possible_exception','s')",
      [randomUUID(), repo],
    );
    const parentRun = randomUUID();
    await db.query(
      "INSERT INTO agent_runs(id,job_id,role,status,input_budget_tokens,timeout_ms) VALUES($1,$2,'main','succeeded',1,1)",
      [parentRun, stale],
    );
    await db.query(
      "INSERT INTO agent_runs(id,job_id,parent_run_id,role,status,input_budget_tokens,timeout_ms) VALUES($1,$2,$3,'security','succeeded',1,1)",
      [randomUUID(), stale, parentRun],
    );
    // PR 2：旧任务 + 最近的任务，PR 还活跃，全部保留。
    const activeOld = await job(2, 100);
    const activeNew = await job(2, 3);
    // PR 3：旧任务，但同一个 PR 还有排队中的任务，保留。
    const queuedOld = await job(3, 100);
    const queued = await job(3, 100, "queued");
    // 健康检查：三份旧报告只留最新的那份；没有报告的旧任务删除。
    const health = [];
    for (const days of [120, 110, 100]) {
      const id = await job(null, days);
      await db.query("INSERT INTO health_reports(job_id,report,created_at) VALUES($1,'{}',$2)", [id, ago(days)]);
      health.push(id);
    }
    const failedHealth = await job(null, 95, "failed");
    await delivery("orphan-old", 100);
    await delivery("orphan-new", 1);

    // 执行过程记录：PR 任务的随任务删除；开发任务只删过期的记录，任务本身保留。
    const session = (owner: { job?: string; run?: string; task?: string }, days: number) =>
      db.query(
        "INSERT INTO agent_sessions(id,job_id,agent_run_id,development_task_id,role,status,started_at,duration_ms,steps,bytes,content,created_at) VALUES($1,$2,$3,$4,'r','succeeded',$5,1,0,0,'',$5)",
        [randomUUID(), owner.job ?? null, owner.run ?? null, owner.task ?? null, ago(days)],
      );
    await session({ job: stale, run: parentRun }, 100);
    await session({ job: activeOld }, 100);
    const task = randomUUID();
    await db.query(
      "INSERT INTO development_tasks(id,bot_id,message_id,chat_id,requester,repository_id,installation_id,repository,target_branch,branch,settings_version,role,prompt,status,created_at) VALUES($1,'bot','m-retention','c','u',$2,1,'owner/retention','main','pi-dev/retention',1,'developer','p','succeeded',$3)",
      [task, repo, ago(100)],
    );
    await session({ task }, 100);
    await session({ task }, 3);

    assert.deepEqual(await database.purgeExpired({ retentionDays: 0, revokedGraceDays: 0 }, now), {
      jobs: 0,
      deliveries: 0,
      repositories: 0,
      sessions: 0,
    });
    const result = await database.purgeExpired({ retentionDays: 90, revokedGraceDays: 30 }, now);
    assert.deepEqual(result, { jobs: 5, deliveries: 2, repositories: 0, sessions: 1 });
    assert.deepEqual(
      (await db.query("SELECT job_id,development_task_id FROM agent_sessions ORDER BY created_at")).rows,
      [
        { job_id: activeOld, development_task_id: null },
        { job_id: null, development_task_id: task },
      ],
      "过期 PR 的记录随任务删除，活跃 PR 和开发任务最近的记录保留",
    );
    assert.equal((await db.query("SELECT count(*)::int n FROM development_tasks WHERE id=$1", [task])).rows[0].n, 1);
    const left = new Set((await db.query("SELECT id FROM jobs WHERE repository_id=$1", [repo])).rows.map((r) => r.id));
    assert.deepEqual(
      [...left].sort(),
      [activeOld, activeNew, queuedOld, queued, health[2]].sort(),
      "PR 1、两份较旧的健康报告和失败的健康任务被删",
    );
    for (const table of [
      "review_publications",
      "review_findings",
      "reply_publications",
      "decision_clues",
      "agent_runs",
    ])
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0, `${table} 随任务一起删除`);
    assert.deepEqual(
      (await db.query("SELECT delivery_id FROM webhook_deliveries ORDER BY delivery_id")).rows.map(
        (r) => r.delivery_id,
      ),
      ["orphan-new"],
    );
  } finally {
    await database.close();
  }
});

test("数据清理：卸载超过宽限期的仓库删除全部数据；暂停安装和重新安装的不删", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  try {
    const db = database.pool;
    const [removed, suspended, recent, reinstalled] = [9_100_000_011, 9_100_000_012, 9_100_000_013, 9_100_000_014];
    for (const id of [removed, suspended, recent, reinstalled]) {
      await db.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,5,$2)", [id, `owner/r-${id}`]);
      await db.query(
        "INSERT INTO jobs(id,job_type,repository_id,installation_id,repository,target_sha,status) VALUES($1,'HEALTH_AUDIT',$2,5,'x','sha','succeeded')",
        [randomUUID(), id],
      );
      await db.query(
        "INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,source,confidence,status,source_fingerprint) VALUES($1,1,$2,5,'engineering_rule','t','c','r','{}',0.9,'ACTIVE',$3)",
        [randomUUID(), id, `src-${id}`],
      );
    }
    await database.revokeInstallation({
      deliveryId: "d-suspend",
      event: "installation",
      action: "suspend",
      installationId: 5,
      repositoryIds: [suspended],
    });
    await database.revokeInstallation({
      deliveryId: "d-remove",
      event: "installation_repositories",
      action: "removed",
      installationId: 5,
      repositoryIds: [removed, recent, reinstalled],
    });
    await db.query("UPDATE repositories SET revoked_at=$2 WHERE id=ANY($1::bigint[])", [
      [removed, reinstalled],
      ago(40),
    ]);
    await db.query("UPDATE repositories SET revoked_at=$2 WHERE id=$1", [recent, ago(10)]);
    await database.restoreRepositories([reinstalled]);
    const result = await database.purgeExpired({ retentionDays: 0, revokedGraceDays: 30 }, now);
    assert.deepEqual(result, { jobs: 1, deliveries: 0, repositories: 1, sessions: 0 });
    const repos = (await db.query("SELECT id::text FROM repositories WHERE installation_id=5 ORDER BY id")).rows;
    assert.deepEqual(
      repos.map((r) => Number(r.id)),
      [suspended, recent, reinstalled],
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM memories WHERE repository_id=$1", [removed])).rows[0].n,
      0,
      "团队规则也一起删除",
    );
    assert.equal((await db.query("SELECT count(*)::int n FROM memories WHERE installation_id=5")).rows[0].n, 3);
  } finally {
    await database.close();
  }
});

test("数据清理：另一个实例正在清理时直接跳过", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  const holder = await database.pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(4897033)");
    const result = await database.purgeExpired({ retentionDays: 90, revokedGraceDays: 30 }, now);
    assert.equal(result.skipped, "locked");
  } finally {
    await holder.query("SELECT pg_advisory_unlock(4897033)");
    holder.release();
    await database.close();
  }
});
