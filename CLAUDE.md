# CLAUDE.md

协作规则、产品边界和安全约束以 AGENTS.md 为准，这里只补充上手和改代码时容易踩的点。

@AGENTS.md

## 项目一句话

GitHub App + Pi SDK 的 PR Review 服务：Webhook 进 PostgreSQL 任务表 → 单 Worker 串行执行 → 固定 SHA 的只读 Workspace 里跑模型 → 校验后发布 `COMMENT` Review；合并后抽取团队规则候选，维护者确认后进入后续 Review 的召回。

## 命令

```sh
npm ci
mkdir -p work            # 新 clone 必须先建；否则 docs-links 测试 mkdtemp 失败
npm run build            # tsc + esbuild 打包 frontend/ 到 dist/admin
npm test                 # 含 build；无 DATABASE_URL 时数据库用例 skip（skip ≠ 通过）
npm run db:up            # docker compose 起 postgres，端口 54329，见 .env.example
npm run test:db          # 需要 .env 里的 DATABASE_URL
npm run check:docs
```

- 测试跑的是 `dist/test/**`，改完 TS 必须重新 build，不能只跑 `node --test test/...`。
- `npm test` 与 `npm run test:db` 都会写 `dist/`，不要并发跑。
- 单个测试文件：`npm run build && node --test dist/test/review/orchestration.test.js`。

## 代码地图

| 环节 | 位置 |
| --- | --- |
| Webhook 验签、路由 | `src/github/webhook/`（`handler.ts` 入口） |
| 入队、去重、取消 | `src/persistence/repositories/job.repository.ts` |
| Worker 领取与重试 | `src/jobs/runner.ts`（`transient()` 决定是否重排） |
| PR Review 主流程 | `src/review/review.processor.ts` |
| 单 Agent / Session / 预算 / 工具 | `src/review/agent.ts`（`runAgentSession`、`REVIEW_PROMPT`、`workspaceTools`） |
| 多 Agent 编排 | `src/review/orchestration.ts`（`complexityProfile` → `allowedRoles` → Main → `aggregate`） |
| 子 Agent 委派与角色 Prompt | `src/review/delegation.ts`（`roleRegistry`、`BudgetLedger`） |
| 分组、短评、发布正文 | `src/review/presentation.ts` |
| 发布与幂等台账 | `src/review/review.publisher.ts` + `review-publication.repository.ts` |
| Reply 复核 | `src/reply/reply.processor.ts` |
| 规则抽取 / 召回 | `src/memory/decision.processor.ts`、`src/memory/memory.service.ts`（`retrieve`、`scopeMatches`） |
| 健康检查 | `src/health/` |
| 管理 API / 页面 | `src/admin/handler.ts`、`frontend/` |
| 服务组装 | `src/bootstrap/application.ts` |

`src/jobs/queue.ts` 的内存 `JobQueue` 只在 `webhook/handler.ts` 传入函数型 target 时使用（主要是测试），生产路径走 PostgreSQL。

## 改代码时注意

- **Prompt 里不能写评测样本的答案。** `REVIEW_PROMPT`、`MAIN_PROMPT`、`roleRegistry` 每次审查都会发出去；只写通用规则。改完 Prompt 用 `eval/` 回归。
- **新 Agent 调用一律走 `runAgentSession`。** 它负责预算预留、关闭 SDK 重试与压缩、超时和取消。直接调 `createAgentSession` 时如果不传 `settingsManager`，SDK 会按 `SettingsManager.create(cwd, ~/.pi/agent)` 读取待审仓库的 `.pi/settings.json`（默认视为可信）和宿主机全局设置。
- **模型输出的校验。** `parseReviewResult`、`parseDecisionProposals`、`validateDisplay` 是信任边界。改字段时同步改 Prompt 里的 JSON 说明、`src/review/types.ts` 和对应测试。
- **发布状态。** PR Review 总评末尾带 `<!-- pi-review:<fingerprint> -->` 标记；发布失败或上次中断时按这个标记查 GitHub 已有 Review 再决定（见 `review.publisher.ts`）。不要删掉这个标记。线程回复没有这套核对。`uncertain` 是终态，管理页只能查看、不能处理。
- **重试判断靠正则匹配错误消息。** `transient()` 用 `\b5\d\d\b` 等规则匹配；新增的错误消息里不要出现无关的 5xx 形态数字，否则会被误判为可重试。
- **语言识别只有一份。** 扩展名映射和语言别名都在 `src/config/languages.ts`，变更画像和规则 Scope 共用，不要在别处再写一份。
- **风格。** 现有代码大量单行超过 200 字符，仓库没有配格式化工具。新写或改动的代码按正常换行写，不要沿用超长行；也不要顺手重排未改动的文件，否则 diff 难以审查。
- **数据库迁移。** 全新库用 `migrations/001_baseline.sql`；已有库只加增量迁移。

## Eval（真实模型，手动运行）

样本仓库：`M2tHane/pi-review-test-repository`（公开）。需要 `MODEL_PROVIDER/MODEL_NAME/MODEL_API_KEY`，结果写到 `work/`。

```sh
npm run build
git clone https://github.com/M2tHane/pi-review-test-repository work/m2-eval-snapshot
git -C work/m2-eval-snapshot checkout ad75aa1e1f1a3604682af068c2c048da23bbbe7a
node --env-file=.env eval/evaluate-m2.mjs work/m2-eval-snapshot [case...]
# evaluate-ux.mjs 还需要 DATABASE_URL，以及 work/e2e-order-api、work/e2e-order-followup 两个 clone
```

- `evaluate-ux.mjs` 的 `orders-*` 断言要求"订单查询暴露内部列表 + 导出原地排序"聚合成 1 个问题。改 Prompt 后这条最容易变化，需要对比改前改后的结果，而不是只看是否通过。
- 模型输出有随机性，单次结果不能说明问题，同一 case 至少跑 3 次再下结论。
