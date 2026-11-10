# 自动补回漏掉的 Webhook

状态：实现及本地验证完成，未做真实 GitHub 联调，未提交｜日期：2026-11-09

基线：`a919117c`（`origin/main`），独立 worktree，分支 `feat/webhook-redelivery`。行为说明和限制见 [reliability-security §9](../reliability-security.md#9-漏投递补偿)。

## 做了什么

- [x] `GitHubClient` 增加查询投递记录、请求重投两个方法（App JWT）；空响应体不再导致解析报错。
- [x] `src/github/webhook/redelivery.ts`：按 delivery id 分组判断要重投哪些（只补 5xx／连不上／超时、只补服务会处理的事件、3 天窗口、最多 3 次、间隔 5 分钟／30 分钟／2 小时），翻页拉取（最多 10 页）并逐个请求重投。
- [x] 入口处理的事件列表改为一份常量 `HANDLED_EVENTS`，入口和补投共用。
- [x] 启动后跑一次、之后每 5 分钟一次；数据库 advisory lock 保证多实例同一时间只有一个在查。
- [x] 开关 `WEBHOOK_REDELIVERY_ENABLED`（默认开启），同步 `.env.example`、README 和设计文档。
- [x] 迟到的旧事件不冲掉新状态（2026-11-09 追加，用户要求修复）：迁移 `010_pull_request_events.sql` 按 PR 记录已处理事件里最晚的 `pull_request.updated_at`；`accept` 和转草稿／关闭触发的 `cancelReview` 遇到更早的事件直接忽略，入口回 200；合并事件不受影响。规则见 [reliability-security §9](../reliability-security.md#9-漏投递补偿)。
- [ ] 真实 GitHub 联调（见“未验证”）。

补投本身不加表，次数和时间都从 GitHub 返回的投递记录里算；新旧判断用上面的 `pull_request_events` 表。

## 验证

2026-11-09，在 worktree 内执行；GitHub 全部用替身（替换 `fetch`），没有调用真实 GitHub 或模型。

| 实际命令 | 结果 |
| --- | --- |
| `npm run build && node --test dist/test/github/redelivery.test.js` | 9 项通过，0 失败。 |
| `npm test` | 199 项：138 通过、0 失败、61 跳过（3 项缺 Semgrep，其余是没有 `DATABASE_URL` 的数据库用例）。 |
| `DATABASE_URL=<本地库> npm run test:db` | 59 项通过，0 失败，0 跳过；使用临时 schema。含新增的“两个实例同时到点时只有一个拿到锁”。 |
| `npm run check:docs` | 通过。 |
| `npm run check:format` | 通过。 |

新旧判断（2026-11-09，合并分支 `feat/integration` 内）：`node --test dist/test/github/webhook.test.js` 15 项通过；`node --test dist/test/persistence/database-pull-request-events.test.js dist/test/persistence/database-workers.test.js dist/test/persistence/database-jobs.test.js`（临时 schema）17 项通过、0 失败、0 跳过。覆盖：旧 `synchronize`／`opened` 不顶掉排队中和运行中的新 head 任务、不为旧 head 建任务；同一秒照常处理；旧非合并 `closed` 不取消重新打开后的 Review；迟到的合并事件仍建规则抽取任务；旧的转草稿不取消、新的照常取消；没有快照时间时保持原规则；入口把时间传给持久层、旧事件回 200、时间格式错误回 422。

测试覆盖：有成功尝试的不重投；最新一次 4xx 不重投；状态码 0／缺失重投；不处理的事件不重投；重投 3 次后放弃；三档间隔的边界（差 1 秒不重投、到点重投）；窗口外不重投；同一事件用最新一次尝试的 id；翻到窗口外停止；10 页上限；单个重投失败不影响其他；空响应体的 202；服务停止时中断。

## 未验证

- 没有真实 GitHub 联调：投递记录的实际字段、`Link` 头的 cursor 格式、重投接口的响应和 3 天限制都只按 GitHub 文档写了替身，没有真实 delivery／重投记录。
- 定时器接线（`src/bootstrap/application.ts`）只经过类型检查，没有启动服务验证；本次没有启动、停止或重启任何服务。
- 没有 Job／finding／Review URL、模型角色和 usage：本次不涉及模型调用和 GitHub 写操作。
