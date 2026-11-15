import { selectReviewMemories } from "../../dist/src/memory/memory.service.js";

export async function select({ memories, input, maxChars }) {
  const { memories: rulesFull } = selectReviewMemories(memories, input, maxChars);
  return { rulesFull, rulesIndex: [] };
}
