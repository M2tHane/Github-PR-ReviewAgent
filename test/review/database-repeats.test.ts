import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../../src/persistence/database.js";
import type { Finding } from "../../src/review/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { useTestDatabase } from "../helpers/database.js";

const fixture = useTestDatabase();

test("新提交只拿到上一次 Review 里仍在、且未解决的已绑定问题", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  try {
    const repositoryId = 9_000_000_021;
    const input = (head: string) => ({
      deliveryId: `repeat-${head}`,
      installationId: 1,
      repositoryId,
      repository: "owner/repeat",
      cloneUrl: "url",
      prNumber: 4,
      title: "",
      body: "",
      baseSha: "base",
      headSha: head,
    });
    const review = async (head: string) => {
      const job = (await database.accept(input(head), { event: "pull_request", action: "synchronize" }))
        .job! as ReviewJob;
      job.status = "running";
      return job;
    };
    const finding = (path: string, description: string, extra: Partial<Finding> = {}): Finding => ({
      path,
      line: 1,
      side: "RIGHT",
      category: "correctness",
      severity: "high",
      evidenceLevel: "strong",
      description,
      evidence: "e",
      impact: "i",
      ...extra,
    });
    const bind = (job: ReviewJob, ids: string[], start: number) =>
      database.bindFindings(
        job,
        start,
        ids.map((id, index) => ({ id: start + index, body: `x\n\n<!-- pi-finding:${id} -->` })),
      );

    const job1 = await review("head1");
    const a = finding("src/a.ts", "a"),
      b = finding("src/b.ts", "b");
    const [storedA, storedB] = await database.saveFindings(job1, [a, b], new Set([a, b]));
    await bind(job1, [storedA!.id, storedB!.id], 100);
    await database.finishJob(job1);

    const job2 = await review("head2");
    assert.deepEqual(
      (await database.getOpenFindings(job2)).map((f) => f.id),
      [storedA!.id, storedB!.id],
    );
    const repeatA = finding("src/a.ts", "a again", { repeatOf: { id: storedA!.id, commentId: 100, title: "a" } }),
      c = finding("src/c.ts", "c");
    const [, storedC] = await database.saveFindings(job2, [repeatA, c], new Set([c]));
    await bind(job2, [storedC!.id], 200);
    await database.finishJob(job2);

    const job3 = await review("head3");
    assert.deepEqual(
      (await database.getOpenFindings(job3)).map((f) => f.id),
      [storedA!.id, storedC!.id],
      "b 上次没再出现，不再拿出来",
    );
    await database.pool.query("UPDATE review_findings SET status='FIXED' WHERE id=$1", [storedC!.id]);
    assert.deepEqual(
      (await database.getOpenFindings(job3)).map((f) => f.id),
      [storedA!.id],
      "已修复的不再拿出来",
    );
  } finally {
    await database.close();
  }
});
