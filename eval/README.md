# 规则召回与提取评测

这两套评测使用 `cases/*.json` 中的合成数据。期望答案只由评分代码读取，不进入 Prompt、Skill、`agent/` 或模型工作区。仓库的业务行为保持不变，提取评测复用生产的 Prompt、Pi 会话入口和结果解析。

## Review UX 真实模型回归

`node --env-file=.env eval/evaluate-ux.mjs` 使用固定 SHA 的订单样本，每次运行开始时建立独立临时 PostgreSQL schema、执行最新迁移、导入 [固定规则样本](ux/rule-reference.json)，结束时删除 schema。需要 `DATABASE_URL`、模型配置，以及 `work/e2e-order-api` 和 `work/e2e-order-followup` 两个样本仓库 clone；不修改共享 schema，不发布 GitHub 评论。连续运行三次并分别保存 `work/ux-model-evaluation.json`，用于比较逐 case 通过率、findings、用量与耗时；原有聚合和规则引用断言保持不变。

规则样本依据 [PR #8 维护者的原始设计决定](https://github.com/M2tHane/pi-review-test-repository/pull/8#issuecomment-5645822573) 重建，沿用原 ID、版本 2、ACTIVE 状态与项目范围；级别沿用新增级别字段时的默认值 should。原数据库记录已不存在，重建样本的标题、正文和理由与历史版本的措辞可能不同，历史结果不能直接比较。本任务的改前、改后都必须使用同一份重建样本。评测通过当前 `MemoryService.context()` 入口读取规则，不依赖已删除的 `retrieveForReview()`。

## 召回评测（确定性，不调模型）

从仓库根目录运行：

```sh
npm run build
node eval/evaluate-recall.mjs
node --test eval/metrics.test.mjs
```

默认调用 `dist/src/memory/memory.service.js` 的 `selectReviewMemories`，按现有的 30,000 字符预算运行全部 16 个用例。无需模型或数据库配置，可以放进 CI。它输出指标，不把当前尚未达到的 0.9 目标伪装成通过门槛。评分测试验证匹配算法和样例完整性，可以独立运行；现有 `npm test` 不包含 `eval/metrics.test.mjs`。

样例覆盖中文规则与英文路径、路径/模块/语言范围、仅自然语言条件不同的规则、没有 scope 的全局规则、例外带出范围外原规则，以及 100–200 条 `service/**`、`model/**` 宽范围规则超过预算的情况。大规模用例将十类业务约定展开到十个业务域，每条保留正文、理由和条件；它们用于暴露排序、体量和关联丢失问题，不代表真实仓库的规则分布。

每个 JSON 用例包含：

- `rules`：带 `id`、`version`、`type`、`title`、`content`、`rationale`、`scope` 和可选 `exceptionTo` 的生效规则。
- `change`：`paths`、PR `title` 和 `body`。
- `expectedIds`：这次改动必须能够看到的规则 ID。可以提供其他规则，不扣分；冗余成本由字符数呈现。

输出逐用例 JSON，最终汇总并写入 `work/recall-evaluation.json`：

| 指标                   | 含义                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `fullCoverage`         | 期望规则中已提供全文的比例                                                                    |
| `providedCoverage`     | 期望规则中已提供全文或至少出现在索引的比例；同一 ID 不重复计数                                |
| `fullTextChars`        | 全文规则的 title + content + rationale 长度，与生产预算相同                                   |
| `providedChars`        | 适配器返回的 `{rulesFull, rulesIndex}` 完整 JSON 长度，包含 ID、scope、关系、索引和 JSON 标点 |
| `truncatedExpectedIds` | 不限制预算时能够提供、限制后完全不可见的期望规则                                              |
| `excludedExpectedIds`  | 即使不限制预算也没有提供的期望规则，区别于预算截断                                            |
| `worstTruncated`       | 被截掉期望规则数量最多的三个用例                                                              |

两种字符数均使用 JavaScript 字符串 `.length`（UTF-16 code units），不是 UTF-8 字节或 token。完整 JSON 不是整个模型请求，生产 Prompt 中还有其他上下文。总体覆盖率用所有用例的命中数除以所有用例的期望数（micro average），不同用例里的同一 ID 分别计数；提供字符数汇总所有用例。

可调整预算、输出文件，或接入下一批上下文编译器：

```sh
node eval/evaluate-recall.mjs --max-chars=60000 --output=work/recall-60k.json
node eval/evaluate-recall.mjs --adapter=./eval/recall/context-adapter.mjs --output=work/recall-context.json
```

第二条命令使用上下文编译器，分别评估 `full` 全文与 `full + index` 的覆盖率；本批生产 Review 仍只接收 `full`。适配器导出 `async function select({ memories, input, maxChars })`，`input` 为 `{ paths, text }`，返回 `{ rulesFull, rulesIndex }`。全文数组至少保留规则的 `id/title/content/rationale`，索引数组至少保留 `id`；应返回实际提供给 Agent 的字段，以便比较载荷。评测对每个用例调用两次：指定预算和 `Number.MAX_SAFE_INTEGER`，后者只用于识别哪些缺失来自预算。适配器必须无副作用、结果确定，且尊重预算参数；旧样例未标级别时按数据库默认的 should 处理；默认适配器保留旧算法，便于对照。

## 提取评测（真实模型，手动运行）

**提取评测需要至少 30 个人工标注的真实合并 PR，目前只有 6 个样例。** 这 6 个都是合成样例，只用于验证评测通路和暴露明显错误，不能据此认定阶段 2 的真实提取质量已验收。

```sh
npm run build
node --env-file=.env eval/evaluate-extraction.mjs --runs=3
# 只重跑一个样例，并保留原报告
node --env-file=.env eval/evaluate-extraction.mjs 05-rule-exception --runs=3 --output=work/extraction-exception.json
```

需要 `.env` 中的 `MODEL_PROVIDER`、`MODEL_NAME`、`MODEL_API_KEY`；可配置 `MODEL_BASE_URL`、`MODEL_API`、`MODEL_THINKING`，沿用现有 M2 评测的模型配置。默认每次运行 180,000 ms 超时、160,000 tokens 预算，可通过 `--timeout-ms=`、`--budget-tokens=` 修改。不启动主服务，不连接数据库、不写 GitHub。

每个用例带 PR 标题、正文、文件路径、patch、改动后的 `content`、带作者和人类标记的讨论、带 ID 的现有规则，以及 `expected`。六种情况分别是：明确人类决定并落实到代码、仅代码写法、仅 AI 意见、未决争议、例外关联、新约定替代旧规则。

脚本在 `work/extraction-workspaces/` 创建临时 Git 快照，只放改动后的文件，提交得到可复现的 `mergedSnapshot` SHA。每个用例顺序运行 N 次，均使用生产 `SYSTEM_PROMPT`、`runAgentSession` 和 `parseDecisionProposals`，证据校验使用实际人类评论 ID、改动路径和现有规则 ID。临时工作区结束后删除，模型的工具、隔离配置、预算与进程回收仍由现有 Pi 入口处理。

为了直接测量模型与解析器，即使无人类讨论，评测也会调用模型。生产处理器会在无非空人类讨论时提前结束，因此这里没有覆盖那个提前结束分支、GitHub 取数、规则检索、候选入库和维护者批准。现有规则由样例直接提供，便于单独判断提取质量。

`expected` 中每条标注包含：

- `type`：精确匹配候选类型。
- `keywords`：二维数组，每组是一个关键要点的可选同义表达；每组至少一个词出现在候选标题、正文或理由中。使用 NFKC 规范化和大小写无关的子串匹配。
- 可选 `relation`：精确匹配 `exceptionTo`、`supersedes` 目标 ID 和 `conflictsWith` 集合；没有标注关系时，凭空添加关系也不算命中。

评分在生产解析后进行，用一对一最大匹配避免重复候选重复得分。命中为 TP，多出的候选为 FP，缺失标注为 FN；精确率 = TP/(TP+FP)，召回率 = TP/(TP+FN)。总体用全部运行的 TP/FP/FN 汇总计算。分母为零记 `null`，空样例另用 `exact` 判断是否正确无输出。生产解析丢弃的候选单列 `discarded` 并保留理由，不把它们计入已交付候选的精确率；这意味着分数衡量的是 Prompt + 解析后的结果，不能代表模型原始输出的正确率。关键词匹配不能理解否定、范围错误或完整语义，真实 PR 标注还需要人工复核候选。

每次运行后更新 `work/extraction-evaluation.json`，包含快照 SHA、生产代码 SHA 与是否有未提交更改、样例摘要哈希、Prompt 哈希、模型名、耗时、候选、最终回答、丢弃项、评分和 token 用量。输入、新输出、缓存读取、缓存写入、未知消耗分别记录；没有 usage 的失败单列 `usageMissingRuns`，不会冒充零消耗。失败不会被负样例计为成功，错误次数单列并令脚本退出码为 1；运行错误不构造候选 FP，正样例的缺失仍计 FN，因此有运行错误时必须结合错误数解释精确率。

输出都在被忽略的 `work/`，不保存隐藏推理或模型凭据，不提交运行数据。相同用例至少跑三次；不要用一次输出判断模型质量，也不要为通过评测把答案写回 Prompt。
