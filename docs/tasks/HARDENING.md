# Review 可靠性收口（HARDENING）

状态：9 项已实现；之后按用户决定又做了 2 处调整并跑了真实模型回归（见[后续调整](#后续调整2026-11-09)），本地全量测试通过；真实模型回归没有发现由改动引起的变化，但模型服务当晚不稳定，结论有限｜2026-11-09。改动在 worktree 工作区，未提交。

基线：`origin/main` `a919117`。分支 `feat/review-hardening`，工作目录是独立 worktree `/Users/dade/Documents/Github-PR-ReviewAgent/work/review-hardening`。

2026-11-09 的架构评审指出下面 9 处问题，用户确认全部完善。Review 的 bash 不做限制是用户有意的选择，不在本清单内，见 [NOTES](../../NOTES.md)。

下文的 `文件:行号` 以基线为准，改动后会移动，按符号名定位。

## 工作约束

1. **只在 worktree 里工作。** 主目录 `/Users/dade/Documents/Github-PR-ReviewAgent` 里正运行着连接真实队列的本地服务，它直接使用主目录的 `dist/`。不要在主目录构建、测试或改文件，不要停止、重启或启动任何服务进程，不要运行 `src/main.ts` 或 `npm start` / `npm run dev`。
2. **不提交、不推送、不建 PR。** 改动留在 worktree 的工作区里，由用户决定何时提交。
3. **不做真实外部操作。** 不调用真实模型，不运行 `eval/`，不对 GitHub 做任何写操作。模型和 GitHub 一律用测试替身。
4. **凭据。** 不打印、不复制主目录的 `.env`。数据库测试只取 `DATABASE_URL` 一个变量，且不回显：

   ```sh
   cd /Users/dade/Documents/Github-PR-ReviewAgent/work/review-hardening
   DATABASE_URL="$(node --env-file=/Users/dade/Documents/Github-PR-ReviewAgent/.env -p 'process.env.DATABASE_URL')" npm run test:db
   ```

   数据库用例使用独立临时 schema。全部被 skip 不能记作通过。
5. **准备。** worktree 是新目录，先执行 `npm ci` 和 `mkdir -p work`。这里没有 `.codegraph/`，用 `rg` 查代码，不要建索引。
6. **测试节奏。** 写代码过程中只跑和改动相关的单个测试文件（`npm run build && node --test dist/test/<目录>/<文件>.test.js`）。9 项全部做完之后，再依次跑一次全量：`npm test`、`npm run test:db`、`npm run check:docs`、`npm run check:format`。`npm test` 和 `npm run test:db` 都会写 `dist/`，不能并发。
7. **Semgrep。** 个别用例需要 Semgrep。本机已有安装在主目录的 `work/semgrep-venv/` 下，找到可执行文件后用 `SEMGREP_PATH=<绝对路径>` 传入；不要安装新工具。
8. **范围。** 每项只做写明的内容，按现有代码的风格和注释密度写。改导出函数的签名前先用 `rg` 找全调用方并逐个处理。过程中发现的其他问题不要顺手改，记到本文末尾“发现的其他问题”。`npm run lint` 的存量报错不处理。
9. **提示词。** `REVIEW_PROMPT`、`agent/AGENTS.md` 和 Skills 的现有文字不改。第 5 项新增的修复消息只写通用说明，不能出现评测样本的内容。
10. **文档。** 项目文档用中文。每项列出的文档要同步改；Decision 文档保持 Context、Decision、Why、Constraints 四节，写短。改完格式用 `npm run format`。
11. **证据。** 做完后填写本文“验证”一节：日期、实际命令、通过或失败的数量、耗时。没运行的检查写“未运行”和原因。把本文开头的状态改成实际情况。

## 任务

建议按编号顺序做；3 依赖 4 的预留函数，可以一起改。

### 1. 总评页脚不再声称“未运行测试”

- **现状：** `src/review/presentation.ts:175` 固定输出“仅静态审查，未运行测试”，`frontend/features/reviews/review-detail.tsx:149` 输出“未运行测试，仅进行静态代码审查。”。但 Review 允许用 bash 运行检查或测试，这句话可能是假的。
- **要做：** 两处分别改成“自动审查，不代替 CI 测试”和“自动审查，不代替 CI 测试。”，其余拼接逻辑（“查看详情”链接、`lead`）不变。
- **验收：** 更新 `test/review/presentation.test.ts` 里对旧文案的两处断言。

### 2. 超时不再整体重试

- **现状：** `src/jobs/runner.ts:149` 的 `transient()` 对 `TimeoutError` 返回 true。超时多半是 PR 太大，重跑结果一样，只会把预算耗尽。
- **要做：** `TimeoutError` 返回 false，任务以 `timeout` 结束。`ProviderError` 里模型服务自己报的超时（`RETRYABLE_PROVIDER`）不变，仍可重试。末尾的正则兜底不动。
- **验收：** 更新 `test/jobs/retry.test.ts`；确认超时后任务状态是 `timeout` 而不是 `queued`。
- **文档：** `docs/reliability-security.md` 里关于重试分类的描述如提到超时可重试，同步修改。

### 3. 模型代理对瞬时错误做有限次重试

- **现状：** Pi 的重试被关掉（`src/pi/session.ts:413`），本地代理只发一次（`src/pi/model-proxy.ts:45`）。会话中途一次 429 或 5xx 就让整个会话失败，由队列从头重跑，已花的 token 全部浪费。
- **要做：** 在 `startModelProxy` 里对 POST 请求重试，规则如下。
  - 触发条件：`fetch` 抛出网络错误（不是被取消），或上游状态码是 429、500、502、503、504、529。
  - 只在还没有向 Pi 写出任何响应内容时重试；一旦开始转发响应就不再重试。重试前要取消上一次的上游响应体。
  - 最多重试 2 次，等待 1 秒、3 秒。上游带 `retry-after` 且不超过 10 秒时按它等；超过 10 秒则不重试，把原响应照常返回。
  - 等待期间会话被取消或超时（现有的 `controller` 被 abort）要立刻结束。
  - 重试用尽后，把最后一次的上游响应或网络错误按现在的方式返回给 Pi。
  - **预算记账：** 每次重试前，把上一次尝试的预留额计入 `unreportedTokens`（失败且没有 usage 的请求不能当成零消耗，这是 AGENTS.md 的既有规则），再按剩余预算对同一个请求体重新预留并持久化，输出上限按新的预留重新收紧。预算不够重新预留时不重试，把上游的原错误返回给 Pi。具体的 hook 形式自定，保持 `ProxyHooks` 简单。（记账口径后来调整为“上游明确回了错误响应的尝试不计消耗”，见[后续调整](#后续调整2026-11-09)第 2 条。）
  - 等待时长要能在测试里缩短（例如作为可选参数），不要让测试真的等 4 秒。
- **验收：** 新增用例（替身上游）：
  - 503 一次后 200：Pi 收到 200，上游收到 2 次请求，`unreportedTokens` 包含第一次的预留额；
  - 连续 3 次 429：Pi 收到 429，上游共收到 3 次请求；
  - 剩余预算不够重新预留：上游只收到 1 次请求；
  - `retry-after` 超过 10 秒：不重试；
  - 已开始转发响应后上游中断：不重试；
  - 等待期间取消：立刻结束，不再发请求。
  - 改完跑 `test/pi/session.test.ts` 及现有代理相关用例。
- **文档：** `docs/reliability-security.md` 的预算与重试部分、`.agents/decisions/pi-runtime.md`（说明 Pi 自身重试仍关闭，由服务代理做有限次重试并照常记账）。

### 4. 输入预留按实际用量校准

- **现状：** `src/pi/types.ts:42` 的 `requestTokenBudget` 用请求体的 UTF-8 字节数当输入 token 上限，比真实值高出几倍。会话后期请求体变大，预算还剩很多就被拒绝；失败请求记入的 `unreportedTokens` 也按字节数算。
- **要做：** 会话内自校准，不引入 tokenizer。
  - 每收到一次带 usage 的回复，记下这次请求的“每字节 token 数”= (`input` + `cacheRead` + `cacheWrite`) ÷ 这次请求体的字节数。字节数的算法与 `requestTokenBudget` 一致（图片数据已替换）。usage 里输入为 0 或缺失时不更新。
  - 下一次预留的输入估算 = `min(字节数, ceil(字节数 × 比例 × 1.25))` + 1024 + 图片预留。也就是永远不会比现在的预留更大。
  - 会话里还没有观测值时（第一次请求）沿用现在的字节数算法。
  - `requestTokenBudget` 保持纯函数，比例作为可选参数传入；观测值存在 `runPiSession` 的局部状态里。它从 `src/review/agent.ts` 再导出过，改签名前查全调用方。
  - 把 `ponytail:` 那行注释换成对新算法的一句说明。
- **代价（写进文档）：** 估算可能偏低，总用量可能超出预算，超出量不超过一次请求的估算误差；超出后会话照旧以 `BudgetError` 结束（`src/pi/session.ts:283`）。
- **验收：** `requestTokenBudget` 的单元用例（无比例时结果与现在相同；有比例时变小；比例异常大时不超过字节数算法）；会话级用例：替身模型第一次回复带 usage 后，第二次请求的预留额小于其字节数。现有“预算不足时不发送请求”“失败时未知消耗保留”的用例仍通过。
- **文档：** `docs/reliability-security.md` 预算部分。

### 5. Review 输出不合格时先修一次，再丢弃个别无效意见

- **现状：** `parseReviewResult`（`src/review/agent.ts:42`）和 `groupFindings`、`validateDisplay` 任何一处不合格都抛普通错误；`src/review/review.processor.ts:137` 遇到路径不属于 PR、`:140` 的 `validateMemoryReferences` 遇到无效规则引用也抛错。这些错误不重试，整次 Review 作废。
- **要做：**
  - **修复轮。** `runAgentReview` 给 `runAgentSession` 传 `followUp`（`src/pi/session.ts:96`、`:297` 已支持）。对模型的回答做三项检查：`parseReviewResult(text, true)` 能通过；所有位置（主位置、关联位置、候选）的 path 都在 `changedFiles` 里；所有规则引用的 `id:version` 都在 `input.memories` 里。任一项不通过且本会话还没修过，就返回一条修复消息：说明上一条输出没有通过服务校验、附上校验错误原文（过一遍 `redactSecrets`）、要求只修正这个问题并重新输出完整的 JSON 对象。每个会话最多修 1 次，共用原有的预算、超时和取消。
  - **仍不合格时。** 结构性错误（JSON 无效、分组不完整、短评超长等）照旧抛错。个别意见的错误改为丢弃：在 `review.processor.ts` 里，先对**模型产生的** finding 过滤，凡是有位置不属于 PR、或规则引用不在本次提供的规则里的，整条（合并后的一组）丢弃，然后再合入服务自己产生的 finding（规则扫描、凭据、依赖）。有丢弃时往 `limitations` 加一条“模型有 N 条意见指向不属于本 PR 的文件或未提供的团队规则，已丢弃”，并用 `log()` 记下任务 ID、数量和原因。原有的两处抛错保留作兜底，正常情况下不应再被触发。
  - 检查逻辑在 `agent.ts` 和 `review.processor.ts` 之间共用一份；注意 `review.processor.ts` 已经引用 `agent.ts`，不要反向引用。
- **验收：**
  - 替身模型第一次输出无效 JSON、第二次有效：得到解析结果，模型共收到 2 次提问；
  - 第一次输出里有路径不在 PR 内的意见、第二次改正：正常通过；
  - 两次都是无效 JSON：照旧抛错，错误上带 usage；
  - 第一次有效：不追加提问；
  - 处理器层：模型返回 2 条意见、其中 1 条路径不属于 PR：发布剩下 1 条，`limitations` 含丢弃说明；全部被丢弃时按“没有发现问题”发布且限制说明在总评里可见（沿用 `limitations` 现有的展示方式）。
- **文档：** `docs/architecture.md` 中描述输出校验的部分。

### 6. Review 带上所有命中范围的团队规则

- **现状：** `src/review/review.processor.ts:70` 调 `memories.retrieve`，走 `rankMemories`（`src/memory/memory.service.ts:204`）：按词重叠计数排序、全局规则至少 2 分、只取前 10 条。中文规则和英文代码几乎没有词重叠，分数并列时按 ID 排序，命中范围的规则超过 10 条时带哪些接近随机。开发任务用的是确定性的做法（`src/development/rules.ts`）。
- **要做：** 只改 Review 的选取；Reply（`src/reply/reply.processor.ts:189`）和健康检查（`src/health/health.processor.ts:154`）继续用现有的 `retrieve`，行为不变。
  - 候选仍是该仓库 `ACTIVE` 的最新版本规则，仍用 `scopeMatches(memory, 改动文件路径, [])` 过滤。
  - 通过过滤的规则全部带上：限定了路径、语言或模块的规则不再截断，没有限定范围的全局规则不再要求最低分。
  - 被选中的规则有 `exceptionTo`、而原规则是 ACTIVE 但没被选中时，把原规则一并带上。
  - 上限：选中规则的 `title + content + rationale` 总字符数不超过 30 000。超过时按“限定范围的在前、全局的在后，各自按现有词重叠分数从高到低、同分按 ID”的顺序保留到上限为止，并在 Review 的 `limitations` 里加一条“团队规则超过上限，本次只带了 N/M 条”。
  - 发给模型的每条规则只保留 `id`、`version`、`type`、`title`、`content`、`rationale`、`scope`、`source`、`exceptionTo`、`supersedes`；其余字段（证据、置信度、审批人、时间等）不发。服务内部传给 `validateMemoryReferences` 的仍是完整记录。
  - 实现位置建议：在 `memory.service.ts` 的 `rankMemories` 旁边加一个纯函数和对应的 `MemoryService` 方法，复用 `scopeMatches`、`hasSpecificScope`、`matchWords`；不要把开发任务的 `createRuleBook` 整个搬过来（Review 事先就知道改动文件，不需要“读到文件再附规则”）。
- **代价（写进文档）：** 每次 Review 的首条提示变长；预算把缓存读取按全额计入，规则多的仓库每轮请求都会多算这部分。
- **验收：** 新增用例：15 条范围命中的规则全部返回；与改动文本零重叠的中文规则也返回；范围不命中的不返回；例外带出原规则；超过字符上限时按顺序截断并返回“带了几条 / 共几条”；发给模型的规则对象不含 `evidence` 等字段。`rankMemories` 的现有用例不变。
- **未运行项：** 这项改变了模型输入，按项目规定应跑 `eval/` 回归，但那需要真实模型，本任务不运行。在“验证”里写明未运行，并保留命令供用户手动执行。
- **文档：** `docs/project-guide.md:84-86`（现写“默认取前 10 条”）、`docs/memory-design.md` 的检索部分、`.agents/decisions/team-memory.md`（Review 改为范围命中即全带，文本排序只在超上限时使用）。

### 7. 任务串行范围从“同仓库”缩小到“同一个 PR”

- **现状：** `src/persistence/repositories/job.repository.ts:318-319` 的领取条件让同一仓库的 Review、Reply、规则抽取一次只跑一个。注释和 Decision 给的理由是“规则抽取会改变后续召回的团队规则”，但规则抽取只写入 `CANDIDATE`，不影响召回；Reply 的顺序只需要在同一个 PR 内保证。结果是同仓库不相关的 PR 互相排队，目标仓库只有一个时 `WORKER_CONCURRENCY` 形同为 1。
- **要做：** 把 `NOT EXISTS` 子查询的条件改成同仓库且同 `pr_number`。排序、`FOR UPDATE SKIP LOCKED`、健康检查的豁免都不变。同步改上方注释。不需要数据库迁移。
- **验收：** 更新 `test/persistence/database-workers.test.ts`：同一 PR 的任务仍然串行；同仓库不同 PR 的任务可以同时被领取；同一 PR 内 Reply 仍按回复时间顺序领取。跑 `test/persistence/database-jobs.test.ts`、`test/reply/database-reply.test.ts` 确认没有回归。
- **文档：** `AGENTS.md:58`、`CLAUDE.md:9`、`README.md:418`、`docs/project-guide.md:37`、`docs/reliability-security.md` §8、`.agents/decisions/repository-architecture.md:26`（把约束改成“同一 PR 的任务串行”，写明理由：Reply 按回复时间处理，同一 PR 的 Review 和 Reply 读写同一批 finding；规则抽取只产生候选，不需要跨 PR 串行）。

### 8. 没有人类讨论的 PR 不跑规则抽取

- **现状：** `src/memory/decision.processor.ts:88` 起，每个合并的 PR 都克隆仓库并跑一次 Agent。但每条候选规则都必须有人类评论作证据，没有人类评论时不可能产出有效候选，这次运行纯属浪费。
- **要做：** 取回 PR 和讨论、并通过现有的 `merged snapshot` 检查之后，如果 `discussions` 里没有任何一条“人类且正文非空”的记录，就用 `log("info", "decision_skipped", …)` 记下任务 ID 和原因后直接返回：不建工作区、不启动 Agent、不写候选。任务按成功结束。
- **验收：** 新增用例：只有 Bot 评论、或只有正文为空的人类 Review（例如不带评语的批准）时，`execute` 和 `insertCandidates` 都没有被调用；有一条非空人类评论时流程照旧。

### 9. 规则抽取的人类证据校验补漏

- **现状：** `parseDecisionProposals`（`src/memory/decision.processor.ts:18`）里 `source.commentIds` 为空数组时 `every` 直接通过（`:56`）；`evidence` 中 `kind=human_comment` 的 `reference` 没有和真实的人类评论 ID 核对。模型可以给出没有任何真实人类评论支撑的候选。
- **要做：**
  - `source.commentIds` 必须是非空的数字数组。
  - 传入了 `humanCommentIds` 时：`commentIds` 全部属于它（已有）；每条 `human_comment` 证据的 `reference` 去掉首尾空白后必须是纯数字，且属于 `humanCommentIds`。
  - 错误沿用现有的抛错方式和措辞风格。`SYSTEM_PROMPT` 不改（它已经要求填评论 id）。
- **验收：** 在 `test/memory/decision.test.ts` 新增：空 `commentIds` 被拒绝；`reference` 不是真实人类评论 ID 被拒绝；`reference` 不是数字被拒绝；合法输入照旧通过。现有用例里如有空 `commentIds` 的样例，改成合法输入。

## 不做的事

- 不限制 bash，不加容器或沙箱（见 [NOTES](../../NOTES.md)）。
- 不改预算把缓存读取按全额计入的口径。
- 不给 Reply、规则抽取、健康检查加修复轮。
- 不做 Workspace 或 codegraph 索引缓存，不改轮询方式，不重构 `Database` 的结构。
- 不改 `REVIEW_PROMPT` 和 Skills 的现有文字。

## 验证

2026-11-09，worktree `/Users/dade/Documents/Github-PR-ReviewAgent/work/review-hardening`，基线 `a919117` 加未提交改动。模型和 GitHub 全部用替身（假模型服务、替身上游、替身 GitHub 客户端），没有真实外部调用。

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm ci`、`mkdir -p work` | 成功 |
| 开发中逐项运行的单文件用例：`node --test dist/test/review/presentation.test.js`、`dist/test/jobs/retry.test.js`、`dist/test/pi/model-proxy.test.js`、`dist/test/pi/session.test.js`、`dist/test/development/policy.test.js`、`dist/test/review/agent.test.js`、`dist/test/review/publication.test.js`、`dist/test/review/heuristics.test.js`、`dist/test/memory/decision.test.js`；数据库：`dist/test/persistence/database-workers.test.js`、`dist/test/persistence/database-jobs.test.js`、`dist/test/reply/database-reply.test.js`（各自先 `npm run build`） | 全部通过 |
| `SEMGREP_PATH=<主目录>/work/semgrep-venv/bin/semgrep npm test` | 通过（exit 0），耗时 32 秒：209 个用例，151 通过，0 失败，58 跳过。跳过的 58 个全部是没有 `DATABASE_URL` 时跳过的数据库用例，已由下一行覆盖；Semgrep 用例实际运行 |
| `DATABASE_URL=…（只从主目录 .env 取这一个变量，未回显） SEMGREP_PATH=… npm run test:db` | 通过（exit 0），耗时 50 秒：59 个用例，59 通过，0 失败，0 跳过 |
| `npm run check:docs` | 通过（exit 0），1 秒内：31 个 Markdown 文件、281 个本地链接与锚点 |
| `npm run check:format` | 通过（exit 0），约 1 秒：172 个文件，无需修改 |
| `node --check eval/evaluate-ux.mjs` | 通过（只检查语法；该脚本改为用 `retrieveForReview`，未运行） |

新增或改写的用例：

- 第 1 项：`test/review/presentation.test.ts` 两处断言改为新文案。
- 第 2 项：`test/jobs/retry.test.ts` 改为 `TimeoutError` 不重试、模型服务自己报的超时仍可重试；新增“超时的任务以 timeout 结束，不回到队列”（替身连接池调用 `failJob`，写入状态为 `timeout`）。
- 第 3 项：新文件 `test/pi/model-proxy.test.ts`（替身上游，等待缩短到毫秒级）：网络错误或 503 后成功、连续 3 次 429、预算不够重新预留只发 1 次、`Retry-After` 超过 10 秒不重试（不超过时按它等）、开始转发后中断不重试、等待期间取消不再发请求（连接断开和关闭代理两种）。`test/pi/session.test.ts` 新增会话级用例：503 一次后 200，上游 2 次请求，`unreportedTokens` 等于第一次的预留；第一次预留就占满预算时上游只收到 1 次请求，未知消耗只计一次。
- 第 4 项：`test/pi/model-proxy.test.ts` 的 `requestTokenBudget` 单元用例（无比例或比例无效时与原算法相同、有比例时变小、比例异常大时等于字节数算法）；`test/pi/session.test.ts` 新增“第二次请求的输入预留小于其字节数”。
- 第 5 项：新文件 `test/review/agent.test.ts`（真实 Pi 进程 + 假模型）：无效 JSON 修一次后通过、路径不属于 PR 修一次后通过、两次都无效照旧抛错且带两轮 usage、第一次有效不追加提问；`test/review/publication.test.ts` 新增处理器用例：2 条意见丢 1 条、全部丢弃按“没有发现问题”发布，`limitations` 含丢弃说明。
- 第 6 项：`test/review/heuristics.test.ts` 新增两条（15 条范围命中全带、零重叠中文规则也带、范围不命中不带、例外带出原规则；超字符上限按顺序截断并返回条数）；`test/review/agent.test.ts` 断言发给模型的规则对象只含规定字段；`test/review/publication.test.ts` 断言截断时 `limitations` 写明“只带了 0/3 条”。`rankMemories` 原用例未改。
- 第 7 项：`test/persistence/database-workers.test.ts` 改写第一条（同一 PR 的规则抽取要等，同仓库另一个 PR 可同时领取），新增“同一个 PR 内的 Reply 仍按回复时间一个一个领取”。
- 第 8、9 项：`test/memory/decision.test.ts` 新增两条；原“走统一会话入口”用例补了一条人类评论，作为“有人类讨论时流程照旧”的覆盖。

为适配新行为改动的原有用例：

- `test/pi/session.test.ts`“请求前先持久化预留…”的预算从 20 000 改为 12 000：校准后第二次请求的输入预留很小，原预算下输出上限不再被收紧到 16 384 以下。
- 同文件“工具结果把上下文撑大后…”改为让假模型按请求字节数的一半回报输入 token：原替身对约 6 KB 的请求只回报 100 token，校准后不再触发拦截。
- 同文件“模型服务错误按是否可重试分类”改为连续 3 次 429 并带 `retry-after: 0`（代理会先重试），为此 `test/helpers/fake-model.ts` 的错误响应支持附加响应头。

与清单不一致或需要说明的处理：

- 第 3 项：预算不够重新预留时，代理把上游原错误交给 Pi，但不调用 `rejected`，会话以 `ProviderError` 结束、由队列按错误类型决定是否整体重试，而不是变成 `BudgetError`。重试顺序是“等待 → 重新预留 → 取消上一次响应体 → 重发”：等待期间被取消时不会留下没发出的预留；预留失败时上一次的响应还在，可以原样返回。
- 第 4 项：验收里“第二次请求的预留额小于其字节数”按输入部分理解（总预留还包含最多 16 384 的输出上限），用例用“预留额 − 请求里的输出上限”计算。
- 第 5 项：清单写“限制说明在总评里可见（沿用 limitations 现有的展示方式）”，但现有代码的 GitHub 总评从不展示 limitations（见“发现的其他问题”第 1 条）。按代码沿用现有方式：丢弃说明写进 limitations，随审查结果保存、在管理页显示；GitHub 总评只显示“✅ 没发现需要改的问题”。没有给总评新增展示。
- 第 6 项：`eval/evaluate-ux.mjs` 原来直接调 `memories.retrieve` 模拟 Review 的规则召回，已改为 `retrieveForReview`，否则手动回归测不到这次改动。只做了语法检查。
- 第 7 项：除清单列出的文档外，同步改了写着旧规则的 `.env.example` 注释和 `src/config/config.ts`、`src/github/client.ts`、`src/jobs/runner.ts`、`CLAIM_LOCK` 处的注释。
- 第 8 项：跳过判断放在读取仓库配置之前，没有人类讨论时连仓库配置也不读。
- 清单里的 `文件:行号` 与基线代码核对一致。

未运行：

- `eval/` 真实模型回归：当时未运行，之后已运行，见[后续调整](#后续调整2026-11-09)第 3 条。
- `npm audit --audit-level=high`：本次没有改依赖，未运行。
- 管理页文案（第 1 项）没有在浏览器里查看，只改了一句文字，没有改布局。

## 后续调整（2026-11-09）

9 项完成后留下 4 个待定问题，用户决定按推荐做法处理。

### 1. 丢弃了模型意见时，GitHub 总评写明

原来丢弃说明只进 `limitations`，只在管理页能看到；全部丢弃时总评还写着“✅ 没发现需要改的问题”。现在：

- 处理器把丢弃条数记到审查结果的 `droppedFindings`（`src/review/types.ts`、`src/review/review.processor.ts`）。
- `reviewBody`（`src/review/presentation.ts`）在总评里加一行“模型另有 N 条意见指向本 PR 之外的文件或不存在的团队规则，没有采用”。没有其他意见时，这一行取代“✅ 没发现需要改的问题”，写成“⚠ …没有采用；其余部分没发现需要改的问题”。
- 用例：`test/review/presentation.test.ts`（全部丢弃时的文案）、`test/review/publication.test.ts`（丢 1 条留 1 条、全部丢弃两种情况下实际发出的总评）。

### 2. 代理重试的记账：上游明确拒绝的尝试不计消耗

原实现在每次重试前都把上一次的预留额计入 `unreportedTokens`。一次 429 或 503 就会白白占掉几万 token 的预算，而这类响应说明请求没有被处理。现在：

- 上一次尝试收到了上游的错误响应（429、5xx）：不计消耗，直接按剩余预算重新预留。
- 上一次尝试没收到响应（网络错误）：上游是否处理未知，预留额照旧计入 `unreportedTokens`。
- 重试用尽后交给 Pi 的最后一次失败、会话超时或被取消时还在等的请求：照旧保留为未知消耗。

依据是 tuziapi 现在的退款口径（`tuziapi/tuzi-api` dev 分支 `controller/relay.go:2910-2942`）：上游返回错误响应且没有输出内容时退回预扣，请求发出后超时则保留预扣。AGENTS.md 的“请求失败且没有 usage 回报时保留预留额度”仍然成立，只是把“上游明确回了错误、请求没被处理”从“未知”里分出来。

改动：`ProxyHooks.retry(body, answered)`（`src/pi/model-proxy.ts`）、`runPiSession` 里的 `reserve`（`src/pi/session.ts`）、`docs/reliability-security.md`、`.agents/decisions/pi-runtime.md`。用例：`test/pi/model-proxy.test.ts` 断言两种情况传给 `retry` 的标记；`test/pi/session.test.ts`“模型服务临时失败时代理重试同一请求：收到错误响应的尝试不计消耗，没收到响应的计入未知消耗”。

代价：代理不记录重试次数，上游回 429／5xx 后重试成功的请求在 usage 里不留痕迹，只表现为这次请求变慢。

### 3. 真实模型回归

**做法。** 改前用基线 `a919117` 的独立 worktree（`work/eval-baseline`），改后用本 worktree，各自 `npm run build` 后运行。模型：`MODEL_PROVIDER=tuzi`、`MODEL_NAME=gpt-6.1-sol`、`MODEL_API=openai-completions`、`MODEL_THINKING=high`，角色都是单 Agent Review（`general_review`）。样本固定在 `M2tHane/pi-review-test-repository` 的 `3e02a7c…→ad75aa1…`（M2 的 6 个样本）和 `evaluate-ux.mjs` 里写死的两组 SHA。只调用模型，没有 Webhook，没有 GitHub 发布；`evaluate-ux.mjs` 只从本机数据库读取规则。每次会话预算 160 000 token、超时 300 秒（脚本原有设置）。

```sh
node --env-file=<主目录>/.env eval/evaluate-m2.mjs work/m2-eval-snapshot --runs=3
node --env-file=<主目录>/.env eval/evaluate-ux.mjs        # 连跑 3 轮
node --env-file=<主目录>/.env eval/evaluate-m2.mjs work/m2-eval-snapshot <case> --runs=3   # 补跑
```

第一轮改前、改后同时跑；当晚模型服务很慢且不稳定，超时和上游失败很多，所以把失败的样本一个一个补跑，最后又用一个带会话记录的脚本补了几次（输入与 `evaluate-m2.mjs` 相同，多存一份 Pi 会话，用来看修复轮有没有触发、每次模型请求花了多久）。日志、结果 JSON 和脚本都在主目录 `work/eval-logs/`（不入库）。

**M2 样本结果**（成功次数／运行次数；括号里是成功各次的意见条数）：

| 样本 | 改前 | 改后 | 说明 |
| --- | --- | --- | --- |
| complex | 0/8（全部超时） | 3/5（5、5、5） | 改后成功的 3 次都在第一轮开头，用时 114–136 秒、约 6.7–7.0 万 token；之后两边交替跑的 3 次全部超时 |
| java | 3/3（4、5、5） | 6/9（4、4、4、5、5、5） | 改后失败的 3 次是第一轮的超时；成功各次 87–135 秒、4.8–8.5 万 token，改前 107–116 秒、7.1–7.6 万 |
| security | 3/3（2、2、2） | 8/9（1、1、1、2、2、2、2、2） | 改后失败的 1 次是第一轮的超时；少的那一条是“报表标签可被当成公式” |
| architecture | 1/6（2） | 2/6（5、3） | 改前失败：上游失败 3 次、超时 1 次、意见指向不在所选文件里的 `TransferController.java` 1 次；改后失败的 4 次都是超时 |
| memory | 3/3（1、1、1） | 3/3（1、1、1） | 每次都引用了提供的规则 v1；32–48 秒、约 4.0–4.6 万 token，两边一样 |
| small | 3/3（0、0、0） | 3/3（0、0、0） | 17–27 秒、约 1.7–2.6 万 token，两边一样 |

**UX 样本结果**（各 3 轮）：

| 样本 | 改前 | 改后 | 说明 |
| --- | --- | --- | --- |
| orders-single | 0/3 | 0/3 | 两边每次都只报 1 个问题（`OrderExport.java:8`，导出原地排序改乱查询顺序），都没有把 `OrderCatalog.java` 列为关联位置，候选只有 1 条，所以断言不过。改前改后的输出是同一个形态 |
| rule-reference | 0/3 | 0/3 | 本机数据库里没有这个仓库的任何规则（脚本要求的规则 `567f00c2-…` v2 不存在），召回为空，这条在本机不可能通过 |

**结论。**

- 没有发现由改动引起的变化。memory、small 两边一致；UX 两个样本改前就不过，改后的输出形态相同。
- 超时不能归因于改动。最后交替跑的 4 次 complex（改前 2、改后 2）都有会话记录：两边的模型请求一样慢，除第一次外单次 27–96 秒、只输出约 500–2 300 token（每秒 18–25 token），300 秒内跑不完；而第一轮开头改后的 complex 整次只用了约 2 分钟。超时时两边都有一笔还在等的请求，按规则留在 `unreportedTokens` 里（改前约 5.7–8.4 万，改后约 2.9–3.9 万；改后小是因为第 4 项把输入预留估小了）。
- 改后 java、security 有几次少报一条意见。带会话记录的 6 次（java 3、security 3）修复轮一次都没有触发，结果与改前一致（java 5 条、security 2 条）；少报的那几次，输出 token 总量不比正常的多，可以推断也没有走修复轮。没有修复轮时发给模型的内容与改前完全相同，所以归为模型自身的波动。样本数少，不能排除别的原因。
- 第 5 项的修复轮在真实模型上没有被观察到触发。改前有一次“意见指向所选文件之外”导致整次失败，改后同一样本没有出现这类失败，但次数太少，不能当成修复轮有效的证据。

**限制。**

- 第 6 项（Review 带上所有命中范围的规则）没有被真实模型回归覆盖：memory 样本是脚本直接把合成规则交给 Agent，不经过规则选取；经过规则选取的 rule-reference 因为本机没有规则数据跑不到。这一项只有替身测试的覆盖。
- 第 3 项的代理重试是否触发看不出来（见上一条的代价）。只有第一轮改后的 security 第 3 次留下了痕迹：成功结束，同时有 70 835 的未知消耗，说明中途有请求没收到响应、重试后成功。
- 模型服务当晚的速度波动很大，同一个样本前后几分钟结果就不同；complex、architecture 的成功次数差异不能用来比较改前改后。

### 4. 同一个 PR 内的任务并行

维持第 7 项的现状（同一个 PR 的任务串行，不同 PR 可以同时跑），没有改动。

### 5. 审查时限改为 1 小时（合并后追加）

用户要求。依据是上面第 3 条的回归：7 个文件的 complex 样本在模型慢的时候 13 次里超时 10 次，第 2 项又让超时不再重试。

- `AGENT_TIMEOUT_MS` 默认值从 300 000 改为 3 600 000（`src/config/config.ts`），`.env.example` 同步并写明用途；本机被忽略的 `.env` 也改成 3600000（服务重启后生效）。
- 这个变量同时是 Review、Reply 复核和规则抽取的单次时限；健康检查仍取它和 120 秒的较小值，开发任务用 `DEVELOPMENT_TIMEOUT_MS`，都不受影响。
- 代价：卡住的会话最长占一个 Worker 槽位 1 小时，同一个 PR 的后续任务（新提交的 Review、回复复核）也要等它结束或被新提交取消；token 仍受预算限制。
- 两个 eval 脚本的时限同步改为 1 小时，回归结果和线上时限一致。

### 调整后的验证

2026-11-09，真实模型回归结束后在本 worktree 顺序运行，模型和 GitHub 全部用替身：

| 实际命令 | 结果 |
| --- | --- |
| `SEMGREP_PATH=<主目录>/work/semgrep-venv/bin/semgrep npm test` | 通过，33 秒：209 个用例，151 通过，0 失败，58 跳过（都是没有 `DATABASE_URL` 时跳过的数据库用例，由下一行覆盖） |
| `DATABASE_URL=…（只从主目录 .env 取这一个变量，未回显） SEMGREP_PATH=… npm run test:db` | 通过，56 秒：59 个用例，59 通过，0 失败，0 跳过 |
| `npm run check:docs` | 通过：31 个 Markdown 文件、284 个本地链接与锚点 |
| `npm run format`、`npm run check:format` | 172 个文件，格式化后无需修改 |
| `git diff --check` | 无输出 |

未运行：`npm audit --audit-level=high`（没有改依赖）；没有真实 Webhook 或 GitHub 发布验收，总评新增的那一行只在替身 GitHub 的发布用例里核对过。

## 发现的其他问题

以下均未改动，只记录：

1. **GitHub 总评不展示 `limitations`。** `reviewBody`（`src/review/presentation.ts`）和发布流程都不输出 limitations，它只保存在审查结果里，在管理页“审查范围与限制”中显示。`src/review/secret-check.ts` 的注释却写着“没扫到的文件写进 limitations，PR 上会说明”。第 5 项“限制说明在总评里可见”因此只能沿用管理页的展示方式。（后续调整第 1 条给“丢弃了几条意见”单独加了一行总评说明；其他 limitations 仍只在管理页显示。）
2. **`docs/project-guide.md` 的重试说明过期。** 表格写“最多尝试 3 次（含首次）”，代码 `MAX_ATTEMPTS = 5`（`job.repository.ts`）；下方“SDK 自动重试与业务 Job 重试是两层机制”没有提到第 3 项新增的代理重试。该文件不在第 3 项要同步的文档里。
3. **`parseDecisionProposals` 不校验 evidence 字段类型。** 代码证据检查直接调用 `e.reference.split(":")`，模型给出非字符串的 reference 时抛出的是 `TypeError`，而不是统一的“结构或归属无效”错误。结果同样是拒绝，只是错误信息不清楚。
