import assert from "node:assert/strict";
import test from "node:test";
import { linkRepeats } from "../../src/review/finding.js";
import { reviewBody, validateDisplay } from "../../src/review/presentation.js";
import type { Finding, StoredFinding } from "../../src/review/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";

const job = { repository: "o/r", prNumber: 7, baseSha: "b", headSha: "h" } as ReviewJob;
const base = {
  category: "security",
  severity: "medium",
  evidenceLevel: "strong",
  description: "d",
  evidence: "e",
  impact: "i",
} as const;
const prior = (id: string, path: string, title: string, commentId: number) =>
  ({
    ...base,
    id,
    path,
    line: 2,
    side: "RIGHT",
    status: "OPEN",
    bindingStatus: "bound",
    githubCommentId: commentId,
    jobId: "j",
    repositoryId: 1,
    prNumber: 7,
    headSha: "old",
    fingerprint: id,
    display: { title, reason: "r", fix: "f" },
  }) as StoredFinding;
const current = (path: string, previousFindingId?: string): Finding => ({
  ...base,
  path,
  line: 3,
  side: "RIGHT",
  display: { title: "新说法", reason: "r", fix: "f", previousFindingId },
});

test("只认同一文件、存在且未被认领的旧问题，其余当新问题；返回没再出现的数量", () => {
  const previous = [
    prior("a", "src/auth.ts", "令牌写进日志", 11),
    prior("b", "src/report.ts", "公式注入", 12),
    prior("c", "src/x.ts", "旧问题", 13),
  ];
  const findings = [
    current("src/auth.ts", "a"),
    current("src/auth.ts", "a"),
    current("src/other.ts", "b"),
    current("src/y.ts", "missing"),
    current("src/z.ts"),
  ];
  assert.equal(linkRepeats(findings, previous), 2);
  assert.deepEqual(findings[0]!.repeatOf, { id: "a", commentId: 11, title: "令牌写进日志" });
  assert.equal(findings[1]!.repeatOf, undefined, "同一条旧问题只能对应一组");
  assert.equal(findings[2]!.repeatOf, undefined, "文件不同不算同一个");
  assert.equal(findings[3]!.repeatOf, undefined);
  assert.throws(
    () => validateDisplay({ title: "t", reason: "r", fix: "f", previousFindingId: 3 }),
    /previousFindingId/,
  );
});

test("总评区分新问题和之前仍未解决的问题，后者指回原评论", () => {
  const repeat = {
    ...current("src/auth.ts"),
    severity: "high",
    repeatOf: { id: "a", commentId: 11, title: "令牌写进日志" },
  } as Finding;
  const fresh = { ...current("src/new.ts"), display: { title: "新发现的问题", reason: "r", fix: "f" } } as Finding;
  const body = reviewBody(job, {
    summary: "",
    findings: [repeat, fresh],
    coverage: [],
    limitations: [],
    resolvedPrevious: 2,
  });
  assert.match(body, /发现 1 个新问题\n\n- 🟠 建议改 · \[new\.ts:3\].* · 新发现的问题/);
  assert.match(
    body,
    /之前提过、仍未解决的 1 个：\n\n- 🔴 必须改 · \[之前的评论\]\(https:\/\/github\.com\/o\/r\/pull\/7#discussion_r11\) · 令牌写进日志/,
  );
  assert.match(body, /之前的 2 个问题这次没有再发现。/);
  assert(!body.includes("新说法"));
  const onlyRepeats = reviewBody(job, { summary: "", findings: [repeat], coverage: [], limitations: [] });
  assert.match(onlyRepeats, /没有发现新问题/);
  assert(!onlyRepeats.includes("✅"));
  const allResolved = reviewBody(job, {
    summary: "",
    findings: [],
    coverage: [],
    limitations: [],
    resolvedPrevious: 1,
  });
  assert.match(allResolved, /✅ 没发现需要改的问题[\s\S]*之前的 1 个问题这次没有再发现。/);
});
