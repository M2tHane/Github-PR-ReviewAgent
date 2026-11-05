import { createHash } from "node:crypto";
import type { Finding, StoredFinding } from "./types.js";
import { displayFinding } from "./presentation.js";
import type { ReviewJob } from "../jobs/types.js";

export function diffLines(files: Array<{ filename: string; patch?: string }>) {
  const lines = new Set<string>();
  for (const file of files) {
    let left = 0,
      right = 0;
    for (const text of file.patch?.split("\n") ?? []) {
      const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) {
        left = Number(header[1]);
        right = Number(header[2]);
        continue;
      }
      if ((!left && !right) || text.startsWith("\\")) continue;
      if (text.startsWith("+")) {
        lines.add(`${file.filename}:RIGHT:${right}`);
        right++;
      } else if (text.startsWith("-")) {
        lines.add(`${file.filename}:LEFT:${left}`);
        left++;
      } else {
        lines.add(`${file.filename}:LEFT:${left}`);
        lines.add(`${file.filename}:RIGHT:${right}`);
        left++;
        right++;
      }
    }
  }
  return lines;
}

export function normalizeFindingLocation(finding: Pick<Finding, "path" | "line" | "side">, lines: Set<string>) {
  if (finding.path && finding.line && finding.side && lines.has(`${finding.path}:${finding.side}:${finding.line}`))
    return true;
  delete finding.line;
  delete finding.side;
  return false;
}

export function findingIdentity(job: ReviewJob, finding: Finding, occurrence = 0) {
  const location =
    finding.path && finding.line && finding.side
      ? `${finding.path}:${finding.side}:${finding.line}`
      : `summary:${finding.category}:${finding.description
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim()
          .slice(0, 120)}`;
  const memory = finding.memory ? `${finding.memory.id}:v${finding.memory.version}` : "";
  const fingerprint = createHash("sha256")
    .update(
      `${job.repositoryId}:${job.prNumber}:${job.headSha}:${location}:${finding.category}:${memory}${occurrence ? `:issue-${occurrence}` : ""}`,
    )
    .digest("hex");
  return { id: `finding_${fingerprint.slice(0, 24)}`, fingerprint };
}

// 把模型标出的"和之前同一个问题"落到 finding 上；返回之前的问题里这次没再出现的数量。
// 只接受同一文件里、尚未被别的问题认领的旧问题，对不上就当新问题照常发布。
export function linkRepeats(findings: Finding[], previous: StoredFinding[]) {
  const byId = new Map(previous.map((finding) => [finding.id, finding]));
  const used = new Set<string>();
  for (const finding of findings) {
    const id = finding.display?.previousFindingId;
    const prior = id ? byId.get(id) : undefined;
    if (!id || !prior || used.has(id) || prior.path !== finding.path) continue;
    used.add(id);
    finding.repeatOf = { id, commentId: prior.githubCommentId, title: displayFinding(prior).title };
  }
  return previous.length - used.size;
}
