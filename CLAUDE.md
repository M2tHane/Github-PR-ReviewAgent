# CLAUDE.md

协作规则、产品边界和安全约束以 AGENTS.md 为准，这里只补充上手和改代码时容易踩的点。

@AGENTS.md

## 项目一句话

GitHub App + Pi agent 的 PR Review 服务：Webhook 进 PostgreSQL 任务表 → Worker 按租约领取（可多实例，同一 PR 的任务串行）→ 固定 SHA 的临时 Workspace 里启动 Pi 进程跑模型 → 校验后发布 `COMMENT` Review；合并后抽取团队规则候选，维护者确认后进入后续 Review 的召回。群内开发任务也用 Pi 进程改代码，由服务收集改动后提 PR。

## 命令

```sh
npm ci
mkdir -p work            # 新 clone 必须先建；否则 docs-links 测试 mkdtemp 失败
npm run build            # tsc + esbuild 打包 frontend/ 到 dist/admin
npm test                 # 含 build；无 DATABASE_URL 时数据库用例 skip（skip ≠ 通过）
npm run db:up            # docker compose 起 postgres，端口 54329，见 .env.example
npm run test:db          # 需要 .env 里的 DATABASE_URL
npm run check:docs
npm run format           # Biome 格式化；check:format 只检查
```

- 测试跑的是 `dist/test/**`，改完 TS 必须重新 build，不能只跑 `node --test test/...`。
- `npm test` 与 `npm run test:db` 都会写 `dist/`，不要并发跑。
- 单个测试文件：`npm run build && node --test dist/test/pi/session.test.js`。
- 删除源码或测试文件后，`dist/` 里的旧产物不会自动清掉，`npm test` 仍会跑到；需要手动删除对应的 `dist/` 文件。

## 代码地图

| 环节 | 位置 |
| --- | --- |
| Webhook 验签、路由 | `src/github/webhook/`（`handler.ts` 入口） |
| 入队、去重、取消 | `src/persistence/repositories/job.repository.ts` |
| Worker 领取与重试 | `src/jobs/runner.ts`（并发槽位、心跳续租；`transient()` 决定是否重排） |
| PR Review 主流程 | `src/review/review.processor.ts` |
| Review Agent / Prompt / 结果解析 | `src/review/agent.ts`（`runAgentReview`、`REVIEW_PROMPT`、`parseReviewResult`） |
| Pi 进程 / 预算 / 取消 | `src/pi/session.ts`（`runPiSession`、`ensureCodegraph`）、`src/pi/model-proxy.ts`（预留与输出上限） |
| Agent 执行过程记录 | `src/pi/session-record.ts`（整理 Pi 会话、生成时间线）、`agent-session.repository.ts`、`src/admin/agent-sessions.routes.ts`、`frontend/components/common/session-timeline.tsx` |
| Pi 服务扩展（路径、打码、写入检查、附规则） | `src/pi/extension.ts`（Pi 进程里运行，经 UI input 与服务通信） |
| 服务 AGENTS.md 与 Skills | `agent/`（随服务发布，不来自待审仓库） |
| 开发任务 | `src/development/processor.ts`、`changes.ts`（从工作区收集改动）、`rules.ts`（按路径附团队规则） |
| 分组、短评、发布正文 | `src/review/presentation.ts` |
| 发布与幂等台账 | `src/review/review.publisher.ts` + `review-publication.repository.ts` |
| Reply 复核 | `src/reply/reply.processor.ts` |
| 规则抽取 / 召回 | `src/memory/decision.processor.ts`、`src/memory/memory.service.ts`（`retrieve`、`scopeMatches`） |
| 健康检查 | `src/health/` |
| 管理 API / 页面 | `src/admin/handler.ts`、`frontend/` |
| 服务组装 | `src/bootstrap/application.ts`（含数据清理定时器） |
| 数据清理 | `src/persistence/repositories/retention.repository.ts` |
| 模型输出解析 | `src/shared/model-json.ts`（各信任边界共用） |
| 日志 | `src/logging.ts`（`log()`，错误自动带调用栈和 cause） |

`src/jobs/queue.ts` 的内存 `JobQueue` 只在 `webhook/handler.ts` 传入函数型 target 时使用（主要是测试），生产路径走 PostgreSQL。

## 改代码时注意

- **Prompt 里不能写评测样本的答案。** `REVIEW_PROMPT`、`agent/` 下的 AGENTS.md 和 Skills 每次审查都会发出去；只写通用规则。改完用 `eval/` 回归。
- **新 Agent 调用一律走 `runAgentSession`（即 `runPiSession`）。** 它负责临时 Pi 配置目录、关闭资源发现、模型代理预算、关闭 Pi 重试与压缩、超时、取消和结束进程组。自己启动 `pi` 或调 SDK 的 `createAgentSession` 会读取待审仓库的 `.pi` 和宿主机 `~/.pi`。
- **Pi 版本绑定。** RPC 事件、扩展钩子和 CLI 参数随 Pi 版本变化，升级 Pi 或 codegraph 后跑 `test/pi/session.test.ts`。Pi 的 grep / find 离线运行，需要系统里有 `rg`、`fd`（或 `fdfind`）。
- **改 Prompt 或 Skill 都要回归。** `agent/AGENTS.md` 和 Skills 与 `REVIEW_PROMPT` 一样每次都会发出，不能写评测样本的答案。
- **模型输出的校验。** `parseReviewResult`、`parseDecisionProposals`、`validateDisplay` 是信任边界。改字段时同步改 Prompt 里的 JSON 说明、`src/review/types.ts` 和对应测试。
- **发布状态。** PR Review 总评末尾带 `<!-- pi-review:<fingerprint> -->` 标记；发布失败或上次中断时按这个标记查 GitHub 已有 Review 再决定（见 `review.publisher.ts`）。不要删掉这个标记。线程回复没有这套核对。`uncertain` 是终态，管理页只能查看、不能处理。
- **重试判断先看错误类型。** `transient()` 依次认 `ProviderError`、`GitHubApiError`（按状态码）、`BudgetError`、`TimeoutError` 和网络错误码，最后才用 `\b5\d\d\b` 等正则兜底。新增的外部调用失败时抛带类型的错误；无类型的错误消息里不要出现无关的 5xx 形态数字。
- **语言识别只有一份。** 扩展名映射和语言别名都在 `src/config/languages.ts`，变更画像和规则 Scope 共用，不要在别处再写一份。
- **风格。** 用 Biome 格式化：提交前跑 `npm run format`，`npm run check:format` 检查。`npm run lint` 目前有存量报错（主要在管理页的无障碍规则），只作参考，不要顺手批量修。整体格式化的提交记在 `.git-blame-ignore-revs`，本地可执行 `git config blame.ignoreRevsFile .git-blame-ignore-revs`。
- **数据库迁移。** 全新库用 `migrations/001_baseline.sql`；已有库只加增量迁移。

## Eval（真实模型，手动运行）

样本仓库：`M2tHane/pi-review-test-repository`（公开）。需要 `MODEL_PROVIDER/MODEL_NAME/MODEL_API_KEY`，结果写到 `work/`。

```sh
npm run build
git clone https://github.com/M2tHane/pi-review-test-repository work/m2-eval-snapshot
git -C work/m2-eval-snapshot checkout ad75aa1e1f1a3604682af068c2c048da23bbbe7a
node --env-file=.env eval/evaluate-m2.mjs work/m2-eval-snapshot [case...] [--runs=3]
# evaluate-ux.mjs 还需要 DATABASE_URL，以及 work/e2e-order-api、work/e2e-order-followup 两个 clone
```

- `evaluate-ux.mjs` 的 `orders-*` 断言要求"订单查询暴露内部列表 + 导出原地排序"聚合成 1 个问题。改 Prompt 后这条最容易变化，需要对比改前改后的结果，而不是只看是否通过。
- 模型输出有随机性，单次结果不能说明问题，同一 case 至少跑 3 次再下结论。
