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
| ARCH-1-A | 开发任务由统一执行器在 worker 上领取（租约、心跳），和企微解耦；重启和部署不再取消任务；去掉"目标分支有新提交就放弃" | 进行中 |
| ARCH-1-B | 开发任务补丁快照与接手续做；开发分支、提交、PR、issue 评论走副作用台账，发布中断后核对远端再继续 | 已完成（代码与替身验收；未做真实 GitHub/模型演练） |
| ARCH-1-C | 不经企微派任务：管理页／管理 API、给 issue 打 `pi-dev` 标签；仓库可以不绑群 | 进行中 |
| ARCH-1-D | 进程角色 `PROCESS_ROLE`（edge、worker、all），部署说明 | 待做（依赖 1-A） |
| ARCH-1-E | 线程回复加隐藏标记与发布前核对，中断后不重复回复；Review／Reply／规则提取的中断回归测试 | 进行中 |

阶段验收（来自设计文档）：

- 在每个步骤上杀掉 worker，GitHub 上都没有重复写入，任务能接着做。
- 部署期间，一个 30 分钟的开发任务不会丢。
- 不经过企微也能派任务（管理页、API、Issue 标签）。

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

**ARCH-1-B**（2026-11-15，`arch/p1-b-resume`；首版 `c8729fa` 及其后续修订）

- 改动：迁移 017 保存开发副作用台账、gzip 补丁快照、最终提案、最新评论时间和历史执行耗时基数。develop/revise 从固定基线恢复快照；已有提案跳过 Agent，commit 台账已完成时不建工作区，直接核对并继续发布。discuss/notice 的评论同样按台账和本 App 标记核对。
- 故障回归：开发 Agent 运行中、proposal 后、commit 台账写入而 head 未落盘、分支后、PR 后分别过期旧租约并由另一个 PersistentRunner 接手；最终均只有 1 个分支和 1 个 PR。分支/PR/issue/评论已经在 GitHub 替身生效但响应丢失时，不重复写入。commit 未落台账时允许重做无引用提交，只引用最终提交。
- revise 回归：proposal、commit、推送、回复各步骤中断后恢复，分支只推进一次、回复只发一条；保持 Agent 实际见过的评论游标，恢复期间新到的评论不会被记作已处理。
- 快照回归：虚拟时钟验证每 5 分钟保存，真实 stop 验证最后快照落库后放回；旧 owner 不能覆盖接手实例的快照。31 个 700 KB 随机文件不受发布限制影响，gzip 约 21.8 MB 时清除旧快照并从头完成。覆盖新增、删除、可执行位、忽略文件及父目录符号链接拒绝。
- 根因修复：`lastRevisionAt` 原来混用 PostgreSQL `started_at` 和 GitHub `created_at`，现在只比较已成功处理的 GitHub 评论时间；早/晚 5 秒两个用例均通过。恢复时不重置 token/未知预留与执行时间，排队不计时；发布失败重排增加尝试次数，到上限才 uncertain。不同 SHA 分支停止并提示人工核对。
- 审查修复前验证（`ee51c09`）：`npm test` 306 项，181 通过、125 跳过、0 失败（39.20 秒，普通命令未加载数据库）；随后 `npm run test:db` 157/157 通过，0 跳过（106.43 秒）。定向恢复、长评论分页核对与执行权边界测试均通过。GitHub 和模型均为替身，临时 schema 在结束后删除；无真实 delivery/Job/finding/Review/reply URL。developer 用量累计断言为 150+150=300 tokens，revision 为 120 tokens，均非真实模型耗费。
- 审查修复前开销估算：普通 commit/ref/PR 每步约增加 6 次短 SQL；快照多遍历工作区并编码压缩一次，峰值内存随改动量增长，未做生产压测。硬崩溃最多丢失最近约 5 分钟未保存改动（保存故障另记日志），耗时保守计到租约截止；正常 stop 等待最终快照。新 issue 核对最近 100 个，评论完整分页。未运行真实 GitHub/模型、真实 Webhook、跨物理机器或 OS kill 演练；未修改进程角色拆分相关文件。
- 收尾检查：全量后 `npm run format` 检查 201 个文件，无需修改；`npm run check:docs` 36 个 Markdown 文件、306 个本地链接与锚点通过；`npm audit --audit-level=high` 为 0 vulnerabilities；`git diff --check` 通过。


**ARCH-1-B 审查修复**（2026-11-15，基于 `ee51c09`）

- 任务行锁覆盖每次台账写入、GitHub 核对/写请求与快照保存。pending 意图先独立提交，后续请求和 done 记账在同一持锁事务；过期扫描、领取均跳过锁住的任务。旧 owner 的在途请求、检查后暂停的记账和等待冲突行锁的快照 SQL，都不能与接手者重叠。
- 领取、处理器准备阶段和失败重排均依据持久化 pending/done 台账识别发布阶段；取 token 失败也重排并增加 attempt，耗尽才 uncertain。原有分支冲突人工核对行为保留。
- 迁移 018 增加评论边界秒内的已处理身份集合（种类 + ID），与提案一起保存；同秒后到评论仍为 new，恢复期间不推进到未处理的评论。不同评论种类共用数字 ID 不互相遮蔽。
- 修前命令 `npm run build && node --env-file=.env --test dist/test/development/*.test.js`：79 通过、5 失败、0 跳过（60.69 秒），失败项恰为审查 1–5。修后同命令：88/88 通过、0 跳过（53.76 秒）；保留全部原恢复用例，额外覆盖 discuss/notice/revise 准备失败和尝试耗尽、同秒恢复及跨种类 ID。
- 并发用例采用真实 PostgreSQL 临时 schema，自然等待 1 秒租约到期；分别阻塞远端替身请求、记账 SQL 和快照冲突行。旧恢复用例改成先让请求抛中断、事务退出后再过期租约；PR 创建请求与 Webhook 并发，回调等待请求释放任务锁，保留回调先到的免审查验收。
- 新增的拒绝路径：快照保存/超限清理时，失效 owner 或过期租约抛 `TaskLeaseLostError`，依据本次已定修法；副作用沿用同一执行权拒绝规则，无新产品输入校验。
- 性能：一次首次成功的副作用包含 2 个事务、6 条业务 SQL、4 条 BEGIN/COMMIT；快照写入为 1 个事务、2 条业务 SQL、2 条 BEGIN/COMMIT，gzip 在锁外。每个在途操作占用一条连接，心跳和同任务回调更新可能等待；GitHub 请求数不增加。未测生产延迟、内存和吞吐。
- 限制：未运行真实 GitHub/模型、真实 Webhook、OS kill 或跨机器演练；无真实 delivery/Job/finding/Review/reply URL。模型为 developer/revision/discussion 替身，usage 只验证累计。锁不能撤销客户端超时后远端仍可能执行的请求，继续遵守不承诺 exactly-once 的边界。未改进程角色拆分文件，未 push。
- 最终顺序验证：`npm test` 315 项，181 通过、134 跳过、0 失败（65.46 秒，普通命令未加载数据库）；随后 `npm run test:db` 166/166 通过、0 跳过（177.24 秒）。`npm run format` 检查 202 文件、格式化 5 文件；`npm run check:docs` 检查 36 文档/306 链接通过；`npm audit --audit-level=high` 为 0 vulnerabilities；`git diff --check` 通过。
