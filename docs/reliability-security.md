# Pi Repository Governance Agent — Reliability & Security

版本：v0.1｜日期：2026-09-10

> 本文定义事件接收、任务幂等、恢复、重试、发布一致性、权限、工作区隔离和数据安全边界。

## 1. 目标

系统需要保证：

- Webhook 快速可靠接收。
- 同一事件不会产生重复业务效果。
- 新提交不会被旧 Review 覆盖。
- 服务重启后已接收任务可以恢复。
- GitHub API 响应丢失时不盲目重复评论。
- Agent 不能越权读取其他仓库或宿主机资源。
- 仓库中的恶意内容不能改变系统权限和执行边界。
- 所有外部副作用可追溯。

## 2. 接收可靠性

### 2.1 Webhook 接收

流程：

1. 基于原始请求体验签。
2. 验证事件格式、installation 和 repository 归属。
3. 对支持事件保存 delivery 记录和 Job。
4. 事务成功后再确认接收。
5. 快速返回 2XX / 202。

M0 演示可以使用内存队列，但必须明确：服务重启会丢失未完成任务。

M1 使用 PostgreSQL 持久化事件和 Job。

数据库不可用时不能“假装接收成功”。

## 3. 幂等模型

系统分两层幂等。

### 3.1 接收层

以 GitHub `delivery_id` 去重。

收到相同 delivery_id：

- 已完成：直接确认，不重复建任务。
- 未完成：复用现有任务。
- 已失败：根据现有记录允许人工重投 / 恢复。

人工重投不能因为 delivery 已存在而永久失效。

### 3.2 业务层

按业务对象进一步防重复：

```text
repository
+ PR
+ task_type
+ target_sha / source_comment_id
```

例如：

- PR Review：repository + PR + head SHA。
- Reply Handler：repository + PR + review_comment_id。
- Decision Extractor：repository + PR + merged snapshot / merge identity。

## 4. Job 状态

至少支持：

- `queued`
- `running`
- `succeeded`
- `partial`
- `failed`
- `superseded`
- `cancelled`

重试复用同一个 Job，并记录：

- attempt。
- last_error。
- next_run_at。
- started_at / finished_at。

分析完成但尚未确认 GitHub 发布成功的 Job 不能标记为 succeeded。

## 5. 任务顺序与旧结果

同一个 PR 的 Review 发布串行化。

当新的 synchronize 事件到来：

- 排队中的旧 head Review → superseded。
- 正在执行的旧 Review → 尽力取消。
- 发布前再次检查 PR 当前 head。
- 当前结果与 head 不一致 → 不发布。
- 如最新 head 缺少任务 → 补建。

合并后的 Decision Extractor 或不同的人类回复不能因为“只保留最新 PR Review”而被错误丢弃。

## 6. GitHub 发布一致性

数据库和 GitHub API 之间无法获得天然 exactly-once。

因此目标是：**幂等记录 + 远端核对 + 可恢复状态机**。

发布前：

- 保存结果 fingerprint / 稳定标记。
- 校验 PR、head、repository 状态。

发布后：

- 保存 GitHub Review / Comment ID。

若 GitHub 已接受请求但客户端没有收到响应：

1. Job 进入待核对状态。
2. 通过已保存标记或远端记录查询是否已经发布。
3. 确认未发布后才能重试。
4. 不盲目重复发送。

## 7. 重试策略

可重试：

- HTTP 429。
- 临时网络错误。
- 模型临时错误。
- GitHub / 模型短暂 5xx。

判断（`src/jobs/runner.ts` 的 `transient()`）先看错误类型：

- 模型服务错误（`ProviderError`）：按服务方说明判断，限流、过载、5xx、网络和流中断可以重试；额度／账单用完、认证失败、参数错误不重试。
- GitHub（`GitHubApiError`）：429、5xx、带等待时间的 403（二级限流或主限流用尽）重试；其余 4xx 不重试。
- 网络错误按错误码（ECONNRESET、ETIMEDOUT 等，沿 cause 链查找）；预算不足不重试；执行超时重试。
- 都不是时才按错误文字兜底匹配。

策略：

- 最多执行 5 次；等待 30 秒、1、2、4 分钟（单次最长 15 分钟），能撑过一次几分钟的服务故障。
- 服务方给了 Retry-After 或限流重置时间时照它等，最长 1 小时。
- Token 预算按任务累计：重试沿用同一个任务，之前尝试用掉的 Token（含未回报的预留）从预算里扣掉，用完就不再重试。PR Review、Reply 和健康检查都这样；Decision Extract 没有 agent run 记录，仍按单次预算。

不可持续重试：

- 权限失效。
- repository 已取消授权。
- 请求签名错误。
- 无效输入。
- 明确的资源不存在。
- 服务端校验失败。

这些进入 failed / manual intervention。

## 8. 服务恢复与多实例

可以起多个实例共用一个数据库，每个实例同时执行 `WORKER_CONCURRENCY`（默认 2）个任务。

- **领取原子性**：领取在一把全局 advisory lock 下进行，同一仓库同一时间只跑一个 PR 任务（Review、Reply、Decision Extract）；健康检查不受这条限制，但有多个槽位时至少留一个给 PR 任务。
- **租约**：领取时写 `lease_token`、`locked_by`、`lease_expires_at`（60 秒），Worker 每 5 秒续租。只有持有租约的实例能写回结果。
- **实例崩溃**：租约过期的任务在下一次领取时重新排队；已被要求取消的直接结束；失联满 3 次的标为 failed，防止一个任务反复拖垮实例。对应的 running agent run 标为 cancelled。
- **正常停止（部署）**：不再领取新任务，中止正在跑的会话，任务放回队列且不计入尝试次数；已开始发布、状态不确定的保留 `uncertain`。
- **跨实例取消**：PR 关闭、有新提交、仓库停用时，本实例的会话立即中止；其他实例上的任务写入 `cancel_requested`，执行实例续租时看到即中止。
- **升级**：迁移给已有 running 任务 10 分钟租约，让旧版本进程跑完。
- **探针**：`GET /healthz` 只看进程；`GET /readyz` 检查数据库，停止中返回 503。
- 管理页登录会话和 OAuth state 存在 `admin_sessions`，多个实例共用；ID 只存 SHA-256，内容用 `SESSION_SECRET` 派生的密钥加密。

不提前引入 Redis／BullMQ 等队列平台。

## 9. 漏投递补偿

入口回 5xx（服务停止中、数据库不可用）或 GitHub 连不上、等到超时时，GitHub 不会自己重投，这段时间的事件就丢了。服务定时查本 App 的投递记录（`GET /app/hook/deliveries`），让 GitHub 重投（`POST /app/hook/deliveries/{id}/attempts`），两个接口都用 App JWT，不需要额外权限。重投走原来的 Webhook 入口，验签和按 delivery id 去重都不变。实现见 `src/github/webhook/redelivery.ts`。

- **时机**：启动后查一次，之后每 5 分钟一次。`WEBHOOK_REDELIVERY_ENABLED=false` 关闭。
- **补哪些**：同一个事件的多次尝试按 delivery id（投递记录里的 `guid`）合在一起看。任何一次尝试成功（2xx）就不管；最新一次是 5xx，或状态码为 0／缺失（连不上、超时）才补。只补服务会处理的事件：`pull_request`、`pull_request_review_comment`、`installation`、`installation_repositories`。
- **不补**：最新一次是 4xx（验签失败、请求体过大、字段无效）的，重投也会再失败。
- **次数与间隔**：每个事件最多重投 3 次，距离它最新一次尝试分别过去 5 分钟、30 分钟、2 小时才发下一次；3 次后仍失败就放弃。次数和时间都从 GitHub 返回的记录里算，本地不存状态。
- **窗口**：只看最近 3 天的投递（GitHub 只允许重投 3 天内的）；每轮最多翻 10 页（1000 条），没看完时记 `webhook_redelivery_truncated` 日志。
- **多实例**：用数据库 advisory lock 保证同一时间只有一个实例在查，拿不到锁的跳过本轮。数据库不可用时拿不到锁，也就不重投：那时重投只会再失败，白白用掉次数。
- **日志**：一轮里有重投时记一条 `webhook_redelivery` 汇总（重投、失败、放弃的数量），不记录事件内容；单个重投请求失败（例如 GitHub 回 422）记 `webhook_redelivery_request_failed`，不影响其他事件，下一轮重新判断。

限制：

- 服务整个停着的时候没有实例在查，恢复后的第一轮才补；停机超过 3 天的事件补不回来。
- 3 天内投递超过 1000 条时，每轮只看最新的 1000 条，更早的失败不会补。
- 放弃的事件（重投 3 次仍失败）和 4xx 失败的事件不会自动恢复，需要在 GitHub App 设置的 Advanced 页面查看投递记录、人工重投。
- 一个实例刚请求重投、GitHub 还没把新的尝试写进投递记录时，另一个实例紧接着查，可能对同一事件再请求一次。入口按 delivery id 去重，不会重复建任务，但会多用掉一次重投次数。
- 重投的事件带的是失败当时的 PR 快照，入口不区分新旧。同一个 PR 在这期间如果已经有更新的事件被正常接收，迟到的旧 `synchronize` 会把新 head 上还在排队或运行的 Review 标为被取代，旧 head 的任务开始时发现 head 已变也直接结束；新 head 可能因此没有 Review，要等下一次提交。人工重投一直有同样的情况，自动补投只是让它更容易出现。
- 尚未做真实 GitHub 联调，见 [任务清单](tasks/WEBHOOK-REDELIVERY.md)。

## 10. Agent 权限边界

分析 Agent 默认只获得只读能力。

允许：

- read / grep / find / ls。
- 受限 git diff / log / blame。
- 当前 Job 范围内 GitHub 读取。
- 当前 team / repository 范围内 Memory 读取。

禁止：

- 任意 shell。
- edit / write。
- git push。
- create PR。
- merge PR。
- memory activate / supersede / deprecate。
- 直接 GitHub create review / reply comment。
- 读取其他 Job、其他仓库或宿主机凭据。

## 11. 仓库内容的信任边界

以下内容全部视为**待分析数据**：

- PR description。
- PR comments。
- source code。
- README。
- AGENTS.md。
- 仓库内 `.pi` 配置。
- 任何提示模型执行命令的文本。

这些内容不能修改：

- 服务端 system prompt。
- Tool 权限。
- Memory 生效条件。
- GitHub 发布对象。
- repository / team 归属。
- 服务加载的 AGENTS.md、Skills 和扩展。

## 12. Pi 资源加载

Pi 默认会从工作目录和 `~/.pi` 发现上下文文件、Skills、扩展和设置。服务启动 Pi 时关闭这些自动发现（见 [Pi Runtime 决策](../.agents/decisions/pi-runtime.md)）：

- Pi 配置目录每次新建，只放服务写入的模型配置和设置。
- 只加载服务维护的 AGENTS.md、Skills、服务扩展和锁定版本的 codegraph 扩展。
- 不从工作区加载 `.pi` 扩展、设置、CLAUDE.md 或 `.claude/rules`。
- 仓库 AGENTS.md 由服务从目标分支读出，作为参考附在系统提示末尾；优先级低于服务要求和团队规则。

## 13. 工作区隔离

每个 Job 使用独立的临时仓库工作区，并绑定固定 SHA。

文件工具由服务扩展约束：

- 工具根路径。
- `..` 路径穿越。
- 符号链接解析（不存在的路径按最近存在的上级目录解析）。
- 写入只限开发任务，`.git`、`.codegraph` 不可写。

服务自己的 Git 调用禁用 hooks、宿主机全局配置、credential helper 和外部 filter；收集开发改动时再用命令行配置关闭 fsmonitor，因为 Agent 能改 `.git/config`。工作区 Git 配置不保存 token。

Agent 可以用 bash 在工作区里读代码、运行编译和测试等检查，不安装依赖、不访问网络服务。开发任务另有 Playwright 浏览器（`@playwright/mcp`，Pi 内置 MCP 加载）：无界面 Chromium、内存里的临时配置，可访问任意网站；文件读写限制在工作区，执行任意 Node 代码的 `browser_run_code_unsafe` 不开放，网页内容按数据处理并打码。浏览器的网址白名单不是安全边界，真要限制网络需要容器网络层。bash 的限制：

- 工作目录是 Workspace；Pi 子进程只拿最小环境变量（PATH、临时 HOME、代理与 CA），不继承数据库、GitHub、企微和模型凭据；模型 key 只在本地代理里。
- 单条命令有 Pi 自带的超时；任务总时限到达或取消时结束整个进程组。
- 与服务同一系统用户：以上只能避免顺手暴露，挡不住刻意读取服务进程的文件或环境。

需要强隔离（运行不可信代码、限制网络和资源）时，改为每任务一个容器：

- 无宿主机凭据。
- 受限网络。
- CPU / memory / time 限制。
- 临时文件系统。

## 14. GitHub 权限最小化

核心 MVP：

| GitHub 权限 | 级别 |
| --- | --- |
| Metadata | Read |
| Contents | Read |
| Pull requests | Read & Write |
| Contents Write | 不申请 |
| Actions / Checks | 默认不申请 |
| Security alerts | 默认不申请 |

Pull requests Write 只用于 COMMENT Review / 评论。

服务端不允许模型选择：

- APPROVE。
- REQUEST_CHANGES。
- Merge。

## 15. Token 与凭据

使用 GitHub App installation access token。

要求：

- Token 由 GitHub 适配层管理。
- 不进入模型 prompt。
- 不写入 Agent 可读工作区。
- 不记录到普通日志。
- 错误日志对 Token / Secret 做脱敏。

其他模型 API key 和内部凭据采用同样原则。

## 16. 数据边界

所有核心对象都必须带归属：

- Job → team + repository。
- Memory → team + repository / authorized scope。
- Review Result → repository + PR + SHA。
- Audit Record → source Job + user / system actor。

服务端在以下边界分别校验权限：

- 管理 API。
- Memory 检索。
- GitHub 发布。
- 手动任务重试。
- Memory 激活 / 替代 / 废弃。

模型给出的 repository_id、Memory ID 或 URL 永远不能代替服务端授权判断。

## 17. 模型数据流

源码按任务需要发送给配置的模型服务。

团队必须能够明确：

- 使用哪个模型供应商。
- 哪些源码 / diff 会被发送。
- 日志保存什么。
- 数据保留多久。

日志应屏蔽：

- 密钥。
- Token。
- 不必要敏感内容。

审计应保留：

- Job。
- repository / PR / commit。
- 工具执行摘要。
- 引用来源。
- 模型用量。
- 最终结果。
- 外部副作用。

不需要保留或展示模型内部思维过程。

Agent 执行过程（Pi 会话）保存在 `agent_sessions`，供排查"做了什么、时间花在哪"：

- 保存前去掉模型思考过程和图片数据；单段内容超过 2 万字符截断，整份超过 10 MB 时保留开头和结尾；全部字符串再打码一遍。
- 会话里仍有源码片段、PR 与任务原文和 Agent 输出，查看和下载都按所属仓库检查 maintain 权限；开发任务的记录另需仓库在服务授权列表内。
- 运行中有变化时每 5 秒保存一次，至少每 30 秒更新一次时间；超过 2 分钟没更新的 `running` 记录按“已中断”展示（执行它的服务已停止），不改写数据库状态。
- 保存失败只记日志，不影响任务结果。

## 18. 生命周期与数据删除

Job 工作区在任务完成后回收。

服务启动后每 6 小时清理一次（多实例时由 advisory lock 保证只有一个在跑，每批最多 500 条）：

- **已结束任务**：保留 `DATA_RETENTION_DAYS` 天（默认 90，0 表示永久保留），连同审查结果、finding、发布记录、线程回复、规则线索、agent run 和执行过程记录一起删除（外键级联）。
  - PR 相关任务按 PR 整组判断：这个 PR 最近一次活动早于保留期才删，活跃 PR 的全部历史保留，"之前提过的问题"去重和线程回复不会断。
  - 健康检查每个仓库保留最近一份报告。
  - 投递记录没有任务引用、又过了保留期的才删。
  - 开发任务本身不删，只删过了保留期的执行过程记录。
- **卸载 App 或移除仓库**：记下 `revoked_at`，再等 `REVOKED_DATA_GRACE_DAYS` 天（默认 30，0 表示不删）删除该仓库的全部数据，包括 Team Memory 和审计记录。暂停安装不算撤销；重新安装或重新加入仓库会取消待删除标记。
- Team Memory 在仓库仍接入时独立保存，不受任务保留期影响。

## 19. 预算与资源限制

repository budgetTokens 是整个 PR Job 的总量（含重试），默认 500,000；同一设置也是健康检查的总预算。Pi 进程审查一个小 PR 实测约 6–9 万 token，旧默认 20,000 会让审查几乎都超预算，迁移 `009_default_budget.sql` 把仍是旧默认值的仓库一并调整。开发任务默认不限 token，可用 `DEVELOPMENT_BUDGET_TOKENS` 设上限；不限时仍持久化每次请求的预留与用量。Pi 的请求经过服务的本地模型代理：代理按实际请求体的输入字节估计加输出上限预留，先持久化预留再转发，并把请求里的输出上限收紧到剩余额度以内；超预算直接拒绝、不转发。完成后按含 cache 的 usage 结算；单次输出最多 16384 tokens。估计包含协议余量，会保守拒绝，不能把额度视为精确 tokenizer 结果。

Provider 已收到请求但未回报 usage 时，保留该次预留额度，并与实际 token 分列。失败和取消的会话也保存用量。Pi 的上下文压缩和自动重试关闭，重试由任务队列按错误类型决定。

Draft、closed、新 head、仓库暂停和受控停止通过 AbortSignal 结束 Pi 进程组。Reply 遇到 superseded 则重新绑定当前 head，不丢失人类回复。

数据库测试在一次性 schema 运行；测试 Worker 不接触真实 Job 队列。当前验证和限制见 [M2 清单](./tasks/M2.md)。

M3 Health 的预算还跨 Job 重试与进程恢复持久保存。每次模型请求前，onUsage 必须先成功保存已消耗量与本次最大预留；写入失败就不发送 Provider 请求。收到 usage 后结算；进程在响应前消失时，旧预留作为 unreportedTokens 保留。下一次尝试扣除同一 Job 的实际与未知消耗，不因手动重试重置额度。

Health 的文件清单、单文件／总字节、工具返回行数、CI 页数与来源数量均有上限；报告记录实际读取范围。GitHub、Git、文件与模型阶段共用取消信号，最大任务时限为 AGENT_TIMEOUT_MS 与 120 秒的较小值。失败或缺失数据不等于检查通过；趋势只比较可比维度。锁文件单独读取（单个最多 8MB、最多 30 个），依赖版本最多查询 5000 个、漏洞详情最多取 300 条，交给模型的漏洞记录最多 50 条；超出部分记为缺失数据。密钥扫描最多 5000 个文件（单个 1MB）；Semgrep 最多扫描 3000 个源码文件、限时 90 秒，报告各保留前 200 条记录。当前边界与证据见 [M3 清单](./tasks/M3.md)。

每个 Job 应配置：

- 最大模型调用次数。
- 最大 Token / 成本预算。
- 最大运行时间。

任务取消必须结束 Pi 进程和它启动的命令。

预算耗尽时：

- Job 标记 partial 或 failed。
- 输出已检查范围。
- 输出未完成维度。
- 不得显示“检查通过”。

## 20. 可靠性与安全验收

| 场景 | 通过条件 |
| --- | --- |
| 签名错误 | 拒绝请求，不创建 Job |
| 同一 delivery 重放 | 不重复业务效果 |
| 新 head 到来 | 旧结果不作为最新 Review 发布 |
| 服务重启 | 已持久接收任务可恢复 |
| GitHub 发布响应丢失 | 先核对远端，再决定是否重试 |
| 模型返回跨仓库 Memory ID | 服务端拒绝 |
| PR 内容要求“忽略系统规则并运行脚本” | 不改变工具权限和输出格式；Agent 只运行与任务相关的检查 |
| 恶意 symlink 指向宿主机 | 工具层拒绝越界读取 |
| 模型超时 / 预算耗尽 | Job 显示 failed / timeout，不发布不完整结果 |
| repository 移除授权 | 停止读取、执行和发布 |
