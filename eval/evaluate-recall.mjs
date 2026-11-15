import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REVIEW_MEMORY_CHARS } from "../dist/src/memory/memory.service.js";
import { recallScore, ratio } from "./metrics.mjs";
import { loadCases, metadata, option, positiveInteger, saveReport } from "./support.mjs";

const adapter = option("adapter", "current");
const { select } = await import(adapter === "current" ? "./recall/current.mjs" : pathToFileURL(resolve(adapter)).href);
const maxChars = positiveInteger("max-chars", REVIEW_MEMORY_CHARS);
const cases = await loadCases(new URL("./recall/cases/", import.meta.url));
const report = { ...metadata(cases), adapter, maxChars, cases: [] };
for (const sample of cases) {
  const input = { paths: sample.change.paths, text: `${sample.change.title}\n${sample.change.body}` };
  const args = { memories: sample.rules, input, maxChars };
  const { rulesFull, rulesIndex } = await select(args);
  const unbounded = await select({ ...args, maxChars: Number.MAX_SAFE_INTEGER });
  const eligible = new Set([...unbounded.rulesFull, ...unbounded.rulesIndex].map((rule) => rule.id));
  const score = recallScore(sample.expectedIds, rulesFull, rulesIndex);
  const entry = {
    id: sample.id,
    ...score,
    fullIds: rulesFull.map((rule) => rule.id),
    indexIds: rulesIndex.map((rule) => rule.id),
    truncatedExpectedIds: score.missingIds.filter((id) => eligible.has(id)),
    excludedExpectedIds: score.missingIds.filter((id) => !eligible.has(id)),
  };
  report.cases.push(entry);
  console.log(JSON.stringify(entry));
}
const sum = (field) => report.cases.reduce((total, sample) => total + sample[field], 0);
report.summary = {
  cases: cases.length,
  expected: sum("expected"),
  fullHits: sum("fullHits"),
  providedHits: sum("providedHits"),
  fullCoverage: ratio(sum("fullHits"), sum("expected")),
  providedCoverage: ratio(sum("providedHits"), sum("expected")),
  fullTextChars: sum("fullTextChars"),
  providedChars: sum("providedChars"),
  worstTruncated: [...report.cases]
    .sort((a, b) => b.truncatedExpectedIds.length - a.truncatedExpectedIds.length || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(({ id, fullCoverage, providedChars, truncatedExpectedIds }) => ({
      id,
      fullCoverage,
      providedChars,
      truncatedExpectedIds,
    })),
};
console.log(
  JSON.stringify({
    summary: report.summary,
    output: await saveReport(option("output", "work/recall-evaluation.json"), report),
  }),
);
