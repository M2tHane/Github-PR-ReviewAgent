# ARCH 清单：目标架构分阶段实施

设计与理由见 [架构评估与目标架构](../architecture-evaluation.md)。本清单只记录状态、阻塞和完成证据。

## 阶段 0：止血并补上度量

起点：`beea169`（2026-11-15）。

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| ARCH-0-1 | 规则作用域的"条件"不再精确匹配过滤，交给 Agent 按正文判断（Review、Reply、健康检查、开发任务一致） | 已完成（未提交） |
| ARCH-0-2 | 管理接口统一检查仓库白名单与撤销状态 | 已完成（未提交） |
| ARCH-0-3 | 开发任务领取不再依赖企微连接状态 | 已完成（未提交） |
| ARCH-0-4 | 规则提取看得到相关的现有规则；单条候选不合格只丢这一条；管理页可设置例外关联 | 已完成（未提交） |
| ARCH-0-5 | 记录每次 Review 提供了哪些规则；管理页按规则展示引用、修复、撤回 | 已完成（未提交） |
| ARCH-0-6 | 管理页按新输入、缓存读取、缓存写入、输出分开显示用量 | 已完成（未提交） |

阶段验收（来自设计文档）：

- 带条件的规则能被召回，有回归测试。——已满足（ARCH-0-1）。
- "例外"候选从线索到批准端到端走得通。——服务端各段已打通并有测试：提取器可引用现有规则给出 `exceptionTo`（ARCH-0-4 提取部分），管理页可补关联并批准（ARCH-0-4 管理页部分，含页面实操）；未用真实模型从真实 PR 讨论跑过一遍。
- 积累两周真实的按规则统计的修复率和撤回率。——待上线后观察，本地无法完成。

## 阶段 1：统一执行引擎

起点：`efd0d79`（2026-11-15）。设计见 [执行引擎决策](../../.agents/decisions/execution-engine.md)：沿用 `jobs` 执行器作为唯一执行器，开发任务作为另一个任务来源接入；不另建通用 run/step 表。

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| ARCH-1-A | 开发任务由统一执行器在 worker 上领取（租约、心跳），和企微解耦；重启和部署不再取消任务；去掉"目标分支有新提交就放弃" | 已完成（`d477ef6`，合并 `03040e5`） |
| ARCH-1-B | 开发任务补丁快照与接手续做；开发分支、提交、PR、issue 评论走副作用台账，发布中断后核对远端再继续 | 已完成（`c8729fa`、`ee51c09`，审查修复 `8879f49`）；真实 GitHub／模型演练未做 |
| ARCH-1-C | 不经企微派任务：管理页／管理 API、给 issue 打 `pi-dev` 标签；仓库可以不绑群 | 已完成（`f51d9ad`，合并 `c2ad48f`） |
| ARCH-1-D | 进程角色 `PROCESS_ROLE`（edge、worker、all），部署说明 | 已完成（`c0536d1`）；真实滚动部署未验收 |
| ARCH-1-E | 线程回复加隐藏标记与发布前核对，中断后不重复回复；Review／Reply／规则提取的中断回归测试 | 已完成（`37e957c`，合并 `c72d824`） |

阶段验收（来自设计文档）：

- 在每个步骤上杀掉 worker，GitHub 上都没有重复写入，任务能接着做。
- 部署期间，一个 30 分钟的开发任务不会丢。
- 不经过企微也能派任务（管理页、API、Issue 标签）。

## 阶段 2：团队级知识模型与上下文编译器

起点：`df93826`（2026-11-15）。设计见 [团队规则决策](../../.agents/decisions/team-memory.md)。

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| ARCH-2-A | 不重启就能接入新仓库（服务管理员在管理页接入）；管理页的 GitHub 权限检查加缓存 | 已完成（`23831f0`）；真实 GitHub 安装清单未验证 |
| ARCH-2-B | 团队、团队成员、团队规则；项目覆盖（停用／调整级别，写理由）；规则级别 must／should／info；项目规则提升为团队规则 | 已完成（`b0e888a`）；团队规则要等 2-C 才进入审查 |
| ARCH-2-C | 上下文编译器：项目规则 + 所属团队规则 − 覆盖，例外按路径生效，项目差异通过例外或停用覆盖表达；各类 Agent 共用规则入口 | 已完成（`4db020a`）；Review 这一批仍只给全文，索引按需读取留给 2-G |
| ARCH-2-E | 规则复查队列：噪声大、沉睡、路径失效、到期；合并时推断"疑似已修复"（和开发者确认的修复分开统计） | 已完成（`3587c59`）；真实 GitHub 未验收 |
| ARCH-2-F | 召回评测集（确定性）和提取评测集（真实模型，先放 6 个样例） | 评测入口完成（`648ace7`）；真实合并 PR 标注集待用户提供 |
| ARCH-2-G | Review 先给规则索引、按需读全文；服务核对适用的 must 规则是否都检查过（改 Prompt，要用真实模型回归） | 待做（依赖 2-C） |
| ARCH-2-H | 把团队规则提供给本地 Codex／Claude Code：规则变化时由服务提 PR 更新仓库里的规则文件，并在 AGENTS.md／CLAUDE.md 引用（用户 2026-11-15 选定，不做 MCP） | 待做（依赖 2-C） |

阶段验收（来自设计文档，数值是初始目标）：

- 规则提取评测集（至少 30 个人工标注的合并 PR）准确率 ≥ 0.7。——目前只有 6 个样例，真实标注需要用户提供。
- 规则召回评测集在给定体量预算下覆盖率 ≥ 0.9。
- 跨项目订阅（团队规则）和项目覆盖都能生效。
- 噪声大的规则会被自动标出。

评测的运行方法、评分口径和适用限制见 [评测说明](../../eval/README.md)。

## 不做的项

- 隔离与多团队门槛（独立系统用户、容器隔离、攻防测试、两个 GitHub App）：用户 2026-11-15 决定，服务只在公司内部使用，不做。
- 阶段 3（开发闭环 v2）：用户 2026-11-15 决定先不做，集中做好阶段 1、2；"团队规则提供给本地 AI 工具"并入阶段 2（ARCH-2-H）。

## 证据

基线（2026-11-15，`beea169`）：`npm test` 171 通过、0 失败、71 跳过（数据库用例）；`npm run test:db` 72 通过、0 失败。

**ARCH-0-1**（2026-11-15）

- 根因：`scopeMatches` 要求规则的每个条件字符串都出现在调用方传入的数组里；Review 固定传空数组，Reply／健康检查经 `rankMemories` 也是空数组，带条件的规则即使路径命中也被过滤。开发任务传入规则自己的条件，等于恒为真。
- 改动：`scopeMatches` 只按路径、语言、模块匹配，条件随规则文本交给 Agent；`docs/memory-design.md` 第 9 节补充说明。未改 Prompt 和 Skill。
- 验证：`npm run build && node --test dist/test/review/heuristics.test.js dist/test/development/rules.test.js` 12/12 通过（修复前新增用例 2 处失败）；`node --env-file=.env --test dist/test/memory/database-memory.test.js dist/test/memory/database-import.test.js` 7/7 通过。
- 限制：没有用真实模型验证 Agent 对条件文字的判断质量；条件规则重新进入召回后，输入 token 可能增加。

**ARCH-0-2**（2026-11-15）

- 根因：管理列表和单仓库授权只看 GitHub 维护权限，没有检查服务白名单和 `revoked_at`；只有三个路由各自补了白名单检查，且在调用 GitHub 之后。
- 改动：`allowedRepositories` 先排除已撤销仓库并按白名单过滤，再查 GitHub 权限；`authorize` 在调 GitHub 前对白名单外或已撤销的仓库返回 403「仓库未授权」；删除三个路由里重复的检查。暂停安装（`enabled=false`、未撤销）的仓库照常可管理。
- 验证：`npm run build && node --test dist/test/admin/admin.test.js dist/test/admin/service-settings.test.js` 4/4 通过；`node --env-file=.env --test dist/test/admin/database-admin.test.js` 4/4 通过（新增子用例覆盖列表、8 个单仓库接口、拒绝时不请求 GitHub、暂停仓库可管理、仓库名大小写）。
- 说明：首次复核时本机 PostgreSQL 容器被外部进程停止，导致连接被拒；重启后重跑通过，与改动无关。

**ARCH-0-3**（2026-11-15）

- 根因：开发 Worker 把"领取任务"和"发送企微完成通知"放在同一个 `authenticated` 条件下，企微未认证时不会领取已排队任务（包括来自 GitHub issue、PR 评论的任务）。
- 改动：领取循环不再依赖企微认证，仍受 leader 锁、连接探活、并发上限和停止信号约束；通知循环仍要求已认证。
- 验证：`npm run build && node --env-file=.env --test dist/test/development/database-development.test.js` 25/25 通过；新增用例覆盖"未认证时任务执行完成、通知保持 pending，认证后通知发出一次"。

**ARCH-0-4（提取部分）**（2026-11-15）

- 根因：提取器只拿到 PR、讨论和线索，看不到现有规则和 ID，模型给出的替代／例外关系只能靠猜；冲突关系被丢弃；任一条候选不合格就整批报错，合格候选也不保存。
- 改动：用 `retrieveForReview` 按改动文件取相关的生效规则作为 `existingRules` 交给模型；关系只能引用这些规则的 id，否则丢弃该条；`duplicateOf` 去掉；冲突关系转成一条不确定因素保存；逐条校验，丢弃数量和原因类别写进 `decisions_extracted` 日志。可选字段的 null 按未提供处理（验收时发现首版会误丢，已返工）。
- 验证：`node --test dist/test/memory/decision.test.js` 11/11；`node --env-file=.env --test dist/test/memory/database-memory.test.js dist/test/memory/database-import.test.js` 8/8；`npm run test:db` 77 项中 76 通过。
- 失败一项的说明："开发 PR 的评论…" 用例在全量运行中失败一次，单独连跑 3 次均通过。原因是测试用 Node 时钟生成评论时间、用 PostgreSQL `now()` 记录任务开始时间，两边时钟有毫秒级偏差时"是否新评论"的判断会翻转；与本阶段改动无关（改动没有涉及这段逻辑，基线全量运行时该用例通过）。
- 附带修复：ARCH-0-2 之后 `database-import` 的导入 API 用例因测试配置缺少白名单返回 500，已补测试配置（只改测试）。
- 限制：Prompt 改动没有用真实模型回归（提取器不在现有 eval 覆盖范围内），模型是否按 existingRules 正确去重未验证。

**ARCH-0-4（管理页部分）**（2026-11-15）

- 根因：PATCH 接口和 `CandidatePatch` 不接受 `exceptionTo`，提取出的例外候选没有关联原规则时，管理页无法补上，`validateException` 永远拒绝批准；普通批准不看候选的 `supersedes`，批准后旧规则仍生效，出现两条互相冲突的生效规则。
- 改动：PATCH 可设置或清空 `exceptionTo`（必须是同仓库的其他规则，否则 422）；编辑生效规则生成的新版本使用新值。批准时如果 `supersedes` 指向本仓库仍生效的规则，在同一事务里完成替代并记 `supersede-old`／`supersede-new` 审计；目标已不生效时按普通批准。替代逻辑从原 `supersede` 抽成共用函数。例外类型的编辑表单增加"例外于"下拉；详情的"适用范围"显示"例外于／替代"的规则标题，找不到时显示 id。
- 验证：`npm run build && node --test dist/test/admin/admin.test.js` 3/3；`node --env-file=.env --test dist/test/memory/database-memory.test.js dist/test/memory/database-import.test.js dist/test/admin/database-admin.test.js` 19/19；`npm run test:db` 84/84 通过。
- 页面（本地预览：临时 schema + 真实 `createAdminHandler` + 替身登录和 GitHub，1600 与 1024 宽）：同仓库没有其他生效规则时只有"不关联"并提示批准前需关联；181 字符无空格标题在下拉里截短、下方完整换行、详情里换行无横向溢出；关联已不存在的规则时显示"当前关联不可选"和原 id，不改选则保留原关联。经页面实际操作：例外候选选择关联→保存→批准成功；带 `supersedes` 的候选批准后旧规则变为 SUPERSEDED、`superseded_by` 正确。
- 限制：下拉按列表顺序列出全部生效规则，规则很多时没有搜索。

**ARCH-0-5**（2026-11-15）

- 改动：新增迁移 `014_review_memory_usage.sql`，Review 结果通过校验、保存意见后，把实际交给模型的规则（截断后的 `recalled`）按任务写入，重试不重复，任务删除时级联删除。规则列表接口每条带 `usage`：提供次数按不同 PR Review 任务计；引用和结局按意见计，口径同概览页"意见去向"（已绑定、不含重复项），不加 30 天窗口，汇总规则的所有版本。列表底部小字显示"引用 N 次 · 修复 a · 撤回 b"，详情增加"使用情况"一节；从没生效过的待确认规则两处都不显示。`docs/memory-design.md` 补充口径说明。
- 验收时主脑调整：codex 首版把列表的用量放在单独一行、用正文字号，每张卡片多一行，全新待确认规则也显示"引用 0 次"；详情 7 个数字竖排约 420px；数字没有千分位。改为放进底部信息行、详情用 4 列网格、用 `numberText` 加千分位，并对从没生效过的待确认规则隐藏。
- 验证：`npm run build && node --env-file=.env --test dist/test/memory/database-memory.test.js dist/test/admin/database-admin.test.js dist/test/review/database-repeats.test.js dist/test/persistence/database-retention.test.js` 20/20；`node --test dist/test/review/publication.test.js` 6/6；`npm run test:db` 87/87；前端调整后 `node --test dist/test/frontend/client.test.js dist/test/admin/admin.test.js` 4/4，`npm run check:format` 通过。
- 页面（本地预览，真实管理页 + 临时 schema，1600 与 1024 宽）：生效但从没被提供的规则显示全 0 和"暂无引用"；提供 12 次、未被引用的显示"提供给审查 12 次"其余为 0；4,303 次引用、2,757 未结按千分位完整显示，详情无横向溢出；待确认列表里只有"待确认更新"（有生效版本）显示用量。
- 限制：上线前的历史审查没有提供记录，历史规则的引用次数可能大于提供次数；按规则的真实修复率、撤回率需要上线后积累两周再看。

**ARCH-0-6**（2026-11-15）

- 改动：`frontend/format.ts` 新增 `usageText`／`usageTotal`，按"新输入、缓存读取、缓存写入、输出"列出用量，数字用 `numberText` 加千分位，缺的字段显示"—"，旧记录回退到 `usage_input_tokens`／`usage_output_tokens`。执行详情、开发任务列表、健康检查报告共用。不显示金额，未改后端和预算计算。
- 验收时主脑调整：codex 首版把分项接在"用量 / 预算"半栏里，"缓存读取"会在字间折断；没有用量的开发任务也显示一整行破折号，且用深色正文。改为分项单独占一行（`.agent-run-usage` 跨两栏），标签与数字之间用不换行空格、`.usage-text` 只在"·"两侧换行；没有任何用量时不显示分项行，开发任务的用量行改为浅色。
- 验证：`node --test dist/test/frontend/client.test.js` 5/5（新增全有、全无、只有旧字段、大数字 4 个用例）。
- 页面（本地预览，1600 与 1024 宽）：执行详情 `2,280,336,879 / 2,147,483,647 tokens`，下一行"新输入 123,456,789 · 缓存读取 2,147,483,647 · 缓存写入 4,640,000 · 输出 9,876,543"只在分项之间换行；没有用量的执行只显示"— / 160,000 tokens"。开发任务：分项齐全时"用量：11,602 tokens · 新输入 1,234 · 缓存读取 2,345 · 缓存写入 3,456 · 输出 4,567"；只有总数时"用量：1,200 tokens · 新输入 — · …"；没有用量不显示；20 亿级数字无横向溢出。

**阶段 0 结束检查**（2026-11-15，基于 `beea169` 的未提交改动）

- `npm test`：256 项，181 通过、0 失败、75 跳过（数据库用例，基线 171 通过、71 跳过）。
- `npm run test:db`：87 项全部通过（基线 72 项）。
- `npm run check:docs`：35 个 Markdown 文件、304 个本地链接和锚点通过；`npm run check:format`、`git diff --check` 通过。
- 未运行：`npm audit`（本阶段没有改依赖）；真实模型、真实 Webhook 和 GitHub 发布验收（本阶段没有改 Review Prompt，提取器 Prompt 不在现有 eval 覆盖范围）。

**ARCH-1-A**（2026-11-15，`d477ef6`）

- 改动：`PersistentRunner` 改为从任务来源领取（`TaskSource`：claim／renew／finish／fail／release／describe），jobs 与开发任务各一个来源、各自的并发设置。开发任务有租约和心跳，领取不再看 Bot ID；租约过期由其他实例接手（attempt+1，第 4 次过期标 failed）；停止时放回队列、不计次数、不写取消结果和通知。企微 Worker 只收消息、回执、发通知。`config.development` 总是存在，企微凭据改为可选的 `development.wecom`。删除"确认目标分支没有新提交"。迁移 `015_development_lease.sql`。
- 合并时主脑补：`job_failed`／`job_released` 日志恢复任务类型、仓库、PR、SHA、尝试次数（首版只剩 jobId）。
- 验证：分支上 `npm test` 178 通过、0 失败；`npm run test:db` 97/97。新增用例覆盖无企微执行、停心跳后接手与旧实例隔离、第 4 次过期失败、停止回队（四类任务）、跨实例串行、心跳发现取消后中止、目标分支推进仍以原基线发布。

**ARCH-1-C**（2026-11-15，`f51d9ad`）

- 改动：迁移 `016_development_sources.sql`（`source`、`requester_login`，企微相关字段可空，群绑定可空）。管理 API `POST /api/repositories/:id/development/tasks`（会话 + CSRF + 维护权限；`SERVICE_ADMINS` 内为 admin，否则 developer）和页面上的"新建开发任务"；`issues.labeled` 且标签为 `pi-dev`、发起人对仓库有写权限时入队（developer），按 delivery 和 issue 去重；这两类来源不发企微通知，标签来源的结果贴回 issue。GitHub App 需要订阅 Issues 事件。
- 决定：不新增机器令牌，"API"即管理 API；程序化派任务用 GitHub API 打标签。
- 验证：分支上 `npm test` 179 通过；`npm run test:db` 94/94；页面在 1600／1024 宽看过未启用、12,000 字需求、issue #2147483647（主脑复核了截图）。合并后主脑补了"执行器领取管理页任务（无 Bot）并完成"的端到端用例。

**ARCH-1-E**（2026-11-15，`37e957c`）

- 根因：线程回复发出后、记账前实例退出时，台账没有结果、正文也没有能定位到具体来源评论的标记，接手实例会重跑 Agent 再发一条；网络错误直接标 uncertain 终态。
- 改动：回复正文加 `<!-- pi-reply:<sourceCommentId> -->`，发出前先把结果存进 `reply_publications`（pending）；接手时按线程根评论、Bot 作者、标记三项核对，找到就只补记账，找不到就用存好的结果发布，都不重跑 Agent；网络错误按错误分类重试，核对也做不到且尝试用完才 uncertain。
- 验证：修复前新增用例中"回复已发出未记账"得到 2 条回复（失败），修复后中断用例 30/30；Review（Agent 中、建 Review 后未记账、记账后未结束）与规则提取（候选写入后未结束）的中断用例确认现有台账已能防重。

**阶段 1 第一批合并后**（2026-11-15，`03040e5`）：`npm test` 282 项，182 通过、0 失败、100 跳过（数据库用例）；`npm run test:db` 135/135；`check:docs`、`check:format` 通过。

**ARCH-1-D**（2026-11-15，基于 `03040e5`，分支 `arch/p1-d-roles`）

- `PROCESS_ROLE=edge|worker|all`，未设置默认 `all`，非法值启动报错。edge 只启动 HTTP 与企微收发；worker 启动两个执行器、健康定时入队、清理和漏投递补偿，HTTP 仅保留 `/healthz`、`/readyz`；all 同时承担两者。
- 两种角色均读取服务设置并每 30 秒刷新。edge 连接池上限 5，worker / all 为 `5 + 3 × (审查等任务并发 + 开发并发)`，动态设置同时调整池上限与执行器。设置页的说明注明生效角色；README 和 `.env.example` 补齐角色、探针、同库部署与先起新 worker 再停旧 worker 的发布步骤。
- SIGTERM／SIGINT 复用执行器原有停止回队逻辑，等 HTTP、企微、执行器与定时工作收尾后关闭数据库；重复信号不重复调用停止。临时目录清理也纳入等待。未改任务领取、快照、副作用或迁移。
- 相关验证：`npm run build && node --test dist/test/bootstrap/application.test.js dist/test/config/config.test.js dist/test/config/service-settings.test.js dist/test/admin/service-settings.test.js dist/test/github/webhook.test.js`，30/30 通过。7 个新组装用例使用替身执行器、数据库、企微和定时工作，HTTP 使用真实临时端口；覆盖三种角色、业务路由隔离、设置与连接池更新、停止后的定时器、两种信号和请求／发送收尾。
- 全量：`npm test` 首次 185 通过、1 失败、103 跳过，失败为未修改的 Pi CodeGraph 索引用例达到 10 秒时限；单独复跑该用例通过（索引 1,273ms）。再次 `npm test` 186 通过、0 失败、103 跳过，耗时 51.43 秒。`npm run test:db` 使用本机 PostgreSQL 临时 schema，135/135 通过、0 跳过，耗时 80.36 秒，包含既有停止回队、租约接管与探针用例。
- `npm run format` 通过（201 个文件，格式调整 2 个本次改动文件）；`npm run check:docs` 通过（36 个 Markdown、307 个本地链接与锚点）；`npm run check:format`、`git diff --check` 通过。
- 容量影响：默认并发 2 + 3 时 worker / all 池上限 20；拆分为一个 edge 与一个 worker 时总上限 25，滚动时还需计入旧实例。每个额外实例增加每 30 秒一次的设置查询，edge 不领取任务或跑后台定时任务。未做负载压测、内存或延迟测量。
- 限制：未启动连接真实队列的 main，未连接真实 GitHub、模型或企微；没有真实 30 分钟任务滚动发布证据。ARCH-1-B 的快照与副作用恢复、整个阶段 1 的部署验收不在本项完成范围内。没有新增依赖，未运行 `npm audit`。
- 新增拒绝路径：非法 `PROCESS_ROLE`（含空值）启动报错，依据本项明确配置要求；worker 的非探针 HTTP 路径返回 404，依据 worker 只对外提供探针的要求。

**ARCH-2-F**（2026-11-15，基于 `e4bc57c`）

- 改动：`eval/recall/cases/` 新增 16 个召回样例，`eval/extraction/cases/` 新增 6 个合成提取样例；召回入口调用现有 `selectReviewMemories`，保留可切换适配器与索引覆盖指标；提取入口在临时固定 Git 快照中调用现有 Pi 会话与 `parseDecisionProposals`，唯一生产源码变化是导出原 `SYSTEM_PROMPT`，内容和行为不变。评分支持关键词组、精确类型、关系目标和一对一匹配，失败、丢弃、未知消耗单独记录。运行方法见 [评测说明](../../eval/README.md)。
- 召回：`npm run build && node eval/evaluate-recall.mjs` 成功执行，16 个用例的全文/可见覆盖均为 52/85（61.18%），全文正文预算口径总计 185,581 字符，完整规则 JSON 载荷总计 265,662 字符。缺失 33 条均来自预算截断；最差三个用例为 `15-service-model-overflow`（截掉 20 条）、`11-model-over-budget`（10 条）、`12-global-starvation`（2 条）。当前没有索引输出；没有修改召回逻辑来提高成绩。
- 提取：`node --env-file=.env eval/evaluate-extraction.mjs --runs=3` 实际调用 `tuzi / gpt-6.1-sol`（high，openai-completions），18 次合计 458.920 秒，TP=5、FP=3、FN=4，精确率 62.5%、召回率 55.56%。13 次完整符合期望，2 次上游连接/断流失败，例外用例 3 次都把 `exceptionTo` 放到顶层而非 `relation.exceptionTo`，因此不计命中。已记录实际 token 67,131（输入 18,783、输出 5,468、缓存读 42,880、缓存写 0），未知预留 136,553 单列，不能当作零或实际 token。
- 串行复核：AI-only 与 supersedes 用例各再跑 3 次，输出分别写入 `work/extraction-ai-recheck.json`、`work/extraction-supersedes-recheck.json`，未覆盖首跑。每组均 2 次正确、1 次上游失败；合计增加 158.401 秒、实际 token 16,130、未知预留 177,619。首批及复核共 24 次、617.321 秒、实际 token 83,261、未知预留 314,172。没有因接口不稳定改用替身或放宽评分。
- 固定样例 SHA：支付相关 4 个用例 `7a7820fbf05c24121abdcac1d54f012de8b756f8`；例外 `0377c659c514a446f881a6a35eeefb16c8da68a3`；替代 `62e12ecb5df2fef04c1ae35e9570b4adf36eb48e`。角色为 Decision Extractor；这是本地合成快照，没有真实 delivery、Job、finding、Review 或 reply URL。
- 验证：`npm test` 首跑 178 通过、1 失败、103 跳过，唯一失败为 CodeGraph 构建索引超过测试的 10 秒限制；随即 `node --test --test-concurrency=1 dist/test/*/*.test.js` 串行全量重跑 179 通过、0 失败、103 跳过。`node --test eval/metrics.test.mjs` 7/7 通过；`npm run format`、`npm run check:docs`（36 个文件、308 个本地链接与锚点）、`git diff --check` 通过。`--max-chars=100000` 复核覆盖 85/85；临时索引适配器验证 `--adapter` 切换后全文仍为 52/85、可见覆盖为 85/85，仅验证接口与指标，没有实现生产上下文编译器。
- 限制：缺少至少 30 个人工标注的真实合并 PR，阶段 2 提取质量未验收。关键词匹配不判断完整语义、否定和 Scope 正确性。评测绕过无人类讨论时的生产提前结束分支，直接测试 Prompt 与解析结果；不覆盖 GitHub 取数、入库和审批。数据库代码和依赖未改，本任务不跑 `test:db` 或 `npm audit`。
- 例外关联修复（2026-11-15，基于 `d1cf0fc`）：根因是提取 Prompt 的 JSON 模板没有 relation，模型把 `exceptionTo` 写在顶层，入库只读 `relation.exceptionTo`，关联丢失。Prompt 补一句 relation 与 scope 同级的写法；`parseDecisionProposals` 把顶层的 supersedes／exceptionTo／conflictsWith／duplicateOf 移进 relation 后照常校验 id（relation 里已有的同名字段优先）。`node --test dist/test/memory/decision.test.js` 12/12、`node --test eval/metrics.test.mjs` 7/7。真实模型重跑 `node --env-file=.env eval/evaluate-extraction.mjs --runs=3 --output=work/extraction-relation-fix.json`（`tuzi / gpt-6.1-sol`，Prompt SHA256 `a4505462…`）：18 次 346.7 秒，TP=7、FP=0、FN=2，精确率 100%、召回率 77.78%；两个 FN 都是上游 502（ECONNRESET），其余 16 次完全符合期望。例外用例成功的 2 次模型都直接写在 `relation` 里，未依赖解析兜底。实际 token 60,677，未知预留 266,854 单列。

**ARCH-2-A**（2026-11-15，基于 `df93826`，分支 `arch/p2-a-onboarding`，提交 `23831f0`）

- 迁移 `018_repository_onboarding.sql` 给 `repositories` 加 `allowed`、`allowed_by`、`allowed_at`。`.env` 白名单是固定基线（允许为空），`RepositoryAccess` 把基线和数据库里已接入、未撤销的仓库取并集，原地写入 `config.allowedRepositories`；三种进程角色启动读一次、之后每 30 秒读一次，接入／移出后立即重读。运行中读取失败保留上次结果并记日志；启动时读取失败直接报错。
- 服务设置页新增"仓库接入"（仅 SERVICE_ADMINS）：从 App 安装清单发现仓库（含未发过 PR 事件的），开关接入；配置基线仓库只读，已撤销仓库不能接入。移出只改白名单，不改仓库原有启停；运行中的任务按原有发布前检查停止。
- 管理页 GitHub 维护权限缓存：有权限 5 分钟、无权限 1 分钟，按登录会话区分，退出清除；GitHub 报错不缓存。
- 验证（实施者）：`npm test` 191 通过、0 失败、104 跳过；`npm run test:db` 136/136；页面在 1600／1024 宽下看过 60 个仓库、约 300 字符长名称、0 个仓库、混合来源和撤销状态，并实际点击接入→移出→刷新。
- 验收（合并到 `feat/integration` 后）：`node --test dist/test/admin/*.test.js dist/test/config/*.test.js dist/test/bootstrap/*.test.js dist/test/memory/decision.test.js` 32 通过、2 跳过；`node --env-file=.env --test dist/test/admin/database-onboarding.test.js dist/test/admin/database-admin.test.js` 6/6。看过 60 仓库 1024 宽和 0 仓库 1600 宽截图。
- 限制：没有调用真实 GitHub 安装清单、没有测试真实权限撤销；暂停的 installation 只能显示本地已有仓库。

**ARCH-1-B**（2026-11-15，`arch/p1-b-resume`；首版 `c8729fa` 及其后续修订）

- 改动：迁移 017 保存开发副作用台账、gzip 补丁快照、最终提案、最新评论时间和历史执行耗时基数。develop/revise 从固定基线恢复快照；已有提案跳过 Agent，commit 台账已完成时不建工作区，直接核对并继续发布。discuss/notice 的评论同样按台账和本 App 标记核对。
- 故障回归：开发 Agent 运行中、proposal 后、commit 台账写入而 head 未落盘、分支后、PR 后分别过期旧租约并由另一个 PersistentRunner 接手；最终均只有 1 个分支和 1 个 PR。分支/PR/issue/评论已经在 GitHub 替身生效但响应丢失时，不重复写入。commit 未落台账时允许重做无引用提交，只引用最终提交。
- revise 回归：proposal、commit、推送、回复各步骤中断后恢复，分支只推进一次、回复只发一条；保持 Agent 实际见过的评论游标，恢复期间新到的评论不会被记作已处理。
- 快照回归：虚拟时钟验证每 5 分钟保存，真实 stop 验证最后快照落库后放回；旧 owner 不能覆盖接手实例的快照。31 个 700 KB 随机文件不受发布限制影响，gzip 约 21.8 MB 时清除旧快照并从头完成。覆盖新增、删除、可执行位、忽略文件及父目录符号链接拒绝。
- 根因修复：`lastRevisionAt` 原来混用 PostgreSQL `started_at` 和 GitHub `created_at`，现在只比较已成功处理的 GitHub 评论时间；早/晚 5 秒两个用例均通过。恢复时不重置 token/未知预留与执行时间，排队不计时；发布失败重排增加尝试次数，到上限才 uncertain。不同 SHA 分支停止并提示人工核对。
- 审查修复前验证（`ee51c09`）：`npm test` 306 项，181 通过、125 跳过、0 失败（39.20 秒，普通命令未加载数据库）；随后 `npm run test:db` 157/157 通过，0 跳过（106.43 秒）。定向恢复、长评论分页核对与执行权边界测试均通过。GitHub 和模型均为替身，临时 schema 在结束后删除；无真实 delivery/Job/finding/Review/reply URL。developer 用量累计断言为 150+150=300 tokens，revision 为 120 tokens，均非真实模型耗费。
- 审查修复前开销估算：普通 commit/ref/PR 每步约增加 6 次短 SQL；快照多遍历工作区并编码压缩一次，峰值内存随改动量增长，未做生产压测。硬崩溃最多丢失最近约 5 分钟未保存改动（保存故障另记日志），耗时保守计到租约截止；正常 stop 等待最终快照。新 issue 核对最近 100 个，评论完整分页。未运行真实 GitHub/模型、真实 Webhook、跨物理机器或 OS kill 演练；未修改进程角色拆分相关文件。
- 收尾检查：全量后 `npm run format` 检查 201 个文件，无需修改；`npm run check:docs` 36 个 Markdown 文件、306 个本地链接与锚点通过；`npm audit --audit-level=high` 为 0 vulnerabilities；`git diff --check` 通过。

**ARCH-2-B**（2026-11-15，基于 `e4bc57c`，分支 `arch/p2-b-teams`，提交 `b0e888a`，合并 `c126221`）

- 迁移 `019_teams.sql`：`teams`、`team_members`（admin／member）、`team_repositories`；`memories` 加 `team_id`、`level`（must／should／info，默认 should），`repository_id` 与 `team_id` 恰好一个非空；`rule_overrides`（停用或改级别，理由必填，仓库移出团队时级联删除，触发器核对规则属于该团队）；导入预览可归属团队。
- 管理：服务管理员建团队、设仓库和团队管理员；团队管理员管成员与团队规则（编辑、确认、忽略、替代、停用、Markdown 导入）。项目维护者在规则详情里对团队规则做本项目覆盖，设置和取消都要写理由并记审计。项目 ACTIVE 规则可提升为所属团队的候选，团队管理员批准时原项目规则在同一事务转为已替代。
- 这一批不改取规则：Review、Reply、健康检查、开发任务、提取仍只取项目规则，有专门断言。**提升批准后原项目规则已替代、团队规则尚未进入审查**，2-C 合并前不能部署。
- 验证（实施者）：`npm test` 179 通过、0 失败、104 跳过；`npm run test:db` 143/143；页面在 1600／1024 宽看过 30 个团队、长团队名、0 仓库、一个仓库属于 5 个团队、长覆盖理由、三种级别，实际操作了提升→改级别→批准、覆盖设置与取消。
- 验收（合并后）：`node --test dist/test/admin/*.test.js dist/test/memory/*.test.js dist/test/review/*.test.js dist/test/reply/*.test.js dist/test/github/*.test.js` 91 通过、22 跳过；`node --env-file=.env --test dist/test/admin/database-*.test.js dist/test/memory/database-*.test.js` 31/31。看过团队列表、规则列表、覆盖详情截图。
- 遗留：选了仓库后，规则列表里的团队规则仍显示团队级别，没有标出本项目的覆盖（详情里有），放进 2-C。


**ARCH-1-B 审查修复**（2026-11-15，基于 `ee51c09`）

- 任务行锁覆盖每次台账写入、GitHub 核对/写请求与快照保存。pending 意图先独立提交，后续请求和 done 记账在同一持锁事务；过期扫描、领取均跳过锁住的任务。旧 owner 的在途请求、检查后暂停的记账和等待冲突行锁的快照 SQL，都不能与接手者重叠。
- 领取、处理器准备阶段和失败重排均依据持久化 pending/done 台账识别发布阶段；取 token 失败也重排并增加 attempt，耗尽才 uncertain。原有分支冲突人工核对行为保留。
- 迁移 `021_development_revision_cursor.sql`（分支上原名 018，合并时为避开 `018_repository_onboarding.sql` 改名）增加评论边界秒内的已处理身份集合（种类 + ID），与提案一起保存；同秒后到评论仍为 new，恢复期间不推进到未处理的评论。不同评论种类共用数字 ID 不互相遮蔽。
- 修前命令 `npm run build && node --env-file=.env --test dist/test/development/*.test.js`：79 通过、5 失败、0 跳过（60.69 秒），失败项恰为审查 1–5。修后同命令：88/88 通过、0 跳过（53.76 秒）；保留全部原恢复用例，额外覆盖 discuss/notice/revise 准备失败和尝试耗尽、同秒恢复及跨种类 ID。
- 并发用例采用真实 PostgreSQL 临时 schema，自然等待 1 秒租约到期；分别阻塞远端替身请求、记账 SQL 和快照冲突行。旧恢复用例改成先让请求抛中断、事务退出后再过期租约；PR 创建请求与 Webhook 并发，回调等待请求释放任务锁，保留回调先到的免审查验收。
- 新增的拒绝路径：快照保存/超限清理时，失效 owner 或过期租约抛 `TaskLeaseLostError`，依据本次已定修法；副作用沿用同一执行权拒绝规则，无新产品输入校验。
- 性能：一次首次成功的副作用包含 2 个事务、6 条业务 SQL、4 条 BEGIN/COMMIT；快照写入为 1 个事务、2 条业务 SQL、2 条 BEGIN/COMMIT，gzip 在锁外。每个在途操作占用一条连接，心跳和同任务回调更新可能等待；GitHub 请求数不增加。未测生产延迟、内存和吞吐。
- 限制：未运行真实 GitHub/模型、真实 Webhook、OS kill 或跨机器演练；无真实 delivery/Job/finding/Review/reply URL。模型为 developer/revision/discussion 替身，usage 只验证累计。锁不能撤销客户端超时后远端仍可能执行的请求，继续遵守不承诺 exactly-once 的边界。未改进程角色拆分文件，未 push。
- 最终顺序验证：`npm test` 315 项，181 通过、134 跳过、0 失败（65.46 秒，普通命令未加载数据库）；随后 `npm run test:db` 166/166 通过、0 跳过（177.24 秒）。`npm run format` 检查 202 文件、格式化 5 文件；`npm run check:docs` 检查 36 文档/306 链接通过；`npm audit --audit-level=high` 为 0 vulnerabilities；`git diff --check` 通过。

**ARCH-2-E**（2026-11-15，基于 `248d3ce`，分支 `arch/p2-e-review-queue`）

- 迁移 `020_rule_review.sql` 增加意见的 `inferred_fixed_at/sha`、规则按原因的暂不处理记录、按仓库的文件树缓存。合并提取任务在人类讨论为空的提前结束之前，按 finding head 分组 compare 到真实合并 SHA；RIGHT 侧行号 ±3 与旧侧 hunk 相交时记疑似修复，跳过重复项，不改 finding 状态；compare 失败记日志并继续。没有新增模型调用，未修改 Prompt 或规则召回。
- `usage.inferredFixed` 与已确认 FIXED 分开；项目统计仍限定仓库，团队统计按规则 ID 汇总全部仓库。修复继承列表将团队统计硬编码为零的问题，并按团队去重查询。队列检查仍生效的版本，候选新版本不会遮住旧 ACTIVE 规则。
- `GET /api/rule-review` 按现有规则编辑权限返回 ACTIVE 规则与 noisy / sleeping / path_invalid / expired 依据。阈值为 3 次／40%、90 天；`POST /api/memories/:id/dismiss-review` 要求 reason 与非空 note，按规则＋原因忽略 90 天，即使依据变化也不提前出现。文件树只在打开队列时按需读取、缓存 24 小时；截断、读取失败或不可访问时明确列出未检查仓库，不把未知结果当作路径失效。
- 定向：`npm run build && node --env-file=.env --test dist/test/memory/database-rule-review.test.js dist/test/github/client.test.js dist/test/admin/admin.test.js`，13/13 通过。覆盖 5 次引用／3 次撤回、模拟时钟跨越 90 天、团队 A/B 汇总、已确认 FIXED 不重复计疑似、ACTIVE 与候选并存、所有仓库路径匹配与截断、24 小时缓存、compare 命中／不命中／失败、重复与 LEFT 排除、仓库维护者／团队管理员／CSRF 边界。
- 全量顺序执行：`npm test` 327 项，196 通过、0 失败、131 跳过（未加载数据库），59.39 秒；`npm run test:db` 170/170 通过，0 跳过，182.28 秒。数据库测试使用本机 PostgreSQL 的独立临时 schema。`npm audit --audit-level=high`：0 vulnerabilities。
- 页面：按 `work/ui-review/preview.mjs` 的方式，用临时 schema＋真实管理 handler＋替身 GitHub，ego-browser 检查 1600／1024 宽的 0 条、30 条、三原因、长中文／无空格英文名称、长团队名和详情统计；30 条分页为 20＋10。实际填写理由保存成功，数据库记录 `memory_id=71e7438b-68e2-400d-80ef-907fa0050900`、reason=noisy、actor=preview，另外两项原因仍显示。截图在被忽略的 `work/ui-review/review-*.png`；预览进程和 schema 已删除。
- 开销：合并推断每次执行增加最多 D 次 compare（D 为待推断意见不同 head SHA 数，无意见则 0）；取树缓存失效时每仓库 2 次 GitHub 读取，另按 installation 签发 token，同请求共用，缓存命中无新增 GitHub 读取；同进程相同仓库并发刷新共用请求，最多同时读取 4 个仓库。预览 30 条／2 仓库实测打开前取树 0 次，首次 2 次取树方法调用＋1 次 token，重复打开仍为 2／1；缓存命中的真实管理 API 连续 10 次成功响应为 6.34–34.59 ms、28,148 字节（GitHub 为替身、没有生产压测）。内存随所查仓库完整路径数增长，未测大仓库内存峰值。
- 限制：GitHub compare 最多返回 300 个文件，二进制或缺失 patch 不推断；改动附近代码只能说明疑似修复。没有真实 Webhook、真实 GitHub／模型发布输入；本项没有真实 delivery、Review 或 reply URL，没有模型角色运行及 token 消耗。未部署、未 push，不把整个阶段 2 标为完成。
- 合并时主脑修正（2026-11-15）：compare 原来以合并提交为目标，squash／rebase 合并时合并提交不以意见的 head 为祖先，旧侧行号是 PR 基点的行号，推断会错位。改为和 PR 合并前最后的 head 比较，只在 compare 状态为 ahead 时推断（强推过的跳过）；纯新增块按插入位置计入 ±3（常见的"补一个判断"）。`node --env-file=.env --test dist/test/memory/*.test.js dist/test/github/client.test.js dist/test/review/database-crash.test.js` 76/76。
- 新增拒绝路径：暂不处理请求缺少有效四类 reason 或 note 为空返回 422，依据任务书的四类原因和“理由必填”；登录、CSRF、项目／团队管理权限沿用现有 401／403／404。compare 与文件树网络失败不会新增用户拒绝规则。

- 收尾检查：`npm run format` 检查 248 个文件、格式化 10 个本次改动文件；`npm run check:docs` 36 个 Markdown 文件／310 个本地链接与锚点通过；`npm run check:format`、`git diff --check` 通过。

**ARCH-2-C**（2026-11-15，基于 `248d3ce`，分支 `arch/p2-c-context`）

- 实现：`context.ts` 一次 SQL 读取项目及所属团队 ACTIVE 最新版本和项目覆盖；纯函数应用停用／改级别，保留团队原级别，按 Scope 和例外关联收集，再按 must、should、info 排序。must 超限全给，Review 记日志及 limitations；其余超限规则进入索引。本批 Review 只给全文，未增加按需读规则工具。冲突差异仍通过项目例外或停用覆盖表达，不做语义推断。
- 调用方：Review、Reply、健康检查、开发及修订、规则提取共用编译器。Review／Health 以实际提供的 ID/version 校验，团队规则照常记入任务仓库的 `review_memory_usage`。Reply 保留前 10 条加有效原规则；Health 保留前 10 条；开发保留按文件附规则并带级别。提取器带规则归属，团队规则可作为例外／冲突目标，不能被项目候选替代（`unknown_rule`）。未改 Review／Reply／Health 的系统 Prompt、复查队列和用量统计。
- 回归：`npm test` 重跑 198 通过、0 失败、131 跳过（数据库用例），测试 Runner 耗时 62.10 秒；首轮既有 CodeGraph 建索引用例撞到 10 秒超时，单项及全量重跑通过，未改运行时。`npm run test:db` 首轮 172 通过、1 失败（既有安全审查测试连接 PostgreSQL 超时）；随后 `node --env-file=.env --test --test-concurrency=4 dist/test/*/database-*.test.js` 全量 173/173，0 跳过，46.30 秒。新增用例覆盖有效版本、多团队同 Scope、停用／改级别、团队原规则、must 超限、should 优先和所有调用方的实际输入及引用校验。
- 评测：默认适配器全文及 provided 均 52/85（61.18%）；`node eval/evaluate-recall.mjs --adapter=./eval/recall/context-adapter.mjs --output=work/recall-context.json` 全文仍 52/85（61.18%），全文加索引为 85/85（100%）。16 个合成样例，`node --test eval/metrics.test.mjs` 7/7。索引未进入当前 Review，不能把 100% 解释为线上全文召回率。
- 页面：真实管理 Handler＋临时 schema＋替身登录/GitHub；ego-browser 在 1600×1000、1024×900 查看一个仓库属于 3 个团队、停用、must 覆盖成 info、无覆盖各一条，标签无横向溢出；切换到另一个无覆盖的仓库后恢复团队默认。截图在忽略的 `work/context-1600.png`、`work/context-1024.png`。临时服务和 schema 已回收。
- 开销：规则读取仍为一次 SQL，Reply 从最多两次减为一次；查询新增团队成员关系与覆盖连接。200 条合成规则纯编译运行 30 次，中位数 11.79 ms、95 分位 25.54 ms，不含数据库／模型。规则正文和 must 超限会增加输入与内存，未做生产查询、内存或真实模型压测。
- 限制：GitHub 与模型均为替身，模型角色为 general_review／reply_handler／health_auditor／developer／decision_extractor；新增 Review／Reply／提取替身 usage 为 0，开发和 Health 复用 150 tokens 的测试记账值，不是真实消耗。没有真实 delivery、Job、finding、Review 或 reply URL，未运行真实 Webhook 或模型提取回归。新增拒绝路径仅为提取候选 `supersedes` 指向团队规则时按任务书丢弃；停用、移出团队和错误版本仍沿用“未实际提供”的引用拒绝规则。

- 收尾：`npm run format` 格式化 248 个文件，随后 `npm run check:format` 无需修改；`npm run check:docs` 36 个 Markdown、310 个本地链接与锚点通过；`npm audit --audit-level=high` 为 0 vulnerabilities；`git diff --check` 通过。

**阶段 1 完成、阶段 2 第二批合并后**（2026-11-15，`4c0c1d3`）

- 包含：1-A～1-E（1-B 含审查修复，迁移改名为 021）、2-A、2-B、2-C、2-E、2-F，以及主脑的修正：提取器例外关联（`a86508c`）、合并推断改用 PR 最后的 head（`0754d17`）、团队规则详情的旧文案。
- `npm test`：344 项，203 通过、0 失败、141 跳过（数据库用例），40.2 秒。随后 `npm run test:db`：186/186 通过、0 跳过，107.1 秒。`npm run check:docs`（36 个文件、310 个链接与锚点）、`npm run check:format` 通过。
- 召回评测（编译器适配器）：全文 52/85（61.18%），全文＋索引 85/85；Review 目前只收全文，索引要等 2-G。
- 阶段 1 未做的验收：真实部署下 30 分钟开发任务滚动发布；真实 GitHub／模型下的中断续做演练。

