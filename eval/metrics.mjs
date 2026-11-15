// 评分只在模型返回之后运行；expected 永远不进入模型输入。
export function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

export function recallScore(expectedIds, full, index) {
  const fullIds = new Set(full.map((rule) => rule.id));
  const providedIds = new Set([...fullIds, ...index.map((rule) => rule.id)]);
  const fullHits = expectedIds.filter((id) => fullIds.has(id)).length;
  const providedHits = expectedIds.filter((id) => providedIds.has(id)).length;
  return {
    expected: expectedIds.length,
    fullHits,
    providedHits,
    fullCoverage: ratio(fullHits, expectedIds.length),
    providedCoverage: ratio(providedHits, expectedIds.length),
    missingIds: expectedIds.filter((id) => !providedIds.has(id)),
    // 与现有 selectReviewMemories 的 30,000 字符预算口径一致。
    fullTextChars: full.reduce((sum, rule) => sum + rule.title.length + rule.content.length + rule.rationale.length, 0),
    // 另计实际适配器载荷 JSON 的 UTF-16 字符数，包括 scope、ID、关系和索引。
    providedChars: JSON.stringify({ rulesFull: full, rulesIndex: index }).length,
  };
}

function matches(proposal, expected) {
  const text = `${proposal.title}\n${proposal.content}\n${proposal.rationale}`.normalize("NFKC").toLowerCase();
  const relation = proposal.relation ?? {};
  const wanted = expected.relation ?? {};
  return (
    proposal.type === expected.type &&
    expected.keywords.every((alternatives) =>
      alternatives.some((keyword) => text.includes(keyword.normalize("NFKC").toLowerCase())),
    ) &&
    ["exceptionTo", "supersedes"].every((field) => relation[field] === wanted[field]) &&
    JSON.stringify([...(relation.conflictsWith ?? [])].sort()) ===
      JSON.stringify([...(wanted.conflictsWith ?? [])].sort())
  );
}

export function extractionScore(proposals, expected) {
  // 最大二分匹配：一条候选最多命中一个标注；重复候选算 FP，避免贪心次序影响分数。
  const owners = new Map();
  const assign = (proposalIndex, visited) => {
    for (let index = 0; index < expected.length; index++) {
      if (visited.has(index) || !matches(proposals[proposalIndex], expected[index])) continue;
      visited.add(index);
      if (!owners.has(index) || assign(owners.get(index), visited)) {
        owners.set(index, proposalIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < proposals.length; index++) assign(index, new Set());
  const tp = owners.size;
  const fp = proposals.length - tp;
  const fn = expected.length - tp;
  return {
    tp,
    fp,
    fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    exact: fp === 0 && fn === 0,
    matches: [...owners].map(([expectedIndex, proposalIndex]) => ({ expectedIndex, proposalIndex })),
  };
}
