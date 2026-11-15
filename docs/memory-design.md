# Pi Repository Governance Agent — Memory Design

版本：v0.1｜日期：2026-09-10

> 本文定义 Team Memory 的数据模型、生命周期、作用域、检索、冲突与 Session 边界。产品目标见 [PRD-MVP.md](./PRD-MVP.md)。

## 1. Memory 的职责

Team Memory 用于保存经确认、可复用、可追溯的长期工程知识。

它不是：

- Agent 的聊天历史。
- 单次 Job 的上下文缓存。
- 任意代码事实的自动摘录。
- 模型高 confidence 输出的自动规则。

Memory Manager 是公共业务模块，负责：

- 保存。
- 检索。
- 权限与仓库边界。
- 状态流转。
- 版本管理。
- 替代与废弃。

Agent 负责理解和提出候选；服务端负责候选是否允许生效。

## 2. Memory 来源

正式候选默认由已合并 PR 触发的 Decision Extractor 产生。

维护者还可通过 [规则导入](rule-import.md) 预览 Markdown 或其他项目的生效规则，再明确确认生效。团队管理员可将 Markdown 导入团队；导入规则归属于所选项目或团队，人工导入不经过模型提取。项目规则的团队提升来源单独记为 `promotion`。

触发条件：

```text
pull_request.closed && merged=true
```

读取：

- 最终代码变更。
- PR 描述。
- Review 意见。
- 人类讨论。
- 可获得的线程状态。
- 与本次合并对应的可靠代码快照。

必须覆盖 merge、squash、rebase 等合并方式；无法还原可靠快照时标记证据不足。

不能使用“稍后默认分支 HEAD”代替该 PR 的真实合并结果。

## 3. 可提取的决策类型

- `architecture_decision`
- `engineering_rule`
- `security_rule`
- `coding_rule`
- `exception`
- `deprecated_pattern`

每条候选必须回答：

1. 决策是什么？
2. 为什么做出？
3. 哪些仓库、路径、模块、语言或条件适用？
4. 哪条人类讨论支撑它？
5. 哪个代码位置支撑它？
6. 它是通用规则、局部例外还是一次性实现选择？
7. 是否与已有规则重复、冲突或构成替代？

不提取：

- 寒暄。
- 重复意见。
- 未定论猜测。
- 仅凭当前代码形式推断出的“团队规定”。

PR 合并或线程 resolved 只能作为上下文证据，不能单独证明形成了通用团队共识。

## 4. Memory 数据模型

| 字段 | 含义 |
| --- | --- |
| id、version | 规则稳定标识与版本 |
| team_id、repository_id | 团队或项目归属，恰好一个非空；团队规则的 installation_id 为空 |
| level | must / should / info，默认 should；随版本确认生效 |
| type、title、content、rationale | 类型、标题、规则正文、决策理由 |
| scope | 仓库、路径、语言、模块、适用条件 |
| source | PR 来源（评论、提交 SHA），或导入来源（文件摘要／原项目规则版本、导入人和时间） |
| evidence | 人类讨论与代码依据，注明明确证据或推断 |
| confidence、uncertainties | 模型自评和不确定因素；人工导入的 confidence 为 null，不伪造模型评分 |
| status | CANDIDATE / ACTIVE / SUPERSEDED / DEPRECATED / REJECTED |
| exception_to、expires_at | 例外对应原规则和可选到期时间 |
| supersedes、superseded_by | 替代关系 |
| approved_by、approved_at | 生效确认者和时间 |
| created_at、updated_at | 创建和更新时间 |

示例：

```yaml
id: MEMORY-038
version: 1
team_id: null
repository_id: <repository-id>
level: should
type: coding_rule
title: Java DTO 字段不使用 Optional
content: 对外接口的 Java DTO 字段不使用 Optional 类型。
rationale: 保持序列化行为和接口表达一致。
scope:
  paths: [backend/**/dto/**]
  languages: [java]
source:
  pull_request: 382
  comment_url: <human-decision-comment-url>
  commit_sha: <verified-merged-snapshot-sha>
evidence:
  - <reviewer-explicit-decision>
  - <matching-final-code-location>
confidence: 0.92
uncertainties: []
status: CANDIDATE
exception_to: null
expires_at: null
supersedes: null
superseded_by: null
approved_by: null
approved_at: null
```

## 5. 状态流转

```mermaid
stateDiagram-v2
    [*] --> CANDIDATE: 合并后提取
    [*] --> ACTIVE: 维护者预览并确认导入
    CANDIDATE --> ACTIVE: 有权限维护者确认
    CANDIDATE --> REJECTED: 拒绝或证据不足
    ACTIVE --> SUPERSEDED: 新规则确认并取代
    ACTIVE --> DEPRECATED: 维护者废弃或到期条件生效
```

规则：

- 模型 confidence 再高也不能绕过 CANDIDATE → ACTIVE 的人工确认。
- 人工导入经独立预览确认后直接生效，并在同一事务记录审计；导入副本后续编辑仍需确认新版本。
- SUPERSEDED 和 DEPRECATED 记录保留用于追溯。
- 新规则激活和旧规则替代应作为一致状态更新，避免同时检索出两条互相冲突的 ACTIVE 规则。
- REJECTED 保留来源和拒绝结果，但不能作为现行团队要求。
- 编辑生效规则产生待确认版本，旧版在确认前继续检索；忽略更新后列表恢复展示原生效版本。
- 新版本号按所有历史版本递增，不重用被忽略的版本号。替代另一条规则时，也同时结束替代规则自身的旧生效版本。
- 替代与普通确认共用例外约束检查；例外不能取代其依赖的原规则。

## 6. 作用域

Memory 必须有明确 scope。

可包含：

- team。
- repository。
- path / path pattern。
- module。
- language。
- framework / technology。
- condition。
- expiration。

规则只有项目与团队两级归属，没有独立的全局或组织层级。全公司基线可由服务管理员创建一个包含相关仓库的团队。团队共享以显式仓库归属为边界，不因为文本或向量相似自动跨仓库引用。

### 6.1 团队与管理权限

`teams` 保存唯一名称、创建人和创建时间；`team_members` 以小写 GitHub login 标识成员，角色为 `admin` 或 `member`；`team_repositories` 保存团队与仓库的多对多归属，一个仓库可以加入多个团队。

`SERVICE_ADMINS` 中的服务管理员负责创建、改名、删除团队、设置仓库归属，以及增删团队管理员。团队管理员或服务管理员可以增删普通成员，管理本团队规则的编辑、确认、忽略、停用和替代，并预览、确认 Markdown 导入。普通成员只展示团队归属，不获得额外规则或仓库管理权限。

项目规则的管理仍按 GitHub 仓库 maintain / admin 权限授权。仓库维护者可以查看所属团队的生效规则、设置项目覆盖和提交提升，但不能直接编辑或批准团队规则。规则详情 API 根据规则归属授权；没有团队管理权限的仓库维护者只能读取适用团队规则的生效版本。写操作沿用登录会话与 CSRF 校验。

### 6.2 项目覆盖

`rule_overrides` 以 `(repository_id, memory_id)` 唯一标识项目对团队规则的覆盖，保存操作、级别、非空理由、操作人和时间：

- `disable`：在本项目停用，级别为空。
- `level`：将本项目级别调整为 must、should 或 info。
- 取消覆盖：必须填写取消理由，删除该项目的覆盖记录，恢复采用团队定义；同一条数据库语句将原覆盖与取消理由写入 `memory_audits` 的 `override-remove` 审计，保留责任人和时间。

覆盖只允许指向该项目所属团队的规则，不修改团队规则的正文、状态或版本。辅助 `team_id` 与仓库归属组成外键，数据库同时检查目标规则归属；仓库移出团队时，其对应覆盖立即删除，重新加入不会恢复旧覆盖。删除团队会级联删除团队规则所有版本、成员、仓库归属、导入预览与项目覆盖；项目原规则及规则审计保留，删除团队不会自动恢复已替代的项目规则。

### 6.3 项目规则提升

仓库维护者选择本项目所属的团队，将 ACTIVE 项目规则的生效版本复制为团队 CANDIDATE。副本保留正文、级别、范围和证据，来源为 `{kind: "promotion", repositoryId, memoryId, version}`；同一团队、同一来源版本重复提交不重复创建候选。创建副本记录 `promote` 审计，项目规则在团队批准前继续生效。忽略提升不改变项目规则。

团队管理员批准时，服务在同一事务中检查来源仓库仍属于该团队，来源版本仍为 ACTIVE，再将团队候选转 ACTIVE、项目原版本转 SUPERSEDED，写入双方的 `supersedes` / `superseded_by` 与 `supersede-old` / `supersede-new` 审计。来源版本已变化或仓库已移出团队时拒绝批准，保留候选供人工处理，不替代未被提升的新版。团队规则后续编辑仍采用普通候选版本流程，不重复提升原项目规则。

项目例外可以关联本项目或所属团队的生效原规则。团队例外只能关联同团队的生效规则；提升项目例外时保留原关联以便追溯，确认前须重新关联团队内生效原规则。例外仍必须限定范围，不能通过替代删除它依赖的原规则。

### 6.4 级别与当前接入边界

每条规则具有 `must`（必须）、`should`（建议）或 `info`（参考）级别。已有规则经迁移统一为 should，Markdown 导入也默认 should；跨项目导入和团队提升保留来源级别。修改生效规则的级别产生候选新版本，批准前旧级别继续有效。项目覆盖的级别独立于团队版本，不改变团队默认级别。

本批仅接入数据、权限和管理页面。Review、Reply、健康检查、开发任务与规则提取的实际取规则查询仍按 `repository_id` 读取项目规则，团队规则、项目覆盖和级别尚不参与任务召回或截断。团队提升批准后，原项目规则已被替代，团队规则要等后续上下文编译器接入才进入任务；因此不应把本批单独上线视为团队规则已开始自动执行。must 全量提供、should/info 按相关度控制体量也属于后续编译器工作。

## 7. 例外规则

例外必须：

- 关联原规则 `exception_to`。
- 明确适用范围。
- 可选设置 `expires_at`。
- 保留来源证据。

一次 PR 中接受的例外不会取消整个团队规则。

如果存在未解决规则冲突：

- Review 应明确指出冲突。
- 展示各自来源和适用范围。
- 请求人类判断。
- 模型不能静默选择其中一条成为最终规范。

## 8. 替代与废弃

### 8.1 替代

新规则取代旧规则时：

```text
Old ACTIVE
  ↓
SUPERSEDED

New CANDIDATE
  ↓ maintainer confirm
ACTIVE
```

同时维护：

- `supersedes`
- `superseded_by`

### 8.2 废弃

规则不再使用但不存在直接替代项时，转为 DEPRECATED。

废弃后：

- 继续保留历史。
- 不参与常规 Review 的现行规则判断。
- 可以在历史解释场景中被人工查看。

## 9. 检索流程

M1 使用 PostgreSQL 保存规则、来源和生命周期。

检索顺序：

```text
授权范围
  ↓
repository / team 边界
  ↓
status = ACTIVE
  ↓
scope / path / language / module
  ↓
内容相关性排序
```

Review 只允许 ACTIVE 且作用域匹配的 Memory 作为团队约定依据。

`conditions` 是自然语言条件，不参与服务端过滤，由 Agent 结合正文判断是否适用。

Review 的选取（`selectReviewMemories`）不按相关性截断：作用域命中改动文件的规则全部带上，未限定作用域的全局规则不要求最低分；选中的例外规则把未选中的 ACTIVE 原规则一并带上。内容相关性排序只在选中规则的 `title + content + rationale` 合计超过 30 000 字符时使用：限定作用域的在前、全局的在后，各自按词重叠分数从高到低、同分按 ID 保留到上限，并在 Review 的 limitations 写明“只带了 N/M 条”。发给模型的规则只保留 `id`、`version`、`type`、`title`、`content`、`rationale`、`scope`、`source`、`exceptionTo`、`supersedes`。代价是每次 Review 的首条提示变长，预算把缓存读取按全额计入，规则多的仓库每轮请求都会多算这部分。

Reply 与健康检查仍按词重叠计分排序后取前 10 条（`retrieve`）。

模型输出中引用的 Memory ID 和 version 必须由服务端再次校验：

- 记录存在。
- 当前用户 / Job 可见。
- repository 匹配。
- status 仍为 ACTIVE。
- version 未过期。
- scope 仍然适用。

## 10. 存储与搜索策略

### 规则使用统计

管理页按规则 ID 汇总所有版本在数据保留期内的 PR Review 使用情况，不设额外的 30 天窗口，不计 Reply、开发任务或健康检查。Review 完成模型输出校验并保存意见时，将实际提供给模型的规则 ID 和版本记入 `review_memory_usage`；同一任务重试时，同一规则只记一次，保留首次记录的版本。`provided` 是其中不同 Review 任务数，表示已完成分析并保存结果，不以 GitHub 发布成功或任务最终状态为条件。未完成分析校验的调用不计入。

`cited` 统计 `review_findings.memory_id` 指向该规则的意见，与概览页“意见去向”采用相同口径：排除 `binding_status='pending'` 的意见和带 `presentation.repeatOf` 的重复意见；引用计意见条数，一次 Review 引用多次也分别计数。按意见当前状态，`fixed` 为 `FIXED`，`withdrawn` 为 `WITHDRAWN`，`exception` 为 `EXCEPTION_PENDING`，`open` 为 `OPEN`、`STILL_VALID`、`NEEDS_CLARIFICATION`；`lastCitedAt` 为符合上述条件的意见中最近的创建时间，无引用时为 null。例外仅表示本次意见的结局，不代表已形成生效团队规则。

没有记录时各项为 0。提供记录从本功能启用后开始积累，不推测历史召回；现存历史意见仍可计入引用，因此历史规则的引用次数可能大于提供次数。删除或按保留期清理 Review 任务时，提供记录与意见随任务删除，统计同步减少。这组数字只用于展示，不改变规则选取、排序或生命周期。

### 搜索策略

M1：

- PostgreSQL。
- 普通关系字段表达替代与例外关系。
- 先做作用域过滤和文本检索。

可选后续：

- pgvector 语义召回。

启用 pgvector 的条件：固定评测样本证明文本检索召回不足。

当前不引入：

- GraphDB。
- 独立 VectorDB。
- 独立 BM25 服务。

## 11. Session 与 Team Memory 边界

| Pi Session | Team Memory |
| --- | --- |
| 一次任务中的对话、工具调用和输出 | 经确认的长期工程知识 |
| 随 Job 建立并按需过期 | 按规则生命周期保存 |
| 用于执行、复核和排障 | 用于后续任务检索和引用 |
| 不同事件默认不共享可变上下文 | 不同任务可访问有权限的共同知识 |

同一个 PR 的后续事件也创建新的 Job，通过数据库中的：

- 原 finding。
- 线程历史。
- 最新代码。
- 当前 Memory。

重新构建上下文。

系统不依赖永久存活的聊天 Session。

## 12. 与 Reply Handler 的关系

M2 中，Reply Handler 处理人类对本 App 行内审查线程的回复。

可能产生：

- 原问题已修复。
- 原审查误判。
- 解释成立，属于有限例外。
- 解释与实现不一致。
- 证据不足。

“接受这次解释”只影响当前 finding，不自动修改 ACTIVE 团队规则。

PR 合并后仍由 Decision Extractor 读取最终代码与讨论，再提出 Memory 候选。

## 13. Memory 验收

| 场景 | 通过条件 |
| --- | --- |
| 明确 DTO Optional 决策的 PR 合并 | 生成 CANDIDATE，包含来源、代码证据、作用域和理由 |
| 维护者确认候选 | Memory 转 ACTIVE，并记录确认者和时间 |
| 后续相关 PR 再次违反 | 成功召回并引用该 ACTIVE Memory |
| 规则被替代 / 废弃 / 拒绝 | 不再作为现行团队要求 |
| 类似代码出现在不相关模块 | 不误召回该规则 |
| 其他仓库存在语义类似规则 | 默认不跨仓库引用 |
| 同一来源重复提取 | 不重复新增相同规则 |
| 没有可复用决策 | 允许 DecisionProposal[] 为空 |
