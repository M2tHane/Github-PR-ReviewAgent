# PR Review 与团队规则体验收口

状态：体验收口完成；四项优化已实现，验证记录见下文｜更新：2026-09-15｜完成：4 / 4

依据用户在原会话中的完整产品取舍执行。本次读取并接续 `01a09a01-d8be-7cb0-9380-2a211e4fabe3`，追溯其父会话恢复需求；代码基线为 `237106e` 的已有工作区改动。M0～M3 历史证据及 M2 独立增益验收保持原记录。

- [x] UX-01：短摘要、120 字短评、同根因聚合与关联位置；保留完整审计并强制结构化规则引用。
- [x] UX-02：团队规则列表、待确认工作流、右侧详情、独立编辑、版本与证据二级化；停用确认与名称选择替代。
- [x] UX-03：概览／团队规则／仓库导航；设置收纳运行记录、策略和健康检查；只展示真实健康结论。
- [x] UX-04：预算／权限／发布回归、真实模型固定样本、桌面／移动端和键盘验证；文档与截图。

范围：复用已有规则来源与生命周期，不新增手工捏造无来源规则、规则使用统计或健康总分。界面里的状态翻译不改变内部状态机。旧截图与 walkthrough.zip 保留为本地历史证据，现归档于被忽略的 `work/document-archive/`。

产品要求见 [F02](../PRD-MVP.md#f02pr-自动审查) 和 [F05](../PRD-MVP.md#f05最小管理界面)，实现细节见 [架构说明](../architecture.md)。

## 完成证据

### 2026-09-13：实现与回归

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm run build` | 通过，包含服务与 React TypeScript 检查及管理页构建。 |
| `npm test` | 58 项：46 通过、12 项数据库检查由独立命令运行，0 失败。 |
| `npm run test:db` | 13 项通过；创建并回收独立 schema，没有让测试 Runner 领取真实任务。 |
| `npm audit --audit-level=high` | 0 漏洞。 |
| `node --check eval/evaluate-ux.mjs` | 通过。 |
| `npm run check:docs`、内部链接及 `git diff --check` | 7 篇 Note、45 个相关 Markdown 链接、差异格式检查通过；27 个本轮文件未匹配到本地凭据值。 |

回归包括：未知／重复／遗漏的分组成员、不同规则的合并限制、原始候选与角色保存、模型伪造身份字段、短评上限、摘要降级仍可查看修改建议、评论末尾身份绑定、详情权限与 CSRF、旧 head／暂停／uncertain 不重发，以及既有预算、取消和 Health 检查。

规则回归确认：待确认版本存在时旧版仍可召回；忽略后显示旧版且不复用版本号；替代另一条规则时没有遗留第二个 ACTIVE 版本；例外不能通过替代操作撤销其依赖的原规则。编辑只允许规则内容和范围，不能伪造来源或状态。

### 真实模型固定样本

实际执行 `node --env-file=.env eval/evaluate-ux.mjs`，并使用 `orders-main` 参数复核专项输出调整。仓库为 `M2tHane/pi-review-test-repository`，模型为 `deepseek/deepseek-v4-flash`，每个任务预算 160,000 tokens。通过服务创建固定 SHA Workspace，只读取代码，不运行样本脚本。

| 样本 / 本地 Job | base → head | 角色与结果 | 耗时 | usage（含缓存） |
| --- | --- | --- | --- | --- |
| orders-single / `65663c60-3c5b-4b79-903e-686b108be013` | `3e02a7c59b073547da3c466987d4d8570df31484` → `0ebd1cc3ca2ac1e4b42bfe2cee9a66a89e8b2713` | general_review；2 条候选合成 1 个问题，48 字符短评。 | 11,406 ms | input 1,828 / output 2,373 / cacheRead 2,176 / total 6,377 / unknown 0 |
| orders-main / `458df054-6570-49c1-8eec-8e5ee28a51c6` | 同上 | governance_main + java_reviewer；1 个问题、2 个位置、66 字符短评。general_review 结构校验失败，结果明确为 partial。 | 34,134 ms | input 6,466 / output 9,532 / cacheRead 13,184 / total 29,182 / unknown 0 |
| rule-reference / `25da7132-dff3-4d3a-8e69-63ec3ab3fe50` | `f8d7f03ce2ec5c761b3416fd11992d259b96043b` → `69e69bdf16dd59a6235307deb213e91a13477a08` | general_review；1 条规则意见，53 字符短评，绑定真实规则 v2。 | 11,887 ms | input 2,224 / output 2,473 / cacheRead 6,528 / total 11,225 / unknown 0 |

订单样本没有提供后来从该 PR 提取的规则，避免把未来决定带回初始审查。两个订单路径都保留 `OrderCatalog.java:15` 主位置和 `OrderExport.java:8` 关联位置，建议同时覆盖查询快照与导出副本。

规则样本实际召回并绑定 `567f00c2-b758-4b2a-857b-ceb62d33e9a6` v2，来源为 PR #8。详情中的结构化引用来自数据库记录，不依赖正文提及规则名称。

这些本地 Job 没有真实 delivery、Review 或 reply URL；原始输入来自 [PR #8](https://github.com/M2tHane/pi-review-test-repository/pull/8) 与 [PR #9](https://github.com/M2tHane/pi-review-test-repository/pull/9)。本轮没有新建 GitHub 评论、提交或 PR，也没有把本地验证当作 Webhook 发布验收。

首轮存在短评超长、代码片段超限与模型结构错误；失败及消耗均保留，未放宽校验。专项改为仅提交候选，最终短评由 Main 生成。Main 仍可能因专项输出不合法形成 partial；两个专项全部成功的汇总路径由确定性回归覆盖，本轮真实样本不声称全专项成功。

全部真实调用尝试共 140,267 tokens，未知消耗为 0。原始记录：`work/ux-model-evaluation-initial.json`、`work/ux-model-evaluation.json`、`work/ux-model-orders-main-before-candidate-fix.json`、`work/ux-model-orders-main.json`。

### 界面与键盘验证

ego-browser TaskSpace 3；使用独立 `ux_preview_*` schema 和 OAuth 替身，没有创建 Worker。界面数据来自授权测试仓库的副本：恢复一个历史候选以检查待确认操作，并在副本中装载新的固定样本结果验证详情渲染。这不是原 GitHub Review 的重发或历史回写。

实际通过：

- 概览只列每个 PR 最近一次审查；主导航为概览／团队规则／仓库，设置提供策略、健康检查、运行记录与讨论。
- 规则查看、来源、版本历史、独立编辑和确认；编辑后路径、语言、模块、条件、来源和证据均保留。
- 按名称选择替代规则及内容预览；取消停用不改变规则，确认停用后状态更新。
- 忽略手机端保存的新版本后，恢复原 ACTIVE v2，忽略记录仍在历史中。
- 原生 dialog 的 Tab 导航、Escape 关闭、焦点返回列表；取消确认回到“更多操作”。跨页面导航回到顶部。
- 1440px / 390px 无页面横向溢出；手机抽屉和编辑表单可操作。审查详情显示一个问题并可展开两个完整候选。
- 运行记录默认只显示失败／超时／发布待核对，可切换全部。健康检查显示覆盖不足，完整报告与历史对比可展开。

截图与检查结果位于受 Git 忽略的 `work/`：`ux-overview-desktop.png`、`ux-rules-desktop.png`、`ux-rule-drawer.png`、`ux-rule-edit.png`、`ux-deactivate-confirm.png`、`ux-rule-replace.png`、`ux-rules-mobile.png`、`ux-rule-mobile.png`、`ux-pending-mobile.png`、`ux-review-mobile.png`、`ux-health-mobile.png`、`ux-browser-checks.json`。

### 运行边界与交接

- 本轮源码与验证在当前工作区完成，未创建新提交。
- 本地 3000 端口属于另一个 checkout；本轮没有替换其进程或升级其业务 schema。当前公网 OAuth 回调域名访问失败，真实 OAuth／公网 UI 未作为本轮通过证据。
- 核对时，实际数据库中的两条 ACTIVE 规则仍为原 v2，更新时间未改变，没有活动真实 Job。界面写入仅作用于验证副本；验证完成后已关闭 TaskSpace 3、停止预览服务并确认临时 schema 已回收。
- M2 的独立人工增益验收继续保持原状态，本轮不替代该确认。


## 2026-09-15：文档同步与项目优化检查

本次授权为更新项目文档并检查优化机会。保留既有未提交源码与未跟踪文件，仅修改文档，不将以下建议计入已完成实现。检查基线为 `237106e490f75031ca757882a89f27bc2624c18b` 加当前工作区体验收口改动。

### 文档同步

- AGENTS.md：明确授权判断、体验收口后的基线、未提交文件保护、CodeGraph 优先与检索局限、实现入口、迁移及测试边界。
- README：说明 start 使用编译产物、dev 不持续编译源文件；说明数据库 skip 和文档检查的实际覆盖范围。
- PRD、M2、M3：区分当前能力与历史规划，保留 M2 人工增益待确认状态及历史验收证据。

### 检查时的优化建议（后续实现见下文）

| 优先级 | 已确认的代码事实与影响 | 建议与验收方式 |
| --- | --- | --- |
| P1 | [OAuth 状态管理](../../src/admin/handler.ts)：`states` 每次访问 `/auth/github` 都新增条目，仅成功校验的 callback 删除；放弃登录的过期 state 不回收。`sessions` 仅在该 session 再次访问或退出时删除。长期运行下内存随历史登录请求累积。 | 给 state/session 增加过期回收及容量边界；用可控时间验证无人回访的过期记录被删除，合法 OAuth 与会话仍正常。不需要引入 Redis。 |
| P2 | [讨论 API](../../src/admin/findings.routes.ts) 的 `/api/findings` 无 LIMIT／分页；[DiscussionPage](../../frontend/app.tsx) 一次请求全部 finding、回复与 clue。历史数据增长会扩大查询、响应和渲染成本。 | 增加稳定排序与游标分页，按仓库或 Job 筛选；大量 finding／多回复样本验证跨页无重复遗漏，权限隔离不变。当前未做压力测试，不宣称已有线上性能故障。 |
| P2 | [管理页加载](../../frontend/app.tsx) 并行请求 repositories、jobs、memories；三个端点各自调用 [allowedRepositories](../../src/admin/repository.service.ts)，每次又串行向 GitHub 检查所有仓库权限。N 个仓库的首次加载约产生 3N 次权限查询。 | 在同一次加载的并发请求间合并权限查询，或提供一次授权后的聚合读取；限制并发数，不能用长期缓存延迟权限撤销。以替身统计调用次数，并覆盖失权及 API 失败路径。 |
| P2 | 当时的文档检查仅覆盖旧决策记录，跳过 README 与 docs 的标题锚点；失效链接不会使 `check:docs` 失败。 | 后续扩展 Markdown 文件／锚点检查，正确忽略代码围栏与外部 URL；用不存在的文件及标题做失败样本。本次已先修正文档对命令覆盖面的描述。 |

以上为定向源码检查，覆盖管理页数据读取、OAuth 生命周期、构建与文档入口，并非全仓库安全审计。M2 的人工质量收益判断仍需维护者完成，不能用本次测试代替。

### 本轮验证

- `npm test`：通过（包含 build）；58 项，46 通过、12 项数据库用例跳过、0 失败。日志：`work/docs-review-tests.log`。
- `npm run test:db`：首次失败，本地 `127.0.0.1:54329` / `::1:54329` 拒绝连接；日志：`work/docs-review-db.log`。随后改用独立临时 PostgreSQL 18 容器，结果见下方补充。
- `npm audit --audit-level=high`：通过，0 漏洞。
- `npm run check:docs`：通过，7 篇 Note；不代表全部文档锚点已检查。
- 本轮无真实模型或 GitHub 发布操作；delivery／Job／finding／Review／reply URL、模型角色与 usage 不适用。未运行浏览器验收：未修改界面实现。

- 独立数据库复验：通过。设置临时容器连接的 `DATABASE_URL` 后执行 `npm run test:db`（包含 build），13 项全部通过、0 skip、0 失败，测试耗时 3.81 秒；日志：`work/docs-review-db-isolated.log`。测试使用临时 schema，容器已停止并自动删除，未启动业务 Worker。
- 修改的 6 份 Markdown 的相对文件链接存在性检查：57 个通过；新增／修改的标题链接已核对目标标题。`git diff --check` 通过。


## 2026-09-15：四项优化实现与验证

用户在检查后授权“开始优化这四点”。沿用 `237106e490f75031ca757882a89f27bc2624c18b` 加已有未提交改动；仅修改本轮相关实现、测试和文档，不提交或发布 GitHub。

- [x] OPT-01：OAuth state/session 自动到期回收、各 1000 条容量上限；满额明确拒绝新登录，保留已有有效会话。
- [x] OPT-02：讨论 API 复合游标分页、筛选与每页上限；列表及详情按需加载、重试、刷新、取消旧请求。完整审查的当前 finding 状态独立读取。
- [x] OPT-03：聚合加载端点只授权一次，最多 4 项并发权限检查；下一请求重新授权，拒绝结果与上游失败不缓存。
- [x] OPT-04：统一 Markdown 解析器检查根文档、docs 与 Notes 的文件链接／锚点，尊重 Git 忽略规则；移除旧正则重复检查，接入 check:docs。

管理页资源边界和文档链接检查的当前实现见 [架构说明](../architecture.md) 与 [链接检查器](../../scripts/check-markdown-links.mjs)。API 返回值有变化，需一起构建部署服务和管理页。

### 验证范围与限制

失败基线已执行：自动过期存储缺失、bootstrap 404、分页返回旧数组、文档检查器缺失；增加 HTML 实体标题及独立 finding 状态时，也先记录失败再修正。日志为 `work/optimization-red-admin.log`、`work/optimization-red-db.log`、`work/optimization-red-docs.log`、`work/optimization-red-entities.log`、`work/optimization-red-statuses.log`。

覆盖无人回访时 token 到期回收、容量拒绝不淘汰有效记录、OAuth state 单次使用和截止时间；9 仓库首次加载仅 9 次权限查询、并发最多 4、下一请求撤权和上游失败；56 条同时间／微秒时间与多回复结果按 7 条翻页无重复遗漏，错误游标／参数／跨筛选拒绝，撤权后旧游标无法取数；中文／重复／HTML 实体／Setext 标题、引用链接、图片、代码围栏和 Git 忽略文件。

浏览器仅完成替身登录与概览打开，随后 ego-browser 报告任务空间被用户接管。用户要求避免消耗 token 的浏览器操作，本轮不再恢复；桌面／手机分页交互、错误重试和快速筛选的浏览器验收未完成，不能记为通过。UI 已通过 TypeScript 与打包检查；没有压力测试或真实 OAuth／GitHub／模型调用。模型角色、usage、delivery／真实 Job／finding／Review／reply URL 不适用。

数据库使用独立临时 PostgreSQL 18 容器和一次性 schema；没有启动业务 Worker。预览服务已停止，预览与测试 schema 已核对回收。


### 最终本地验证结果

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm test`（包含 `npm run build`） | 62 项：50 通过，12 项数据库用例由独立命令运行，0 失败；耗时 7.19 秒，日志 `work/optimization-final-tests.log`。 |
| 临时容器 `DATABASE_URL` 下执行 `npm run test:db` | 13 项全部通过、0 skip、0 失败；耗时 4.05 秒，日志 `work/optimization-final-db.log`。 |
| `node --experimental-strip-types --test test/docs-links.test.ts` | 最后补充的代码标题实体反例先失败，修正后通过；该增量仅涉及文档解析器。失败日志 `work/optimization-red-code-anchor.log`。 |
| `npm run check:docs` | 8 篇 Note 的结构／格式、21 份 Markdown 的 123 个本地链接与锚点通过。 |
| `npm audit --audit-level=high` | 通过，0 漏洞；新增解析器均为锁定版本的开发依赖。 |
| `git diff --check` | 通过。 |
| 临时资源回收 | 预览服务正常退出；数据库查询确认预览和测试 schema 均不存在；独立容器停止并自动删除。未操作用户接管后的浏览器空间。 |

本轮没有提交代码。原体验收口及阶段记录保留，M2 的人工收益确认仍待用户判断。


## 2026-09-16：提交与运行流程交接

用户授权提交代码并要求解释 PR / Memory / 多人评论 / 失败恢复，补充 draw.io 图。

- 代码提交：`902b570`（`feat: refine PR review UX and bound admin resource usage`），包含体验收口、四项优化及必要测试／文档，共 37 个文件；未推送远端。
- 提交前重新执行 `npm test`：50 通过、12 个数据库用例由独立命令执行、0 失败（6.09 秒，`work/commit-tests.log`）；独立临时容器执行 `npm run test:db`：13 通过、0 skip、0 失败（2.94 秒，`work/commit-db.log`）。两者均包含 build。
- `npm run check:docs`、`git diff --cached --check` 通过；`npm audit --audit-level=high` 为 0 漏洞。暂存的 37 个文件未匹配本地凭据值或私钥头。临时数据库容器已停止并自动删除。
- 按源码核对并补充 [实际流程说明（现已并入项目理解指南）](../project-guide.md) 与 [可编辑 draw.io 图](../diagrams/pr-review-memory-flow.drawio)。XML 节点 ID / 连线引用校验通过；本机 draw.io 31.4.4 实际导出 PNG，并目视确认布局和中文显示完整。
- 本轮不恢复浏览器操作、不调用真实模型、不创建 GitHub 评论。原有 `.codegraph/`、`.serena/` 与 walkthrough 文件保留在本地，不纳入本次代码提交。
- 运行路径说明明确区分当前限制：无多人投票或身份优先级、无纯代码自动激活 Memory、无自动模型切换／完整 uncertain 对账，Decision Extractor 尚未统一预算与取消封装。此次仅说明，不扩大为额外功能实现。

### 2026-09-16：项目理解指南

新增 [项目理解指南](../project-guide.md)，面向首次理解实现的读者，说明四类任务、数据库十二张表、Session 与 Team Memory 的区别、Pi 调用循环、受控工具、多 Agent 协作、SDK 扩展能力及中文枚举字典。README 和运行流程问答已加入入口。

依据代码基线 `262d607` 与本地 Pi SDK `0.85.1` 文档核对；区分已启用能力与 SDK 可选扩展，明确检索、多人讨论、提取器统一预算／审计和发布不确定性的当前限制。

验证：`npm run check:docs` 通过（8 篇 Note、23 个 Markdown 文件）；`git diff --check` 通过。此次仅修改说明文档，未运行构建、业务测试、数据库测试和依赖审计；未使用浏览器、调用业务模型或写入 GitHub，因此无新增 delivery／Job／finding／Review／reply、模型角色、耗时与 usage 记录。

### 2026-09-16：移除启动时自动迁移

按用户要求由 Luna（high）子 Agent 删除 `src/main.ts` 的 `await database.migrate()`；保留现有 SQL 与 `npm run migrate` 手动入口供首次初始化和未来升级使用。README 与项目理解指南同步说明日常启动无需迁移。

验证：子 Agent 执行 `npm run build` 通过；主 Agent 复核源码差异，执行 `npm run check:docs`、`git diff --check` 通过。本次为启动调用删除，未运行业务／数据库测试及依赖审计，未启动连接真实队列的服务，未执行真实数据库迁移或 GitHub 发布。无新增业务 delivery／Job／finding／Review／reply、业务模型角色、耗时或 usage 记录。

### 2026-09-16：文档去重与本地资料归档

将 `docs/runtime-flow.md` 的问答统一到项目理解指南，保留补充的提取校验、维护者权限、重试次数和流程图预览，删除重复文件并修复引用。未跟踪的 walkthrough、20 张截图及 ZIP 移至被忽略的 `work/document-archive/`，保留本地历史证据，不纳入 Git。阶段任务清单、专题设计、Notes 和 draw.io 文件保留。

本次提交同时包含前述移除启动自动迁移的改动。实际执行 `npm run build`、`npm run check:docs`（8 篇 Note、21 个 Markdown 文件、129 个本地链接和锚点）、`git diff --check`，均通过。没有运行服务、真实数据库迁移、模型调用或业务 GitHub 发布；未重复运行业务／数据库测试和依赖审计，本轮没有改变业务处理或依赖。无新增业务 SHA／delivery／Job／finding／Review／reply 与 usage。

## 2026-11-05：企业微信完成通知与项目成员关联

基于最新 `origin/ops-hardening`（`c4276b2f8ad94a98ce843786e08a0d469517a36c`）创建 `feat/wecom-review-notifications`，本轮未提交、未推送。

- [x] GitHub Review 确认发布时原子写入待通知记录，独立发送完成状态及 PR 链接，不包含审查明细；通过 `mentioned_list` 指定 PR 作者的企业微信成员 ID。
- [x] 增量迁移 004 保存通知、跨实例限速状态和按项目隔离的成员关联。发送时读取当前项目映射；缺少关联显式失败，不跨项目兜底。
- [x] 项目「通知成员」以三列表格展示 GitHub 账号、企业微信成员 ID、操作；右上角添加，每行末尾编辑／删除，独立编辑弹窗和删除确认。权限与 CSRF 使用现有管理页约束。
- [x] 配置及接入、失败排障、性能估算写入 [企业微信通知说明](../wecom-notifications.md)。一个服务共用一个群 Webhook，成员关联按项目维护，保存即生效。
- [ ] 真实内部测试群的 @ 提醒、PR 链接及 GitHub 发布端到端验收：未提供测试群 Webhook；官方 API 与帮助说明有冲突，不能以接口成功代替客户端提醒验证。

验证证据：

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm test`（含 build） | 139 项，104 通过、35 skip、0 失败；10.53 秒，`work/wecom-tests.log`。数据库单独验证。 |
| 临时 PostgreSQL 18 独立 schema 下 `npm run test:db` | 36 项全通过、0 skip、0 失败；3.66 秒，`work/wecom-db-tests.log`。覆盖项目隔离、权限、发送重试与不确定状态、跨实例互斥／限速及取消。 |
| 表格调整后 `npm run build` | TypeScript 与管理页打包通过。 |
| ego-browser 替身登录＋真实本地管理 API／临时数据库 | 验证分项目关联、新增、编辑、取消删除、确认删除、Escape 焦点恢复；桌面和 390px 手机表格截图目视通过，手机页面宽 390px，无横向溢出。截图 `work/wecom-members-table-desktop.png`、`work/wecom-members-table-mobile.png`。 |
| `npm run check:docs`、`git diff --check` | 通过。 |
| `npm audit --audit-level=high` | 未通过：现有依赖 2 high、2 moderate，涉及 Pi SDK 间接依赖等；未改依赖及 lockfile。日志 `work/wecom-audit.log`。 |

性能为代码路径估算：每实例空闲约 0.25 次数据库查询／秒；正常通知约 12 次数据库往返、2 次 GitHub HTTP、1 次企微 HTTP，不新增模型调用。未测真实网络延迟或压力负载。没有启动真实队列 Worker、迁移生产数据库、调用业务模型、写入真实 GitHub 或发送企微消息；无新增真实 delivery／Job／finding／Review／reply URL、业务模型角色或 usage。

最终界面按用户要求将行末「编辑／删除」改为无边框、透明背景的文字按钮；再次构建通过，并在桌面与手机截图确认。浏览器任务空间已关闭，本轮临时预览进程正常停止，查询确认预览 schema 已回收，专用测试数据库容器已停止。

### 2026-11-05：真实 PR 与企微联调、通知排版调整

用户明确授权在 `M2tHane/pi-review-sandbox` 创建测试 PR 并发送企微通知。采用独立 schema `wecom_live_1793892929734`，复用真实 App／模型配置，只转发测试分支的真实 GitHub Webhook；未启动主数据库历史任务，未修改 GitHub App 的 Webhook 地址。

- 测试 PR：[PR #5](https://github.com/M2tHane/pi-review-sandbox/pull/5)，分支 `test/wecom-notification-20261105`，head `baef00ee7e07a07fa7080b051aca6f44e7dc76f7`。测试代码故意漏乘商品数量；PR 保持打开且未合并。
- Delivery `b239c710-d92e-11f1-84ce-aef5c34d7ab8` 被真实验签接受（202）；Job `72de708f-d498-41bd-8074-2f784584afb0` 首次执行成功，15:36:46.800–15:37:18.842 UTC，约 32.04 秒。
- `general_review` / `gpt-6.1-sol` 找到“小计漏算商品数量”，发布 [Review 5787607234](https://github.com/M2tHane/pi-review-sandbox/pull/5#pullrequestreview-5787607234) 和 [finding_2fa31bd204e39b102beec72b 对应评论](https://github.com/M2tHane/pi-review-sandbox/pull/5#discussion_r4482511786)。Agent 记录耗时 25,012 ms；input 1,881、output 545、cacheRead 1,408、cacheWrite 0、totalTokens 3,834、unreportedTokens 0。
- 原文本通知于 15:37:23.362 UTC 记录 `sent`，attempt 1，发布时间到送达接口成功约 5.17 秒。用户提供客户端截图，确认收到完成状态、PR 链接，且 `jizhaoqi` 显示为实际成员 `@追逐兔`。截图可确认成员解析与消息展示，系统通知／免打扰提醒未单独验证。
- 根据用户截图反馈，通知改用普通 `markdown` 的 `<@userid>`，将 @ 放第一行，空行后展示状态、项目和 PR 短链接；去掉 SHA、长网址和末尾重复 @。保留部分审查状态，不发送审查明细。
- 使用构建后的通知代码，对已发布的 PR #5 单独发送一次排版预览，15:41:01.865 UTC 返回 `sent`。未重跑模型、未重排原通知、未重复发布 GitHub Review。新版客户端排版与 @ 提醒待用户确认。
- 更新后 `npm test`：104 通过、35 skip、0 失败（11.25 秒）；`npm run test:db`：36 全通过、0 skip、0 失败。日志 `work/wecom-layout-tests.log`、`work/wecom-layout-db-tests.log`。`npm run check:docs`、`git diff --check` 通过。
- 本次真实测试关联保存在隔离 schema，未写入主数据库；schema 保留用于核对真实结果。临时服务与 Smee 转发进程已停止。证据保存于 `work/wecom-live-evidence.json`、`work/wecom-layout-send.json`，不包含 Webhook 密钥。

限制：Review 内管理页详情链接沿用现有配置 `127.0.0.1:3000`，不能作为远程可访问页面；本轮验证的是 GitHub PR／Review 链接和群通知，未修改该配置。新版排版沿用单次 HTTP 投递，无新增查询或模型开销；未做压力测试。本轮没有改依赖，未重复运行依赖审计；原审计问题仍保留。

### 2026-11-05：PR 标题与独立结果链接

用户确认上一版普通 Markdown 截图已正确展示顶部 @，继续要求正文第二行显示「PR：#编号 标题」，第三行单独显示「查看审查结果」链接。本次保留顶部 @／完成状态及项目行，发送时复用已有 GitHub PR 响应取得最新标题，不增加网络请求或数据库字段；标题经现有密钥打码、换行归一化和 Markdown／@ 语法转义，防止标题改变通知结构或提醒对象。

实际验证：`npm run build` 通过；`node --test dist/test/notifications/wecom.test.js` 7 项通过；`node --env-file=.env --test dist/test/notifications/database-notifications.test.js` 11 项全部通过、0 skip（4.63 秒）。覆盖标题使用当前 PR 值、链接独立一行、标题格式与 @ 注入、原有通知发送状态。`npm run check:docs`、`git diff --check` 通过。本次仅跑相关测试，未重复全量测试或依赖审计。

读取真实 PR #5 当前标题并确认 head 未变，于 15:44:55.871 UTC 单独发送一条新版预览，返回 `sent`；证据 `work/wecom-title-send.json`。没有新建 PR、重复运行模型或重复发布 Review；新版客户端排版待用户确认。

### 2026-11-05：启动本地前后端

用户授权启动日常本地服务。执行 `npm run migrate`（含构建）成功，主数据库增量升级至 004；将已验证的测试仓库成员关联保存到主数据库。执行 `npm start`，前端静态页面及后端 API 同由 3000 端口提供，日志 `work/local-service.log`。

验证：`/`、`/assets/app.js`、`/assets/app.css`、`/healthz`、`/readyz` 均 HTTP 200；未登录访问 `/api/repositories` 返回预期的 401。启动前无 queued/running 历史任务，健康定时关闭。此次未重新启动 Smee 外网 Webhook 转发，未创建新的 PR 或触发模型调用。沿用既有启动流程；启用企微通知增加每实例约 0.25 次/秒的空闲数据库轮询，未做启动性能基准测试。

### 2026-11-05：仓库启用复选框点击范围

用户报告点击仓库卡片空白会切换启用状态。原因是 `.check` 为块级 flex 标签，占满卡片宽度。仅对 `.repository-card > .check` 设置 `width: fit-content`，保留复选框与文字点击、键盘操作；构建后刷新现有前端即可生效。

验证：`npm run build`、`git diff --check` 通过。ego-browser 未登录，未操作真实仓库设置；在本地页面加载实际构建 CSS，并插入与仓库组件一致的标签结构验证：800px 卡片内标签宽约 75.6px，点击右侧空白不切换、点击标签切换、空格键切换，均通过。测试浏览器已关闭。未运行业务测试，无后端行为变更。

同时核实 Webhook 当前来自服务级 `WECOM_WEBHOOK_URL`，按仓库仅保存成员关联；尚未实现每仓库 Webhook 配置。本轮向用户说明现状及改动范围，未擅自改通知目标或凭据存储方式。

### 2026-11-05：主题切换入口

按用户授权，在登录页及登录后页面右上角新增主题选择器（浅色／深色／跟随系统）。选择保存在当前浏览器 localStorage，默认跟随系统；复用既有配色，通过 CSS `light-dark()` 与根节点 `color-scheme` 支持强制主题和实时系统变化。浏览器阻止存储时仍可切换本次页面，并明确提示无法保存。

验证：`npm run build`、`git diff --check` 通过。ego-browser 实测浅色背景 `rgb(247,248,250)`、深色背景 `rgb(11,13,18)`；刷新保留选择；跟随系统时模拟浅／深偏好实时切换通过。登录页操作实测；登录后布局使用浏览器内替身 session/bootstrap 展示，不更改真实登录或仓库数据。桌面／390px 手机截图目视通过，手机文档宽度 390px，无水平溢出。截图 `work/theme-desktop-light.png`、`work/theme-mobile-light.png`，测试浏览器已关闭。首次页面初始化脚本注入未生效导致等待导航超时，改为当前测试页面注入后验证成功。

此次仅涉及前端主题，无新依赖、网络请求、数据库查询或模型调用；未重复业务／数据库测试。已重新构建本地前端，现有服务无需重启，用户刷新即可看到切换入口。

### 2026-11-05：tuzi-api 团队规则研究与冲突核对

用户授权读取 tuzi-api 最新 dev 和历史提交，沉淀可用于 Review 的团队规则，并要求规则不冲突。本轮完成 [15 条规则候选](../team-rules/tuzi-api.md) 及 [历史证据、冲突核对和接入说明](../team-rules/tuzi-api-evidence.md)：12 条有当前明确规范支撑，3 条为限定范围的历史推断；每条包含适用条件、例外、应提示／不应提示例和固定版本证据。尚未导入或激活 Memory。

- tuzi-api 基准：fetch origin dev 后固定 `d2d412bec96698e0f7450b1bd5684f88231887c5`；结束前 `git ls-remote origin refs/heads/dev` 仍为相同 SHA。浏览近期主线及按主题筛选的历史，不声称完整审查全部 10,816 个可达提交。
- Review Agent 基准：`c4276b2f8ad94a98ce843786e08a0d469517a36c` 加既有工作区改动。遵循 CodeGraph 优先读取规则创建、来源校验、确认、替代和召回路径；本轮只增加两份文档并追加本条记录，保留此前未提交功能。
- 冲突核对覆盖 17 组易混淆要求，包括 MySQL 替代旧三库规范、主库账务记录与日志库投递、缺失 usage 与明确零、缓存降级与权限未知不放行、同秒续租零行结果、进程内游标与跨实例资金幂等。核对范围和不能泛化的要求写入证据文档。

实际验证：

| 命令／操作 | 结果 |
| --- | --- |
| `git -c core.hooksPath=/dev/null fetch origin dev`、固定 SHA 的 `git show`／`git grep`／主题历史查询 | 成功；未切换 tuzi-api 功能分支，未执行待研究仓库脚本。 |
| Python 调用 `git show SHA:path`、`git rev-parse`、`git merge-base --is-ancestor` | 37 个快照文件及行锚点存在，15 个引用历史提交均属于该 dev 历史；完整引用清单保存在忽略的 `work/tuzi-rule-research/sources.json`。 |
| 通过 `pg.Client` 连接级只读选项查询目标仓库 | 成功，返回空列表：当前本地配置的管理库未登记 `tuziapi/tuzi-api`；未写仓库、规则或状态。不能据此判断其他部署的规则情况。 |
| `npm run check:docs` | 通过；22 篇 Markdown、158 个本地文件链接／标题锚点。外部 GitHub 页面可访问性不在该检查范围。 |
| 规则／证据编号、引用定义和新文件空白检查 | 通过；15 个唯一规则编号对应 15 个证据节，固定源引用无缺失。 |
| `git diff --check` | 通过；新文档另行检查尾随空白。 |

未运行 build、业务测试、数据库测试、依赖审计或 tuzi-api 的 Go／前端测试：本轮只研究与写文档，没有修改业务代码、配置或依赖。测试文件仅作为源码证据阅读，历史提交中的测试结果不冒充本轮通过。没有调用业务模型、GitHub 写 API、真实支付或部署；无新增 delivery／Job／finding／Review／reply URL、业务模型角色、耗时或 usage。文档未接入运行时，没有新增运行请求延迟、内存、查询或包体积开销。

接入限制：当前候选要求已合并 PR 和人类讨论证据，没有通用 Markdown 导入接口；不同规则 ID 的 approve 也不自动消解语义冲突。后续应先选择补齐 PR 来源或扩展历史证据导入，重新核对实际目标库中的既有规则，再经维护者确认。未伪造 PR、评论、Memory ID 或来源 Job。

### 2026-11-05：tuzi-api 规则扩展至 50 条

用户认为首批 15 条覆盖不足并授权继续，扩展 [规则候选集](../team-rules/tuzi-api.md) 至 50 条（新增 TUZI-016—050），保留原编号和初版完成记录。新增渠道／流式协议、模型折扣与价格恢复、额度管理、任务财务身份、用户设置、索引检查、日志导出、后台租约、权限、SSRF、CSV 及前端刷新／请求生命周期等范围。每条有适用条件、边界、应提示／不应提示例和证据；新增条目还列出核对场景。这些场景是未来回归样本，未冒充本轮执行测试。

[证据文档](../team-rules/tuzi-api-evidence.md) 增加覆盖矩阵、具体流程及 37 组冲突核对。明确记录了五项历史演进：用户模型折扣从替代 Tier 扩大到整个分组倍率；HTTP 200 文本流支持不完整终止；日志自动刷新改为每次进入由用户选择；导出结果保留供统计，不再沿用旧关闭后清理要求；Seedance 渠道存储键由默认关闭改为默认开启。最后一项发现旧文档未同步，以后续实际函数、注释和测试变更证明替代，不推断线上已全部升级。通用规则与专项规则同根因只报一个 finding；历史推断不标为已确认团队共识。

实际验证与范围：

| 命令／操作 | 结果 |
| --- | --- |
| `git -c core.hooksPath=/dev/null fetch origin dev`、固定 SHA 的 `git show`／`git grep`／按文件及主题追溯 | 成功；仍固定 `d2d412bec96698e0f7450b1bd5684f88231887c5`。结束前 `git ls-remote origin refs/heads/dev` 相同。 |
| `python3 work/tuzi-rule-research-v2/validate.py` | 通过：50 个唯一规则、50 个证据节、37 组冲突比较；112 个源码行锚点覆盖 84 个不同文件，48 个历史提交均为固定 dev 的祖先，160 个引用定义与使用匹配。首跑校验器未识别初版的“候选规则”字段，修正脚本后通过，未改变证据分级。 |
| `npm run check:docs` | 通过：22 篇 Markdown、230 个本地链接／标题锚点。外部链接通过本地对象验证存在与版本，不代表 GitHub 页面已在线访问。 |
| `git diff --check` 与新文档逐行空白检查 | 通过；包含未跟踪文档的独立检查。 |
| tuzi-api `git status --short --branch` | 仍为 `feature/373-log-auto-refresh`，仅原有未跟踪 `.playwright-mcp/`；未切换分支、修改源代码或执行其脚本。 |

本轮仅更新上述两份规则文档并追加本记录；研究清单与校验结果保存在忽略的 `work/tuzi-rule-research-v2/`。Review Agent 基准仍为 `c4276b2f8ad94a98ce843786e08a0d469517a36c` 加原有工作区变更，其他未提交功能保持不动。没有逐一阅读全部 10,816 个可达提交，也没有逐个审核全部供应商适配器或核实真实生产行为。结构／引用检查不能证明语义无冲突；语义核对限于文档记录的范围和固定版本。

未运行 build、业务／数据库测试、依赖审计及 tuzi-api 测试，因为只有文档变更；没有启动待研究项目、真实支付、模型调用、GitHub 写操作或部署。无新增 delivery／Job／finding／Review／reply URL、业务模型角色、耗时或 usage；无新增运行时延迟、查询、内存或包体积开销。

规则仍是文档候选，未导入或激活 Memory。现有 PR／人类评论来源合同与导入入口限制仍适用，未来接入实际库时仍要核对已有规则；本轮没有扩展来源模型或伪造 PR／评论证据。

### 2026-11-09：管理页列表、统计与页面布局调整

按用户授权（“功能和界面布局上的修改，按照你的推荐，开始做吧”）在工作区 `feat/admin-ux`（基准 `a919117`，未提交、未推送）完成 5 项：

- **概览数字与 PR 审查列表**：概览的“需要处理”“本周审查”改由 `GET /api/overview` 在数据库里统计（近 7 天失败、超时或发布待核对），不再用首屏前 80 条任务估算；`/api/bootstrap` 不再带任务列表。新增导航“PR 审查”（`#reviews`）：全部审查记录，按仓库和状态筛选、翻页，条件写在地址里；`GET /api/jobs` 支持 `page`、`pageSize`、`repositoryId`、`status`、`type`，参数无效返回 422。运行记录页的执行过程时间线从表格单元格移到整行下方。
- **审查质量统计**：概览增加近 30 天“意见处理情况”：已发布的新意见里已修复、误判撤回、认可为例外、仍在讨论、没有回应各多少。不含没发布成功的审查和重复提到的旧意见。
- **团队规则页**：列表每页 20 条；适用范围最多显示 3 项，其余收成“+N”，单项过长时截断、鼠标停留看全文，完整内容在规则详情里；依据里的长路径不再撑出抽屉。
- **健康报告**：右侧增加一直停在视口里的“报告目录”（窄屏改为报告顶部一排可横向滚动的跳转按钮）；意见可按“必须改／建议改／可以不改”筛选；“全部”视图只展开必须改的意见，其余点标题展开。
- **仓库设置**：仓库页改为一行一个仓库的列表；点进 `#repositories/<id>` 后分“审查／健康检查／群内开发／开发任务”四个页签，切换页签不丢未保存的修改。原“设置 → 审查策略”并入“审查”页签，旧地址 `#settings/policy` 跳到仓库列表；健康检查页的定时设置改为显示当前频率和“修改设置”链接；群内开发从抽屉改为页签，任务列表单独一个页签。后端接口没有变化。

实际验证（均在 `work/admin-ux` 内）：

| 命令／操作 | 结果 |
| --- | --- |
| `npm test` | 通过：189 个用例，129 通过、0 失败、60 跳过（数据库用例和未安装 Semgrep 的用例）。 |
| `npm run test:db`（`DATABASE_URL` 指向本地 PostgreSQL，独立临时 schema） | 通过：58 个用例全部通过，0 跳过。含概览统计、审查列表翻页／筛选和无效参数用例。 |
| `npm run check:docs`、`npm run check:format`、`git diff --check` | 通过：29 篇 Markdown、277 个本地链接和锚点；175 个文件格式无改动。 |
| 本地预览（临时 schema + 真实 `createAdminHandler` + 替身登录和替身 GitHub，不连真实队列）用 Playwright 在 1440／768／390 宽度截图并量横向溢出 | 概览、PR 审查、运行记录、团队规则、健康报告、仓库列表与仓库设置各状态全部无页面级横向溢出；截图在忽略的 `work/ui-review/shots-ux/`。 |

演示数据覆盖：77 条规则（含超长英文类名、12 项适用范围）、40 条意见 + 12 处密钥 + 60 条规则扫描命中 + 75 个依赖漏洞的健康报告、0 条意见的报告、失败／超时／排队中的健康任务、超长仓库名、24 条包含路径、25 个开发成员、12 条保护规则、16 个开发任务、已暂停仓库、没有任何仓库的账号。逐张目视看过的截图：规则列表（1440、390）、规则末页（768）、规则依据抽屉、健康报告顶部／目录跳转／折叠展开（1440）、健康报告顶部和筛选（390）、0 条意见报告、仓库列表（1440）、超长仓库的审查页签（1440、390）和健康检查页签（390）、群内开发与开发任务页签（1440）、带仓库参数进入健康检查页（1440）。其余截图只做了溢出测量，没有逐张看。

限制：没有连接真实 GitHub 和真实登录；没有看 9 个以上仓库的列表、恰好 50 条开发任务时的提示和深色主题；规则内容里的 Markdown 代码块仍按纯文本显示；开发任务卡片本身的排版未改。无模型调用，无新增 delivery／Job／Review。
