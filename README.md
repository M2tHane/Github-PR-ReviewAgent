# GitHub PR Review Agent

基于 **Pi + GitHub App** 的团队级 PR Review 与工程治理 Agent。

它不只是在 PR 中生成一次性的 AI Review，而是把 **PR 审查、讨论复核、团队规则沉淀、后续规则复用** 串成一个持续闭环：

```text
Pull Request
    ↓
AI Review
    ├─ Single Agent
    └─ Main Agent + Specialist
    ↓
Inline Findings / Summary
    ↓
Developer Reply
    ↓
Reply Re-evaluation
    ↓
PR Merged
    ↓
Decision Extraction
    ↓
CANDIDATE Team Memory
    ↓
Maintainer Confirm
    ↓
ACTIVE Team Memory
    ↓
Future PR Review
```

项目同时提供仓库级 **Health Audit**，用于在不修改源码的前提下，对代码库进行只读健康检查；以及企业微信群内的开发任务，由 Agent 在临时工作区改代码、服务提 PR。

## 核心能力

### 1. PR Review

每个任务启动一个 Pi agent 进程，单 Agent 完成审查：

- 使用 Pi 内置的读取、搜索、bash 工具和 codegraph 插件理解代码；工作区没有 codegraph 索引时先建索引。
- 安全、架构、团队规则冲突的检查方法写成服务自有的 Skills，Agent 按变更读取。
- 加载服务自己的 AGENTS.md；仓库 AGENTS.md 只取目标分支版本作参考，PR 里的改动不生效。
- 固定 PR Head SHA 创建临时 Workspace，避免分析过程中代码漂移。
- Structured Output 约束模型结果，并在发布前进行结构、路径和状态校验。
- 本地模型代理在每次请求前预留 Token Budget，超预算不发送。
- Finding 去重与同根因聚合。
- 可定位问题发布为 GitHub Inline Review；无法可靠定位的问题降级到 Summary。

### 2. Team Memory

将 PR 中明确确认的工程决策沉淀为后续 Review 可复用的团队规则：

```text
PR Merge
  → Decision Extraction
  → CANDIDATE
  → Maintainer Confirm
  → ACTIVE
  → Future Review Recall
```

Memory 具备以下约束：

- Repository Isolation：规则只在所属仓库内生效。
- Scope Filter：根据路径、语言、模块和适用条件过滤规则。
- Version / Source Validation：校验规则版本及来源。
- Human-in-the-loop：AI 只能提出候选规则，ACTIVE 规则必须由维护者确认。
- 支持 supersede / deprecate 等规则生命周期管理。

### 3. Reply Handler

开发者回复 Agent 的 Inline Finding 后，系统会重新读取当前 PR Head 与讨论上下文，对原问题进行二次判断。

当前状态包括：

- `FIXED`：问题已经修复。
- `MISJUDGMENT`：原 Review 判断错误。
- `VALID_EXCEPTION`：存在合理例外。
- `STILL_VALID`：问题仍然成立。
- `NEEDS_CLARIFICATION`：需要进一步说明。

### 4. 可靠性与安全治理

系统使用 PostgreSQL 持久化任务、幂等状态和 Review 结果，并对 GitHub 与模型调用做显式失败处理：

- Webhook Delivery 幂等。
- PostgreSQL 持久化 Job。
- 异常重启后恢复未完成任务。
- 指数退避与有限次数重试。
- Publication Fingerprint 防止重复发布。
- PR Review 发布失败或中断时，先查一次 GitHub 上是否已有本次 Review：已有就记为已发布；收到 GitHub 错误响应且查不到才重试；网络中断且查不到时进入 `uncertain`，停下不重发，需要人工处理（管理页只能查看，暂无处理入口）。线程回复暂不自动核对，结果不明时同样进入 `uncertain`。
- 新 Head、Draft、关闭 PR、仓库暂停等情况会取消过期 Review。
- Review、Reply 和规则提取 Agent 没有写文件工具，所有 Agent 都没有 GitHub 写操作或 Memory Mutation 权限。Pi 子进程不继承服务凭据，模型 key 只在本地代理里。

### 5. Repository Health Audit

Health Agent 对仓库进行独立的只读检查：

- 固定默认分支 SHA 与检查窗口。
- 不运行仓库脚本。
- 不修改源码。
- 不发布 GitHub Review。
- 不修改 Team Memory。
- 支持手动执行以及每日 / 每周定时执行。
- 历史报告保存在管理界面中。

## 系统架构

```text
GitHub
  │
  │ Webhook / Pull Request / Review Comment
  ▼
GitHub App
  │
  ▼
HTTP API
  │
  ├───────────────┐
  ▼               ▼
PostgreSQL     Admin UI
  │
  ▼
Persistent Worker
  │
  ├─ PR_REVIEW
  ├─ REPLY_HANDLE
  ├─ DECISION_EXTRACT
  └─ HEALTH_AUDIT
  │
  ▼
Pi agent 进程（每个任务一个）
  │
  ├─ Review Agent + Skills
  ├─ Reply Agent
  ├─ Decision Extractor
  ├─ Health Agent
  └─ 开发 Agent（企微群）
  │
  ▼
GitHub Review / Team Memory / Health Report
```

主要技术栈：

- TypeScript / Node.js 24+
- Pi Coding Agent（RPC 模式）+ codegraph
- GitHub App / Webhook / OAuth
- PostgreSQL
- React
- Docker Compose

## Quick Start

### 1. 安装依赖

```bash
npm ci
```

Agent 运行依赖：

| 依赖 | 来源 | 用途 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | npm（package.json） | Pi agent，本服务以 RPC 模式为每个任务启动一个进程 |
| `@colbymchenry/codegraph` | npm（package.json） | 代码知识图谱；按平台安装对应的预编译包（如 `@colbymchenry/codegraph-linux-x64`）。缺少平台包时不会联网下载，任务照常进行，只是不加载 codegraph 工具 |
| `@playwright/mcp` | npm（package.json） | 开发任务的浏览器工具（Pi 内置 MCP 加载）。浏览器要另外安装：`node node_modules/@playwright/mcp/cli.js install-browser --only-shell chromium`（无界面 Chromium，下载约 100 MB），装在 Playwright 默认目录，或用 `PLAYWRIGHT_BROWSERS_PATH` 指定 |
| `rg`（ripgrep） | 系统包 | Pi 的 grep 工具。Pi 离线运行，不会自动下载 |
| `fd`（Debian 包名 `fd-find`，命令 `fdfind`） | 系统包 | Pi 的 find 工具 |
| `git` | 系统包 | 获取固定提交的工作区 |

`rg`、`fd` 用系统包管理器安装，例如 `brew install ripgrep fd`。

每个工作区第一次运行 Agent 时会建 codegraph 索引（大仓库可能需要数十秒、占用数百 MB 临时空间），不跨任务缓存。`codegraph_*` 工具由服务自己的 Pi 扩展提供（`src/pi/codegraph-extension.ts`）：每个 Agent 一个常驻 codegraph 进程，启动时预热，查询固定在当前工作区。

### 2. 启动 PostgreSQL

```bash
npm run db:up
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

至少需要配置：

```text
GITHUB_APP_ID
GITHUB_PRIVATE_KEY_PATH
GITHUB_WEBHOOK_SECRET
DATABASE_URL
MODEL_PROVIDER
MODEL_NAME
MODEL_API_KEY
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_OAUTH_CALLBACK_URL
SESSION_SECRET
```

完整配置说明见 [.env.example](.env.example)。

`PROCESS_ROLE` 决定本进程的职责，取值为 `edge`、`worker`、`all`，未设置时默认 `all`；其他值（含空值）会在启动时报错。它只能通过环境变量设置，修改后需要重启。`PORT` 是本进程的 HTTP 监听端口，默认 3000；worker 只开放探针。

时限、定时任务间隔、数据保留天数、模型名称和思考强度、健康检查开关、并发与开发任务额度，也可以在管理端「设置 → 服务设置」修改，改完最多 30 秒所有实例生效，不用重启；`.env` 里的值是没人改过时的默认值。只有 `SERVICE_ADMINS`（GitHub 用户名，逗号分隔）里的人能改，其他维护者只读。密钥和地址只能改 `.env`。详见 [服务设置](docs/reliability-security.md#服务设置)。

配置智能机器人长连接，并在「仓库 → 选择仓库 → 群内开发」启用群绑定：审查结果成功发布到 GitHub 后，机器人直接向该仓库绑定群发送完成状态和 PR 链接，不 @成员，也不需要 GitHub／企微成员映射或 Message Push Webhook。发送失败不会重新执行 AI 审查。配置、迁移和通知状态见 [企业微信通知](docs/wecom-notifications.md)。

### 4. 初始化数据库

首次运行：

```bash
npm run migrate
```

`migrations/001_baseline.sql` 用于全新数据库初始化。已有旧版迁移记录的数据库不要直接套用 baseline，需要单独制定迁移转换方案。

### 5. 启动服务

生产式启动：

```bash
npm run build
npm start
```

开发模式：

```bash
npm run dev
```

> `npm start` 不会自动执行数据库迁移。数据库结构发生变化时，应先显式运行 `npm run migrate`。

## 部署与滚动发布

同一份代码、镜像或构建产物可以按角色分别运行，所有实例连接同一个 PostgreSQL：

| 角色 | 提供的能力 | HTTP |
| --- | --- | --- |
| `edge` | GitHub Webhook、管理页和 API、企微收消息、回执与通知 | 完整业务路由及 `/healthz`、`/readyz` |
| `worker` | 审查等任务执行器、开发任务执行器、健康检查定时入队、数据与临时目录清理、Webhook 漏投递补偿 | 仅 `GET /healthz`、`GET /readyz`；业务路径返回 404 |
| `all`（默认） | 上述全部能力，适合单进程部署 | 完整业务路由及探针 |

先完成依赖安装、配置、数据库迁移和一次 `npm run build`，再在不同终端或进程管理器中启动。例如同一主机上使用不同端口：

```bash
PROCESS_ROLE=edge PORT=3000 npm start
PROCESS_ROLE=worker PORT=3001 npm start
```

单进程部署仍可直接 `npm start`（不设置 `PROCESS_ROLE`），或显式指定：

```bash
PROCESS_ROLE=all PORT=3000 npm start
```

角色拆分不改变现有环境变量的必填要求；各实例使用一致的数据库、GitHub App、仓库白名单和企微 Bot 配置。worker 也需保留 Bot 配置以记录通知目标，但不会建立企微连接。将公网入口与 GitHub Webhook 指向 edge。多个 edge 共用同一 Bot 时，只有持有现有数据库 Bot 锁的实例建立长连接，其余提供 HTTP，并在锁释放后竞争接管。

两种角色都在启动时读取管理端服务设置，此后每 30 秒刷新一次。设置页说明了各项生效的角色。`WORKER_CONCURRENCY` 与 `DEVELOPMENT_CONCURRENCY` 分别控制每个 worker / all 的审查等任务和开发任务并发；多个 worker 的并发槽位相加，任务仍按现有租约与串行规则领取。健康定时入队沿用数据库去重与事务控制，清理和漏投递补偿沿用数据库锁。

滚动发布步骤：

1. 用新构建产物先启动新 worker，检查它的 `/readyz` 返回 200。旧、新 worker 可以同时工作。
2. 向旧 worker 的 Node 进程发送 `SIGTERM`（`SIGINT` 也可），等待它退出。它立即停止领取任务，中止当前 Agent 并等待收尾，把未完成任务放回队列，然后关闭数据库；其他 worker 会接手。进程管理器应留足收尾时间，不要直接强杀。崩溃或强杀时依靠租约到期恢复。
3. edge 可以独立重启，不会中止 worker 正在执行的任务。发送相同的停止信号后，它关闭 HTTP 监听，等已接收请求和企微发送处理收尾后退出。多个 edge 时，可先启动新实例并切换流量，再停止旧实例。

`all` 收到停止信号时会同时停止 HTTP、企微与执行器；需要独立发布入口而不打断执行时，使用分开的 edge 和 worker。以上探针不检查模型或 GitHub 可用性：`/healthz` 表示进程存活，`/readyz` 另检查数据库可用及停止状态。

部署容量：edge 的数据库连接池上限为 5；worker / all 为 `5 + 3 × (WORKER_CONCURRENCY + DEVELOPMENT_CONCURRENCY)`，并发设置变化时同步调整。默认并发 2 与 3 时，worker / all 上限为 20；滚动期间应为旧、新实例连接池总和预留数据库容量。池按需建连接，上限不代表常驻连接数。每增加一个实例会增加一次每 30 秒的服务设置查询；edge 不轮询任务队列或运行后台定时任务。拆分会增加一个 Node 进程的基础内存，实际内存和请求延迟需按部署环境与任务负载测量。

## GitHub App 配置

建议权限：

- Metadata: Read
- Contents: Read（启用群内开发或规则文件同步时 Read & Write，即 `contents: write`）
- Pull requests: Read & Write（`pull_requests: write`，用于审查及规则同步 PR）
- Issues: Read & Write（群内开发的需求 issue）

仓库维护者可在「仓库 → 审查 → 规则文件同步」逐个开启规则同步（默认关闭）。规则变更后，服务通过 PR 更新固定的 `.pi-review/rules.md`，并在 AGENTS.md／CLAUDE.md 追加引用，供本地 Codex／Claude Code 读取；不会直接推默认分支或自动合并。需要维护者合并 PR 并在本地拉取后生效，详见 [规则文件同步](docs/memory-design.md#14-通过-pr-同步给本地-ai-工具)。上述写权限已由群内开发任务使用。

订阅事件：

- Pull requests
- Pull request review comments
- Pull request reviews（群内开发：开发 PR 的 review 总评）
- Issue comment（群内开发：需求 issue 和开发 PR 对话里的评论）

Webhook：

```text
https://<your-domain>/github/webhook
```

安装 GitHub App 后，服务管理员可在「设置 → 服务设置 → 仓库接入」选择仓库；本实例立即生效，其余 edge、worker、all 实例最多 30 秒同步，无需重启。列表包含未接入和已撤销仓库，并显示接入来源及最近操作人、时间；已撤销仓库须先在 GitHub 恢复授权。

`GITHUB_ALLOWED_REPOSITORIES` 仍可配置固定白名单（逗号分隔，大小写不敏感，可留空），与管理页接入的仓库取并集。配置文件里的仓库不能在管理页移出，需改配置并重启相关实例。管理页移出后，新事件不再处理、普通仓库列表不再显示，执行中的任务在发布前检查时停止。首次完全通过页面接入时，先配置 `SERVICE_ADMINS` 和 OAuth 登录。

管理页的 GitHub 维护权限按登录用户与仓库缓存：有权限 5 分钟、无权限 1 分钟，退出登录清除本实例该用户的缓存，新登录会话也不会复用其他实例上的旧缓存；服务白名单与撤销状态仍在每次授权时检查。

服务停止中或数据库不可用时 Webhook 会失败，GitHub 不会自己重投。服务每 5 分钟（管理端可改）查一次 GitHub 的投递记录并请求重投这些事件（`WEBHOOK_REDELIVERY_ENABLED`，默认开启，设为 `false` 关闭；不需要额外的 App 权限）。规则和限制见 [reliability-security §9](docs/reliability-security.md#9-漏投递补偿)。

管理界面使用 GitHub OAuth，并通过 OAuth 权限与 CSRF 校验保护维护者操作。

## Review 工作流

触发 PR Review 的事件：

```text
opened
reopened
synchronize
ready_for_review
```

不会进入正常新 Review 的情况包括：

- Draft PR
- Closed PR
- 暂停仓库
- 不受支持的 Fork
- 未授权仓库

完整流程：

```text
Webhook
  ↓
Signature / Repository / Delivery Validation
  ↓
Persistent Job
  ↓
Pin Base SHA + Head SHA
  ↓
Load Diff / Workspace / Team Memory
  ↓
Complexity Routing
  ├─ Single Agent
  └─ Main + Specialist
  ↓
Validate Structured Output
  ↓
Deduplicate Findings
  ↓
Re-check PR State + Head SHA
  ↓
Publish GitHub Review
```

## Team Memory 工作流

只有合并后的 PR 才会进入 Decision Extraction：

```text
Merged PR
  ↓
Read Diff + Review + Human Discussion
  ↓
Extract Reusable Engineering Decision
  ↓
Validate Repository / SHA / Source / Code Evidence
  ↓
CANDIDATE
  ↓
Maintainer Review
  ├─ Confirm → ACTIVE
  ├─ Edit → New Candidate Version
  ├─ Supersede
  └─ Deprecate
```

系统不会把“代码碰巧这样写”直接提升为团队规则，也不会自动把 AI 自己的意见写入 ACTIVE Memory。

管理页还支持 [Markdown 与跨项目规则导入](docs/rule-import.md)：先看格式示例或选择来源项目，预览并勾选规则，点击「确认导入并生效」。副本归属目标项目、独立维护，保留真实导入来源；重复项跳过，同名不同内容提示。

## 测试与验证

运行基础测试：

```bash
npm test
```

数据库测试：

```bash
npm run test:db
```

文档链接检查：

```bash
npm run check:docs
```

依赖审计：

```bash
npm audit --audit-level=high
```

### 固定 Review Evaluation

固定样本使用测试仓库指定 SHA：

```text
ad75aa1e1f1a3604682af068c2c048da23bbbe7a
```

运行：

```bash
npm run build
node --env-file=.env eval/evaluate-m2.mjs /absolute/path/to/fixed-checkout [case...] [--runs=3]
```

结果写入：

```text
work/m2-evaluation-pi.json
```

UX / Root Cause / Rule Reference Evaluation：

```bash
node --env-file=.env eval/evaluate-ux.mjs
```

## 项目结构

```text
.
├── frontend/          # 管理界面
├── src/               # 后端与 Agent Runtime（src/pi/ 启动和管理 Pi 进程）
├── agent/             # 服务自有的 Pi AGENTS.md 与 Skills
├── migrations/        # PostgreSQL Migration
├── eval/              # Agent Evaluation
├── test/              # 自动化测试
├── scripts/           # 构建与辅助脚本
├── docs/              # 产品、架构与设计文档
├── .agents/           # Agent 决策与工程上下文
├── compose.yaml
├── package.json
└── README.md
```

## 文档

如果第一次阅读项目，建议按以下顺序：

1. [项目理解指南](docs/project-guide.md) — 从实际 PR 出发理解完整运行流程、数据库、Pi Agent 与核心状态。
2. [PRD](docs/PRD-MVP.md) — 产品目标与范围。
3. [Architecture](docs/architecture.md) — 系统模块与实现分层。
4. [Reliability & Security](docs/reliability-security.md) — 可靠性、安全边界和失败恢复。
5. [PR Review / Team Memory 流程图](docs/diagrams/pr-review-memory-flow.png) — 图形化查看主要闭环。

可编辑流程图：[`docs/diagrams/pr-review-memory-flow.drawio`](docs/diagrams/pr-review-memory-flow.drawio)

## 当前边界

当前实现刻意保持以下约束：

- 可以起多个实例共用一个 PostgreSQL；同一个 PR 的任务串行执行，同仓库不同 PR 可以并行（见 [reliability-security §8](docs/reliability-security.md#8-服务恢复与多实例)）。
- 不承诺 exactly-once；通过幂等、状态机和发布前的远端查询降低重复副作用。
- Team Memory 不是全仓库自动学习系统，ACTIVE 规则必须经过人工确认。
- Health Audit 是有限范围的只读检查，不代表完整代码安全证明。
- Review 质量受模型、Token Budget、Workspace 覆盖范围和规则召回结果影响。

## 项目目标

这个项目关注的不是“让 LLM 多写几条 Review 评论”，而是构建一个可持续运行的团队级代码治理闭环：

```text
Review → Discussion → Decision → Memory → Future Review
```

让一次 PR 中已经确认的工程经验，不再随着 PR 合并而消失。

## 企业微信群内 AI 开发

在管理页「仓库 → 选择仓库 → 群内开发」绑定群与目标分支，设置管理员／开发及文件保护规则。群内 @ 智能机器人发送文字，可附图片；服务创建新分支及 PR，并在原群引用发起任务的消息回复结果。开发命中保护范围时整项拒绝；管理员可发起受保护文件修改，规则继续有效。生成 PR 跳过本服务自动审查，不自动合并。

需要智能机器人 API 长连接的 `WECOM_BOT_ID`、`WECOM_BOT_SECRET`，以及 GitHub App 的 Contents／Pull requests 写权限。审查通知与开发回复复用同一条智能机器人连接；开发回复需在原消息的 24 小时回复期限内完成。升级需手动应用到迁移 007。详细配置、输入限制和发布待核对处理见 [开发接入说明](docs/wecom-development.md)，完成证据与真实验收状态见 [DEV 清单](docs/tasks/DEV.md)。
