# Repository Architecture

## Context

服务同时处理 GitHub Webhook、持久 Job、PR Review、Reply、Team Memory、Health Audit 和管理 API。这些流程共享仓库授权、固定快照与 PostgreSQL 事务；按技术层拆成多个服务会让一次审查跨越更多部署和一致性边界。

## Decision

保持单个 Node 进程（HTTP 与 Worker 同进程），以业务模块组织 `src/`；同一份进程可以起多个实例，共用一个 PostgreSQL。`bootstrap` 只装配依赖，`github` 接收并路由事件，`jobs` 负责领取与分派，`review`、`reply`、`memory`、`health` 各自处理业务，`admin` 提供管理接口，`persistence` 持有 SQL 和事务。

[Dispatcher](../../src/jobs/dispatcher.ts) 显式处理已知 Job Type；未知类型必须失败。[Database](../../src/persistence/database.ts) 暂时作为既有调用方的薄 facade，SQL 已归入业务 Repository。该 facade 是渐进迁移的兼容边界，不是继续集中新业务逻辑的理由。

PostgreSQL 同时承担持久状态、幂等键、事务、Job 领取、租约和跨实例取消；外部 GitHub 发布由服务在提交前后明确处理不确定结果。运行时不自动执行迁移。

## Why

多团队接入需要并发，零停机发布时也会有新旧两个进程同时在线，所以 Worker 用"领取锁 + 租约 + 心跳"支持多实例：领取在一把全局 advisory lock 下进行（只占几毫秒），保证同一仓库同一时间只跑一个 PR 任务；租约过期视为实例失联，由其他实例接手。这些都在 PostgreSQL 里完成，微服务、Redis 或 BullMQ 会增加队列与数据库之间的一致性问题及部署成本，仍不引入。

手写 SQL 使事务范围、锁和幂等约束可见；ORM 或完整 DDD 层次会在当前规模引入重复映射。薄 facade 保留旧接口，让模块迁移不必同时重写调用方和状态机。

## Constraints

- 修改模块边界时保留 Webhook 验签、Job 状态、重试、取消与发布事务语义。
- 新 SQL 放在所属业务 Repository；不要把业务判断重新堆进 Database facade。
- 新 Job Type 必须显式接入 Dispatcher、持久化和验证，不能默认按 Review 处理。
- 同一仓库的 PR 任务（Review、Reply、Decision Extract）必须串行：Reply 按回复时间处理，Decision Extract 会改变后续召回的团队规则。不要为了吞吐去掉这条领取条件。
- 只有持有租约的实例能结束任务（`finishJob`／`failJob` 带 `lease_token` 条件）；新增写任务状态的路径要保留这个条件。
- 只有实际吞吐、隔离或部署需求出现时，再评估独立服务或额外队列。
