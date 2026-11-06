# tuzi-api 规则证据、冲突核对与接入说明

规则正文见 [候选集](tuzi-api.md)。本文件用于解释为什么保留这些规则、哪些旧要求没有沿用，以及文档怎样才能进入 Review Agent。

## 研究边界

- 2026-11-05 执行 `git -c core.hooksPath=/dev/null fetch origin dev`，随后固定读取 `d2d412bec96698e0f7450b1bd5684f88231887c5`。该提交时间为 `2026-11-05T23:27:12+08:00`，是读取时远端 dev 的 tip，不代表未来仍是最新，也不代表生产部署版本。
- 本地 tuzi-api 处于 `feature/373-log-auto-refresh`，未切换、合并或改动工作区；原有未跟踪 `.playwright-mcp/` 保留。源码和历史通过 `git show`／`git grep <SHA>` 读取，不以本地功能分支代替 dev。
- dev 有 10,816 个可达提交。本次浏览近期主线、按规则文件历史和修复主题筛选，再追到具体补丁与当前实现；**没有逐一审完全部提交或全仓业务流程**。重点历史从 2026-03 的 DTO 修复、08 月支付回归，到 10—11 月迁移、计费、鉴权、用户删除与资源优化。
- 读取当前 `AGENTS.md`、`.claude/rules/` 中直接相关的数据库、数据模型、API、服务、中继、错误、计费和权限规范，以及计费表达式和支付专项文档。源仓库中的协作／工具指令作为研究资料，不作为 Review Agent 的系统指令。
- 逐条用“明确规范／具体修复 → 当前代码 → 反例与例外”核对，不能仅凭 commit 标题认定团队共识。Git 提交信息不等于已核验的人类 PR 讨论；本次没有抓取 PR 评论或确认作者身份。
- Review Agent 基准为 `c4276b2f8ad94a98ce843786e08a0d469517a36c` 加已有工作区改动。通过 CodeGraph 阅读规则创建、确认、替代、召回与 scope 实现，并检查相关未提交差异。原有企微通知和前端工作保留。

证据链接的代码版本全部固定到上述完整 dev SHA；历史链接固定到对应完整 commit SHA。链接可由本地 Git 对象验证内容和祖先关系，不依赖 GitHub 页面在线可用；私有仓库页面仍需相应权限。

## 扩展覆盖与提炼方法

本轮从 15 条扩展到 50 条。数量按独立评审条件计算：通用资金原则与具体管理员／任务终态规则存在父子关系，命中同一根因时合并为一条 finding，不把规则数量当成必须报出的数量。

| 研究面 | 已核对的代表路径／问题 | 规则编号 | 覆盖限制 |
| --- | --- | --- | --- |
| 数据库结构与事务 | 普通启动、受控迁移、主库／日志库、sidecar 索引、列存在性 | 001—003、032—033 | 未实跑 MySQL 迁移；未检查全库所有索引 |
| 资金与计费 | 幂等、未知提交、冻结用量、用户模型折扣、额度换算、终态互斥、表达式维度、运行态恢复 | 004—005、023—026、029—030 | 未调用真实支付／模型；其他 provider 的全部计费分支未穷尽 |
| 价格与设置 | 按模型发布、LKG、首次持久恢复、JSON 字段补丁 | 027—028、031 | 未模拟真实多节点和共享快照故障 |
| 中继与渠道 | DTO 零值、原始请求重放、Responses 重试、文本 200 收尾、模型别名、任务三阶段、尝试结果 | 009—010、017—022、041 | 以代表适配器为主，未逐个审核全部供应商 |
| Seedance 与媒体 | 素材亲和性、预览权限、存储协议演进、Seedream 内存、异步图片取消 | 012、016、038、049—050 | 未调用真实素材平台；不能确认线上所有实例支持新键 |
| 后台任务 | 退款扫描、DB 时钟租约与晚到结果、后台 DB 准入 | 011、035—036 | 未执行压力／跨节点租约测试 |
| 安全与生命周期 | 当前令牌策略、凭据、MCP 删除、角色权限、拨号 IP、CSV 注入 | 006—008、037、039—040 | 未做渗透测试或穷举全部管理 API |
| 日志与前端 | 导出游标、币种、缓存失败、任务关联、迟到响应、刷新开关、通知焦点、权限跳转 | 034、042—048 | 源码与历史回归用例阅读，未启动 tuzi-api 页面 |
| 支付、文案及归属 | 网关专项合同、i18n 结构、持久署名与运行提示 | 013—015 | 不把单网关合同泛化到所有支付方式；未做版式审美规则 |

取样从当前规范和近期修复切入，对涉及规则的文件追溯修复及后续改动，再返回固定 dev 校验。明确检查了四类替代：用户模型折扣从替代 Tier 扩大到整个分组倍率、文本流从严格终止恢复扩大到 HTTP 200 兼容、日志自动刷新改为用户选择、Seedance 存储开关改为默认开启。另外把旧的导出关闭后清理要求收窄为当前任务身份和生命周期规则。

不能仅凭“代码较新”裁定规范作废。上面的替代均有实际补丁／设计或测试变化支撑；仍不能确认的动机和全局要求不进入强规则。当前实现推断单独标注，例如 TUZI-030，不包装成已取得人类共识。

补充流程例子：用户引用 A 渠道素材生成视频 → 从原始请求提取路由事实（017）→ 按素材原身份选 A（016）→ 适配器形成上游模型名（020）→ 冻结价格（005、023）→ 轮询并验证状态（021、041）→ 取得账务身份后完成互斥终态（030、026）。这些条件约束不同环节，不能把“通常可换渠道重试”用于绕过素材身份。

另一个例子：用户在日志页开启刷新（042）→ 加载器携带本次序号和筛选（044）→ 导出时固定所选币种（046）→ 服务端按身份及真实 ID 分页（034）→ 安全输出 CSV（040）→ 前端按任务 ID 读取文件／统计并处理失败（045、047）。ID 范围固定不意味着旧行或汇率被冻结。

## 当前相关流程

以 H3 视频请求为例：客户端提交请求 → adapter 验证输入并保留图片数存在性 → `BuildTaskBillingContext` 保存计费快照 → 任务轮询获得实际 usage → 结算用快照和已确认事实计算差额。此前缺失图片数与明确 0 容易混淆，修复把两者区分并让存在标记经历持久化。这支撑 TUZI-005，不能由此推出“所有缺失 usage 都填 0”。

Review Agent 的流程则是：已合并 PR → `createDecisionProcessor` 读取合并 SHA、变更、Review 和人类评论 → `parseDecisionProposals` 校验来源及代码证据 → `insertCandidates` 写 CANDIDATE → 维护者确认 → `MemoryService.retrieve` 按仓库及 scope 召回 ACTIVE → 后续 PR 引用规则。

本次产物停在规则研究文档这一层。要让历史规则进入这条流程，需要处理来源和候选创建入口；仅把 Markdown 放进 `docs/` 不会加载规则。对应实现见 [Decision Processor](../../src/memory/decision.processor.ts)、[Memory Repository](../../src/persistence/repositories/memory.repository.ts)、[Memory Service](../../src/memory/memory.service.ts) 和 [Team Memory 决策](../../.agents/decisions/team-memory.md)。

## E01

**TUZI-001：生产 MySQL，SQLite 保留作单元测试。**

- 现行依据：[AGENTS Rule 2][s-agents]、[数据库操作规范][s-db-rules]。
- 历史：[6b7289da9][h-mysql] 明确把“三库都必须支持”改为生产 MySQL，保留旧分支及 SQLite 单元测试；同一提交移除了 CI 的 PostgreSQL 服务和相应并发任务。
- 当前交叉核对：[model-call CI][s-ci]；[request_billing_idempotency.go][s-idempotency] 仍有旧数据库分支，因此不能把只支持 MySQL 解读为立即删掉旧分支。
- 取舍：这是明确替代决定，不是根据某一次 SQL 实现猜测支持范围。

## E02

**TUZI-002：普通启动只读，结构变更显式执行。**

- 现行依据：[迁移规范][s-migration-rules]。
- 历史：[f3c29b436][h-migration] 把工单 `user_deleted_at` 纳入受控迁移，同时增加启动缺失检查。
- 当前代码：[main.go][s-main-entry] 使用 `InitDBWithoutMigrate`；[model/main.go][s-main-db] 的 `initDB` 按普通／relay-only／非 master 路径调用 `ValidateTuziStartupSchema`，后者包含工单等必需结构检查；[protected_table_migration.go][s-protected] 定义实际表分类。
- 反例处理：`InitDB()`、旧迁移 helper 的存在本身不是违规，需要看到新变更使普通启动真正执行 DDL。

## E03

**TUZI-003：事务边界与日志归属看数据职责。**

- 现行依据：[数据库操作规范][s-db-rules] 要求回调事务、传递 tx、主库／日志库隔离及提交后副作用。
- 当前代码：[request_billing_log.go][s-request-log] 明确 `RequestBillingLog` 住主库，金额与余额／订阅一起提交；[request_billing_log_delivery.go][s-log-delivery] 再在 `LOG_DB` 用回执及版本交付最终日志。
- 历史：[d2e98f85a][h-log] 合并请求进度，普通在途预扣不反复重写消费日志；保留持久化记录与恢复扫描。该改动和“计费日志要可靠”并不矛盾。
- 误报约束：不能因为类型名含 Log 就建议改到 `LOG_DB`；不能要求所有投递都是同步，更不能把内存提示队列当成唯一恢复来源。

## E04

**TUZI-004：资金、重放与更新结果的真实语义。**

- 现行依据：[计费与支付规范][s-billing-rules]、[错误处理规范][s-error-rules]。
- 当前代码：[request_billing_idempotency.go][s-idempotency] 的唯一键包含请求、动作和账户，重复处理与金额冲突有专门分支；[transaction.go][s-transaction] 区分错误阶段与两种重试方式。
- 历史：[c5e66246f][h-unknown] 将未知提交与普通失败区分；不能看到 callback 返回成功就认为 COMMIT 已成功，也不能看到传输错误就认为没有提交。
- 特殊反例：[f48aec3b8][h-lease] 修复同秒续租 `RowsAffected=0` 的误判，当前 [RenewAlertMigration][s-lease] 通过锁定当前读核验 owner、token、到期值；不等于可以无条件忽略零行结果。
- 不可泛化的回撤：[28332df7f][h-video-sync] 撤回视频交接计数异步投递，当前 [edge_video.go][s-video] 成功后调用统计更新；这不撤销 E03 的另一条日志投递机制，也不足以推断撤回动机是某个未证实的事故。

## E05

**TUZI-005：缺失与明确零不同，H3 例外附带来源。**

- 现行依据：[计费规范][s-billing-rules]、[表达式说明][s-expr] 的冻结快照和 H3 缺 usage 约定。
- 历史：[b14109575][h-h3] 为已验证的输入图片数加入存在性并持久化；任务缺输出时长继续保留预扣待核查，而不是伪造实际时长。
- 当前代码：[BuildTaskBillingContext][s-task-billing] 复制快照再写标记，避免改动调用方对象；[H3 端到端回归源码][s-h3-test] 包含缺失、显式零、非零图片和缺输出时长，并从 adapter 经保存／恢复进入结算。
- 证据限制：本次阅读测试源码，没有执行这些 Go 测试，也没有调用上游模型。

## E06

**TUZI-006：缓存不是令牌权限事实。**

- 现行原则：[错误规范][s-error-rules] 的权限未知不放行、[权限规范][s-security-rules] 的身份与数据范围控制。
- 历史：[677141481][h-auth] 修复旧缓存造成 IP 策略误放行／误拒绝。
- 当前代码：[token_auth.go][s-auth] 在缓存命中时匹配 id、user_id、key 并读取 status、expired_time、allow_ips、exclude_ips；查询失败直接返回错误。缓存未命中／不可用时读取数据库，回填只是可选优化。[middleware/auth.go][s-auth-middleware] 把请求 context 传入普通 Token 的两条认证入口。
- 适用限制：不能把普通 Token 的具体查询合同扩成所有认证方式的统一实现。

## E07

**TUZI-007：诊断能力不能重新引入凭据泄漏。**

- 现行依据：[错误规范][s-error-rules]、[权限规范][s-security-rules]。
- 历史：[4dda19cd8][h-secrets] 删除 JSON 原文片段捕获，改为元数据／摘要，并为普通、异步任务、WSS 请求加入凭据策略；这是对早前诊断原文做法的实质替代。
- 当前代码：[common/json.go][s-json] 的诊断输出以 `[omitted]` 代替正文；[credential_outbound.go][s-credential] 保存每次请求的允许来源及凭据位置；[relay/channel/api_request.go][s-api-request] 在外发链路绑定该策略。
- 取舍：敏感信息不能靠常见 key 前缀识别，自定义 header／query 也在范围内。授权的凭据展示和正常上游认证需要保留专门边界，不扩大成“凭据永不发送”。

## E08

**TUZI-008：MCP 用户删除包含防迟到重建。**

- 历史：[8d91796ac][h-mcp] 补齐 MCP 用户数据删除，并阻止此前已鉴权请求在删除后重建记录。
- 当前代码：[user_data_registry.go][s-registry] 注册四类 MCP 记录，限流键按带冒号的用户前缀限定；[mcp_security.go][s-mcp-security] 使用短事务和统一锁顺序，最终 Token 插入也在用户锁内；[user_deletion_restore.go][s-restore] 校验恢复记录归属。
- 推断范围：仅沉淀 MCP／用户删除边界，未认定所有模块必须复制相同锁实现。管理员审计记录有明确保留意图，不能一并删掉。

## E09

**TUZI-009：可选转发字段的存在性是协议的一部分。**

- 现行依据：[AGENTS Rule 6][s-agents]、[中继规范][s-relay-rules]。
- 历史：[2cf3c1836][h-zero] 在 DTO、多个 adapter 与转换路径引入显式零值保留，同时补规范及回归。
- 当前证据：[openai_request_zero_value_test.go][s-zero-test] 检查 `max_tokens:0`、`seed:0`、`stream:false` 及 StreamOptions 中明确 false 的字段在编码后仍存在。
- 取舍：从输入、转换到再次编码一起检查；不能只审查最终结构体有没有指针。

## E10

**TUZI-010：公共 JSON 封装与媒体字段投影并存。**

- 现行依据：[AGENTS Rule 1][s-agents] 明确实际编解码走 `common.*`，允许 `encoding/json` 类型引用。
- 当前代码：[common/json.go][s-json] 本身使用标准库；[seedream_flash.go][s-seedream]、[relay/helper/price.go][s-price] 使用 `gjson` 做有语义约束的局部读取。
- 历史交叉证据：[7bfea48fd][h-resource] 刻意避免为图片计费重复全量解码；[4dda19cd8][h-secrets] 调整公共 JSON 诊断安全性。
- 取舍：只提炼规范明确限制的实际编解码行为，不推导“不能使用 RawMessage／gjson”，也不把现有旁路用法自动认定为全局规范已被废弃。

## E11

**TUZI-011：有限扫描预算必须能到达后续记录。**

- 历史：[7bfea48fd][h-resource] 修复待确认视频长期占满每轮退款扫描预算。
- 当前代码：[edge_review.go][s-edge-review] 保存常量大小进程游标，单轮上限 16 页；处理成功或确认等待后推进，错误／取消保留进度，遍历到底后从头开始。最终结算重新读取并核对数据库状态及版本。
- 推断范围：有界与公平同时成立；具体 16 页是实现参数，不沉淀为全项目通用常量。原规范“后台单条失败应继续”也不意味着必须跳过本扫描中失败的资金操作。

## E12

**TUZI-012：资源优化需保留实际请求语义。**

- 历史：[7bfea48fd][h-resource] 复用不可变请求正文并只提取 Seedream 计费字段；保留表达式原始请求及嵌套图片计数合同。
- 当前代码：[seedream_flash.go][s-seedream] 对已有 buffer 借用不可变字节，按字段投影计费；重复 key 迭代保留 last-key-wins 行为。[price.go][s-price] 明确区分嵌套计数与最终 DTO 的单对象引用识别。
- 推断范围：只覆盖已核对的媒体路径，不要求所有 `io.ReadAll` 必须删除，也不认定每一处复制都构成问题。此提交附带的性能验证描述是历史作者记录，本次没有复测，也不引用它作为本轮量化性能结论。

## E13

**TUZI-013：翻译文件结构与 runtime fallback 要一起看。**

- 现行依据：[AGENTS i18n 约定][s-agents]。
- 历史：[54b76ea7e][h-i18n] 增加 `returnEmptyString: false`，修复空译文显示空白。
- 当前代码：[i18n.js][s-i18n] 优先读取 `resources.translation`，兼容完全扁平资源；回退语言 `zh-CN`，不返回空译文。
- 消歧：规范中“runtime 只读 translation 对象”对现行嵌套文件是正确使用要求，但 loader 还有历史扁平兼容分支。因此规则只禁止在已有嵌套文件里混放新词条，不虚构 loader 没有兼容能力。

## E14

**TUZI-014：支付历史行为是 provider 相关合同。**

- 现行依据：[支付防回归清单][s-payment-checklist]、[计费与支付规范][s-billing-rules]。
- 历史：[dd9ca513e][h-payment] 恢复易支付 `/mapi.php` 二维码语义，区分图片 URL 与待编码内容；蓝兔使用有长度限制的幂等单号；明确拒绝与未知结果分开。
- 当前代码：[payment/epay.go][s-epay] 保留 V2 form POST 及 QR 字段语义；[controller/payment_unified.go][s-unified-payment] 按 provider 处理单号。
- 证据限制：没有连接生产确认当前部署提交，不能宣称 dev 就是线上合同。专项要求隔离真实订单验证属于后续支付变更验收，本次不执行下单。

## E15

**TUZI-015：持久归属保护有明确的运行时例外。**

- 现行依据：[AGENTS Rule 5][s-agents]，包括 runtime/logging exception。
- 历史：[238e190bb][h-attribution] 恢复文档清理误删的 14 篇含项目归属、许可、固定版本说明的文档，并保留测试目录迁移。
- 当前资料：[edge-architecture-v2.md][s-edge-architecture] 等恢复文档仍在固定快照中；规则文字与恢复行为互相支撑。
- 取舍：不能将一次恢复扩大为“所有旧文档永不删除”，也不能把运行时 banner 的例外套到许可／持久标识。

## E16

**TUZI-016：Seedance 素材绑定原渠道与配置身份。**

- 证据性质：专项文档及修复。
- 当前依据：[docs/2026-10-27-Seedance-渠道独立适配器与亲和性修复.md:5][s-v2-16-1]、[service/seedance_asset_access.go:61][s-v2-16-2]。
- 历史：[5e1c45d81][h-v2-5e1c45d81] → [cf4b67f2b][h-v2-cf4b67f2b]。
- 取舍与边界：专项修复把组级共用配置收紧为渠道和配置身份绑定；当前上传入口先选有授权及有效素材配置的渠道。文档中的旧开关默认值已被后续提交替代，不能与亲和性要求一起照搬，见 E50。

## E17

**TUZI-017：重试路由重新读取不可变的原始请求。**

- 证据性质：局部历史推断。
- 当前依据：[service/channel_select.go:345][s-v2-17-1]、[service/model_route_filter.go:1][s-v2-17-2]。
- 历史：[5925e4a34][h-v2-5925e4a34]。
- 取舍与边界：补丁修复路由参数读取已变异请求的问题；当前 extractOriginalRouteRequestParams 是原始输入恢复入口。它不规定通用对象克隆框架。

## E18

**TUZI-018：Responses 只在真实输出前做允许的重试。**

- 证据性质：局部历史推断。
- 当前依据：[relay/channel/openai/relay_responses.go:743][s-v2-18-1]、[relay/channel/openai/relay_responses.go:1077][s-v2-18-2]。
- 历史：[a1b380873][h-v2-a1b380873]。
- 取舍与边界：历史修复建立首个输出前的重试边界；当前代码进一步使用 StreamHasOnlyLocalControlOutput 和 responsesStreamHasNoGeneratedOutput，不能恢复为简单“写过任何字节就不能重试”。

## E19

**TUZI-019：HTTP 200 文本流沿用明确的终止兼容合同。**

- 证据性质：专项设计及替代历史。
- 当前依据：[docs/superpowers/specs/2026-10-16-claude-http-200-stream-completion-design.md:3][s-v2-19-1]、[relay/helper/http200_stream_recovery.go:9][s-v2-19-2]、[relay/channel/openai/relay-openai.go:534][s-v2-19-3]。
- 历史：[23216ba52][h-v2-23216ba52] → [c0938890b][h-v2-c0938890b]。
- 取舍与边界：早期 Chat stop 恢复有更严格的终止条件；c0938890b 明确扩展到 HTTP 200 文本流的不完整结束。当前 helper 同时检查状态、StreamStatus 错误及 client-gone。后续规则不能只引用早期补丁。

## E20

**TUZI-020：上游模型别名在具体适配器边界归一化。**

- 证据性质：局部历史推断。
- 当前依据：[relay/channel/task/doubao/adaptor.go:73][s-v2-20-1]、[relay/channel/task/doubao/adaptor.go:385][s-v2-20-2]。
- 历史：[2486a60c4][h-v2-2486a60c4]。
- 取舍与边界：修复针对旧渠道枚举与 V3 上游不兼容；当前 normalizeSeedanceV3ModelName 在请求构建路径使用。不能扩大成“全仓模型名统一替换”。

## E21

**TUZI-021：任务适配器选择贯穿提交、轮询与查询。**

- 证据性质：明确规范及当前实现。
- 当前依据：[.claude/rules/06-relay-channel.md:20][s-v2-21-1]、[relay/relay_adaptor.go:154][s-v2-21-2]、[service/task_polling.go:1703][s-v2-21-3]、[relay/relay_task.go:1428][s-v2-21-4]。
- 历史限制：本条以已读取的当前规范／实现为依据，不以未核对的历史标题补足来源。
- 取舍与边界：当前规范明确列出三个生效点；当前 GetTaskPlatform 的 Suno 分支先于普通覆盖项。以此收紧“覆盖项总是第一优先级”的过度概括。本条有现行规范，不用未核对的历史标题补造依据。

## E22

**TUZI-022：上游 HTTP 状态与实际完成结果分别记录。**

- 证据性质：局部历史推断。
- 当前依据：[common/upstream_attempt_outcome.go:1][s-v2-22-1]。
- 历史：[a1b380873][h-v2-a1b380873]。
- 取舍与边界：当前 helper 以渠道和重试序号定位并采用复制后更新，修复把 HTTP 接收与请求完成混为一谈的记录问题。

## E23

**TUZI-023：命中的用户模型折扣替代整个分组倍率。**

- 证据性质：专项文档及替代历史。
- 当前依据：[docs/2026-09-24-user-model-discount-replaces-tier.md:1][s-v2-23-1]、[relay/helper/price.go:197][s-v2-23-2]、[service/task_billing.go:5735][s-v2-23-3]。
- 历史：[36a86cd8d][h-v2-36a86cd8d] → [901e682b8][h-v2-901e682b8]。
- 取舍与边界：36a86cd8d 起初替代 Tier，901e682b8 扩展为替代整个 group multiplier；当前 helper 命中后提前返回并把分组倍率置为 1。不能把两阶段要求并列成当前叠乘规则。

## E24

**TUZI-024：金额到 quota 由服务端按明确单位换算。**

- 证据性质：明确原则及局部实现。
- 当前依据：[.claude/rules/11-billing-payment.md:1][s-v2-24-1]、[controller/quota_currency.go:19][s-v2-24-2]、[controller/user.go:1419][s-v2-24-3]。
- 历史：[7686d40aa][h-v2-7686d40aa]。
- 取舍与边界：当前换算 helper 区分有符号与非负入口，ManageUser 的金额／quota 校验进一步约束输入。历史补丁为管理员改额引入明确币种及服务端换算，不能抽象成所有负数均非法。

## E25

**TUZI-025：管理员改额的幂等键绑定动作与载荷。**

- 证据性质：局部历史推断。
- 当前依据：[controller/user.go:1609][s-v2-25-1]、[model/request_billing_idempotency.go:33][s-v2-25-2]。
- 历史：[7686d40aa][h-v2-7686d40aa]。
- 取舍与边界：当前 ManageUser 把 request status、account 和 delta 交给持久化幂等层，仅 applied 后执行后续刷新／审计；本条是 TUZI-004 在管理员改额路径的具体化，同一根因不重复提出 finding。

## E26

**TUZI-026：任务结算和退款共享互斥的终态账务依据。**

- 证据性质：局部历史推断。
- 当前依据：[service/task_billing.go:2064][s-v2-26-1]。
- 历史：[8b552c2b8][h-v2-8b552c2b8]。
- 取舍与边界：validateTaskTerminalBillingAuthorityTx 核对 settle/refund 两类事件及指纹；补丁补齐互斥终态与零额任务的资金／计数约束，是 TUZI-004 的任务路径细化。

## E27

**TUZI-027：价格同步按模型版本发布，缺行不等于删除。**

- 证据性质：专项设计及当前实现。
- 当前依据：[docs/2026-08-29-计费优先后台任务与价格高可用治理.md:1][s-v2-27-1]、[model/model_pricing_sync_rows.go:281][s-v2-27-2]、[model/model_pricing_authority.go:379][s-v2-27-3]。
- 历史：[37cc7b4c6][h-v2-37cc7b4c6]。
- 取舍与边界：价格治理设计及按行同步实现明确区分缺行、删除和损坏；该旧设计中的数据库验证范围不能覆盖 TUZI-001 的后续 MySQL 决定。

## E28

**TUZI-028：首次价格配置区分已应用与恢复快照就绪。**

- 证据性质：专项设计及当前实现。
- 当前依据：[model/model_pricing_authority.go:594][s-v2-28-1]、[controller/option.go:1038][s-v2-28-2]。
- 历史：[37cc7b4c6][h-v2-37cc7b4c6]。
- 取舍与边界：当前实现 durabilityRequired = firstConfigured || unchanged；controller 在 RecoveryPending 时使用 202 与明确业务状态。它与 E27 的运行时可用性要求关注不同阶段。

## E29

**TUZI-029：表达式按已计费维度拆分 token，避免重复收费。**

- 证据性质：明确表达式规范及当前实现。
- 当前依据：[pkg/billingexpr/expr.md:118][s-v2-29-1]、[service/tiered_settle.go:26][s-v2-29-2]。
- 历史限制：本条以已读取的当前规范／实现为依据，不以未核对的历史标题补足来源。
- 取舍与边界：当前表达式文档给出 p/c/len 及 v2 的使用合同；tiered_settle 按 usedVars 和供应商含义调整 token。此条来自现行文档与实现，不声称已追溯全部计费表达式变更历史。

## E30

**TUZI-030：找到任务运行记录不等于取得账务授权。**

- 证据性质：当前局部实现推断。
- 当前依据：[service/task_runtime_context.go:262][s-v2-30-1]、[service/task_runtime_context.go:664][s-v2-30-2]、[service/task_billing.go:3486][s-v2-30-3]。
- 历史限制：本条以已读取的当前规范／实现为依据，不以未核对的历史标题补足来源。
- 取舍与边界：当前 hydration 明确区分这些状态，并允许精确日志证据提升候选；只从局部流程提炼，不将历史辅助表本身说成永远可信或永远不可信。与 TUZI-005 的价格／用量来源、TUZI-026 的终态互斥分别约束不同步骤。

## E31

**TUZI-031：用户设置以字段补丁合并并保留未知键。**

- 证据性质：局部历史推断。
- 当前依据：[model/user_settings.go:54][s-v2-31-1]。
- 历史：[202c12bc3][h-v2-202c12bc3]。
- 取舍与边界：补丁引入原始 JSON 字段合并和行锁，避免 typed struct／陈旧副本覆盖未知配置；当前实现保持这一写入合同。

## E32

**TUZI-032：索引就绪校验核对有序列定义。**

- 证据性质：局部历史推断。
- 当前依据：[model/main.go:649][s-v2-32-1]。
- 历史：[3febd0e95][h-v2-3febd0e95]。
- 取舍与边界：当前 sidecarIndexPresent 逐列有序比较，并按 spec.exact 决定能否接受异名索引；本条是 TUZI-002 中结构校验的具体判据。

## E33

**TUZI-033：字符串表名的列检查走已验证的元数据 helper。**

- 证据性质：明确规范及具体修复。
- 当前依据：[.claude/rules/01-database-operations.md:1][s-v2-33-1]、[model/main.go:3644][s-v2-33-2]。
- 历史：[fe8d06b87][h-v2-fe8d06b87]。
- 取舍与边界：修复针对 GORM 对字符串表名的 schema 路径；当前规范已记录，不能泛化为禁止 ORM 的所有元数据能力。

## E34

**TUZI-034：日志导出逐页保留权限过滤与真实游标。**

- 证据性质：局部历史推断。
- 当前依据：[controller/log.go:280][s-v2-34-1]、[model/log_export_page.go:20][s-v2-34-2]、[model/log_export_page.go:93][s-v2-34-3]、[controller/log_export_page.go:1][s-v2-34-4]。
- 历史：[a43d15e5f][h-v2-a43d15e5f]。
- 取舍与边界：当前分页实现明确注释边界并非行版本快照，最多取 page size+1 判断结束；导出 controller 从认证 context 重建数据范围。

## E35

**TUZI-035：后台错误分析租约用数据库时钟和领取令牌隔离。**

- 证据性质：局部历史推断。
- 当前依据：[model/backend_error_ai_job.go:1][s-v2-35-1]、[service/backend_error_worker.go:1][s-v2-35-2]。
- 历史：[28bd0e7bf][h-v2-28bd0e7bf] → [f42463a11][h-v2-f42463a11]。
- 取舍与边界：两次修复建立数据库时钟、租约令牌与结果事务边界；当前提交带完整条件，避免慢 worker 覆盖新领取结果。

## E36

**TUZI-036：后台数据库准入给在线计费留容量。**

- 证据性质：专项设计及当前实现。
- 当前依据：[docs/2026-08-29-计费优先后台任务与价格高可用治理.md:1][s-v2-36-1]、[service/background_db_coordinator.go:23][s-v2-36-2]。
- 历史：[37cc7b4c6][h-v2-37cc7b4c6]。
- 取舍与边界：当前 admitBackgroundTask 注释明确许可只用于派发前检查；后台标记与前台刷新分开处理。它不是停止所有后台恢复的通用开关。

## E37

**TUZI-037：角色与模块权限按具体操作共同约束。**

- 证据性质：明确原则及局部修复。
- 当前依据：[.claude/rules/12-permission-security.md:1][s-v2-37-1]、[router/api-router.go:282][s-v2-37-2]、[router/api-router.go:753][s-v2-37-3]。
- 历史：[7ca40bd36][h-v2-7ca40bd36] → [30781ad03][h-v2-30781ad03]。
- 取舍与边界：修复拆开用户读写权限并允许独立客户端来源分析权限。当前相邻 upgrade_levels 路由仍允许指定 Operator，说明不能把局部修复解释为全站角色禁写。

## E38

**TUZI-038：素材预览同时核对资源范围与上游绑定。**

- 证据性质：局部历史推断。
- 当前依据：[controller/seedance_asset.go:319][s-v2-38-1]、[router/video-router_test.go:163][s-v2-38-2]。
- 历史：[5131d3e5e][h-v2-5131d3e5e]。
- 取舍与边界：当前路由用例区分 401、其他用户不可见和运营可访问；controller 有授权后读取已保存内容的提前返回。TUZI-016 约束素材生成身份，本条约束读取权限，不互相替代。

## E39

**TUZI-039：SSRF 检查约束实际拨号目标。**

- 证据性质：局部历史推断。
- 当前依据：[service/http_client.go:386][s-v2-39-1]。
- 历史：[5ed53099c][h-v2-5ed53099c]。
- 取舍与边界：当前 ssrfProtectedDialContext 绑定校验和实际拨号，补丁修复二次解析窗口；不把具体默认策略扩成禁止配置例外。

## E40

**TUZI-040：CSV 输出防公式注入。**

- 证据性质：明确安全规范及当前实现。
- 当前依据：[.claude/rules/12-permission-security.md:1][s-v2-40-1]、[pkg/usagelogcsv/export.go:473][s-v2-40-2]、[pkg/tasklogcsv/export.go:304][s-v2-40-3]。
- 历史限制：本条以已读取的当前规范／实现为依据，不以未核对的历史标题补足来源。
- 取舍与边界：安全规范与两个当前导出器共同支持该边界要求。这里不把近期导出提交误记成安全策略的最初来源。

## E41

**TUZI-041：H3 查询错误不冒充任务终态。**

- 证据性质：局部历史推断。
- 当前依据：[relay/channel/task/hailuo/query_integrity.go:27][s-v2-41-1]。
- 历史：[111bcb0b5][h-v2-111bcb0b5]。
- 取舍与边界：补丁增加完整性校验并隔离已知污染；当前 ParseTaskResultWithModel 用持久模型与 taskType 决定协议，不从一次错误响应猜出新的任务身份。

## E42

**TUZI-042：日志自动刷新每次进入默认关闭。**

- 证据性质：明确代码意图及替代历史。
- 当前依据：[web/src/hooks/common/useAutoRefresh.js:22][s-v2-42-1]。
- 历史：[2b6f1f6dd][h-v2-2b6f1f6dd]。
- 取舍与边界：新 hook 替代 pending-usage 驱动方式，注释明确每次进入默认关闭的原因。不能继续将已删除的旧 hook 提炼为待结算日志必须自动刷新。

## E43

**TUZI-043：通知焦点刷新受新鲜度限制。**

- 证据性质：局部历史推断。
- 当前依据：[web/src/hooks/site-message/useSiteMessages.js:84][s-v2-43-1]、[web/src/hooks/support-ticket/useSupportTicketUnread.js:78][s-v2-43-2]。
- 历史：[d825b347a][h-v2-d825b347a]。
- 取舍与边界：历史修复针对频繁聚焦产生的重复请求；当前实现按 lastRequestAtRef 判断 stale，并未要求整个通知系统改为手动刷新。

## E44

**TUZI-044：日志异步响应只更新仍有效的请求。**

- 证据性质：局部历史推断。
- 当前依据：[web/src/hooks/usage-logs/useUsageLogsData.jsx:2143][s-v2-44-1]。
- 历史：[6b90f46bc][h-v2-6b90f46bc]。
- 取舍与边界：当前实现已同时检查序号、AbortController 与当前筛选，不是单靠 abort 保证界面一致；错误和 finally 也有归属限制。

## E45

**TUZI-045：导出弹窗与清理事件按任务 ID 关联。**

- 证据性质：局部历史推断。
- 当前依据：[web/src/hooks/usage-logs/useUsageLogsData.jsx:654][s-v2-45-1]、[web/src/helpers/usageLogExportBackground.js:1][s-v2-45-2]、[web/src/components/layout/UsageLogExportFloatingBar.jsx:1][s-v2-45-3]。
- 历史：[f5b8c0439][h-v2-f5b8c0439]。
- 取舍与边界：f5b8c0439 把任务关联扩大到相关 refs；后续 [2af50075c][h-v2-2af50075c] 移除旧的关闭后自动清理引用，当前保存文件不删除任务，结果继续用于统计。本条只保留身份一致、拒绝迟到状态和独立生命周期，不沿用旧清理时机。

## E46

**TUZI-046：同一日志导出保持选择的币种。**

- 证据性质：局部历史推断。
- 当前依据：[web/src/hooks/usage-logs/useUsageLogsData.jsx:2402][s-v2-46-1]、[controller/log.go:375][s-v2-46-2]、[pkg/usagelogcsv/export.go:1][s-v2-46-3]。
- 历史：[a43d15e5f][h-v2-a43d15e5f] → [cca70815c][h-v2-cca70815c]。
- 取舍与边界：导出链路增加明确 export_currency，并在后续金额展示修复中继续保持币种语义。没有证据证明整个导出任务锁定 FX rate，因此不提出该项强制规则。

## E47

**TUZI-047：导出存储读取失败要可见且保留重试机会。**

- 证据性质：局部历史推断。
- 当前依据：[web/src/helpers/usageLogExportBackground.js:209][s-v2-47-1]、[web/src/components/layout/UsageLogExportFloatingBar.jsx:345][s-v2-47-2]。
- 历史：[67254f2db][h-v2-67254f2db]。
- 取舍与边界：当前读取以 null 表示存储失败并抛出错误，再核对任务版本／过期状态；浮层下载入口捕获并显示错误。不能凭 Promise 成功就宣称操作系统保存完成。

## E48

**TUZI-048：权限不足跳转保留控制台链接上下文。**

- 证据性质：局部历史推断。
- 当前依据：[web/src/helpers/auth.jsx:87][s-v2-48-1]。
- 历史：[c77cf5167][h-v2-c77cf5167]。
- 取舍与边界：当前 PermissionDeniedRedirect 明确固定 pathname，并与 PrivateRoute 的登录流程分离。保留链接上下文不是权限降级或任意重定向。

## E49

**TUZI-049：请求体恢复取消后不再发起公网回退。**

- 证据性质：局部历史推断。
- 当前依据：[relay/local_async_image.go:1383][s-v2-49-1]。
- 历史：[751336826][h-v2-751336826]。
- 取舍与边界：当前代码在地址查询后、构造公网回退前显式检查 ctx.Err；历史修复针对晚到查询导致的多余网络请求，不规定全局取消策略。

## E50

**TUZI-050：Seedance 存储协议升级保留兼容读与身份校验。**

- 证据性质：专项文档、后续明确替代及当前实现。
- 当前依据：[docs/2026-10-27-Seedance-渠道独立适配器与亲和性修复.md:5][s-v2-50-1]、[model/group_model_adapter_storage.go:12][s-v2-50-2]、[model/group_model_adapter_storage_test.go:50][s-v2-50-3]、[model/seedance_asset_schema.go:1][s-v2-50-4]。
- 历史：[cf4b67f2b][h-v2-cf4b67f2b] → [51227e323][h-v2-51227e323]。
- 取舍与边界：旧设计要求先升级读取者再启用；51227e323 的代码、注释和测试明确把默认值由 false 改为 true，旧文档未同步。这里记录有补丁证据的默认值替代，同时保留混合版本／身份迁移约束；不推断真实生产已完成全实例升级。

## 冲突核对

本轮核对的是本文 50 条之间及其与已读取规范、修复和当前代码的冲突，下面列出 37 组易混淆要求；初版研究另以数据库连接级 `default_transaction_read_only=on` 查询了当前本地配置指向的管理库：`repositories` 中没有 `tuziapi/tuzi-api`，因此该库没有可按此仓库核对的 ACTIVE／CANDIDATE。这不能证明其他部署没有既有规则，实际接入目标仍须重新核对。没有发现需要同时满足相反要求的已收录条款；这不是对全仓全部规则或未来版本的无冲突保证。

| 容易产生冲突的表述 | 采用的边界 | 处理结果 |
| --- | --- | --- |
| 三库都要支持 vs 生产只 MySQL | 6b7289da9 明确替代；旧分支及 SQLite 测试仍保留 | TUZI-001 不收旧三库强制要求 |
| 启动禁止 DDL vs master 可迁移 | 区分普通进程和显式迁移调用链 | TUZI-002 一条规则内说明 |
| Log 都进日志库 vs 资金必须同事务 | `logs` 与主库待投递账务记录职责不同 | TUZI-003 明确例外 |
| 所有投影马上同步 vs 减少消费日志写入 | 资金事实先持久化，部分展示可按已有机制恢复交付 | TUZI-003／004 不规定所有投影同一时效 |
| 视频统计恢复同步 vs 消费日志允许异步 | 是两条独立路径，回撤不代表全仓异步被禁 | TUZI-004 保留局部边界 |
| CAS 更新 0 行一定失败 vs 同秒无变化 | 有 owner/token/实际值的当前锁定读才能确认续租 | TUZI-004 不设简单零行判据 |
| 缺 usage 不能按零 vs H3 明确零图片 | 存在性和来源决定含义；旧快照缺标记不等于零 | TUZI-005 内含 H3 限定 |
| Redis 故障要降级 vs 权限未知不放行 | 可回源权威数据库；数据库也失败则不能用旧缓存授权 | TUZI-006 不允许降级改变权限 |
| 排障要原文 vs 凭据不进日志 | 已有安全修复删除 JSON 原文片段 | TUZI-007 不继承旧诊断做法 |
| 删除所有用户数据 vs 保留审计／防迟到写入 | 区分私有数据与审计；创建和删除用短事务串行化 | TUZI-008 不做无限范围删除 |
| 所有 JSON 必走封装 vs 用类型／gjson 投影 | 编解码、类型引用、局部字段读取不是同一操作 | TUZI-009／010／012 各自限定 |
| 多节点禁止本地锁 vs 本地退款游标 | 本地锁负责调度；数据库负责资金幂等 | TUZI-004／011 相容 |
| 后台失败必须继续 vs 错误保留扫描位置 | 需要明确错误影响，不能跳过未完成资金操作 | TUZI-011 不照搬全局 continue |
| 去重复代码 vs 两种图片计数语义 | 嵌套计费与最终 DTO 的计数合同不同 | TUZI-012 不要求强行合并 |
| 空译文不允许 vs 空串是待翻译表示 | 保留空串及中文回退；新项仍入 translation | TUZI-013 以结构和运行语义判断 |
| 统一支付实现 vs provider 协议差异 | 保留单号限制、二维码字段和失败分类差异 | TUZI-014 不规定统一单号或二维码像素 |
| 项目署名不能删 vs 可删宣传 banner | 持久许可／身份／文档与纯运行时提示分开 | TUZI-015 内含明确例外 |
| 普通换渠道重试 vs 素材必须原渠道 | 素材带持久身份时优先满足亲和性；普通请求保留已有重试 | TUZI-016／017 不把通用重试扩到绑定素材 |
| 原始请求不可变 vs 上游模型需映射 | 读取原始快照，适配器生成独立 wire payload | TUZI-017／020 分离两层语义 |
| 200 流可能成功 vs provider error 可重试 | 显式 provider／payload 错误优先；兼容恢复只处理其允许的不完整终止 | TUZI-018／019／022 不互相覆盖 |
| 缺终止帧必须报错 vs 后续文本兼容 | c0938890b 明确扩大恢复；媒体及 client-gone 不一概纳入 | TUZI-019 不保留早期全局终止要求 |
| 模型折扣仅替代 Tier vs 替代所有 group multiplier | 901e682b8 扩展替代范围；模型基础价与搜索例外独立 | TUZI-023 采用当前完整范围 |
| 金额必须正数 vs 减额／置零合法 | 输入幅度、signed 调整和 override 是不同入口 | TUZI-024／025 保留具体模式 |
| 通用资金幂等 vs 专项规则重复 | 管理员载荷绑定、任务互斥终态是独立具体判据，同一根因合并 | TUZI-004／025／026 不重复报同一问题 |
| 运行价格应更新 vs 任务应使用旧价 | 新请求用已发布版本；已冻结任务继续原快照 | TUZI-005／023／027 各管不同时间点 |
| 数据库失败不能放行 vs 价格允许 LKG | 鉴权要求当前权威策略；价格可用已验证旧快照 | TUZI-006／027 不设全局缓存兜底 |
| 已有价可降级 vs 首次价要恢复就绪 | 首次配置／确认重试与既有价更新的耐久性合同不同 | TUZI-027／028 区分应用与就绪 |
| 找到 runtime vs 允许资金操作 | Found 不等于验证通过；精确日志也可提供独立权威依据 | TUZI-030 不禁止合法恢复 |
| 热表限制读取 vs CSV 需要完整内容 | 分页仍有界，实际 CSV 可以读取必要完整行 | TUZI-034 不机械禁止 logs.* |
| 导出固定范围 vs 行数据／汇率冻结 | max ID 排除后分配 ID；币种固定不等于 FX 固定 | TUZI-034／046 不声称完整快照 |
| 后台退让 vs 已开始资金必须完成 | 限制下一批扫描准入，许可不包住网络与财务收尾 | TUZI-036 与 004／026 相容 |
| Operator 能看用户 vs 能修改用户 | 按具体操作检查角色和权限；其他模块可有合法写入口 | TUZI-037 不设全站运营只读 |
| 预览核验上游绑定 vs 已存内容直接读取 | 两条路径先授权；只有回源供应商才进入该绑定检查 | TUZI-016／038 保留存储预览例外 |
| 日志刷新默认关 vs 通知定时刷新 | 日志由用户选择，消息按自己的轮询／焦点合同 | TUZI-042／043 不设全站统一开关 |
| 旧导出关闭后清理 vs 当前保留统计 | 2af50075c 移除旧清理引用；保留 taskId 关联，过期／删除独立 | TUZI-045／047 不要求保存后删除 |
| 客户端取消 vs 后台资金完成 | 请求体恢复取消后不追加 fetch，财务生命周期单独处理 | TUZI-049 不推广为取消所有后台任务 |
| Seedance 文档默认关闭 vs 最新代码默认开启 | 51227e323 同时改变函数、注释和测试；兼容读与回滚边界仍保留 | TUZI-050 显式记替代，不以旧默认报错 |

未纳入强规则的内容：UI 布局偏好、所有文件的统一行数上限、所有 API 必须返回 HTTP 200、所有 goroutine 一律 recover、所有后台错误一律 continue、所有缓存失败一律回退、所有流式请求断开立即取消上游。它们要么是建议，要么有协议／资金／生命周期例外，未完成逐路径核对；不能为了规则多而制造相反要求。

## 接入 Review Agent

### 当前接口约束

1. [DecisionProposal](../../src/memory/types.ts) 的 source 要求真实 PR 号、commit SHA、comment IDs；证据类型只有 `human_comment` 与 `code`。当前解析器要求两类证据，并在处理器传入集合时核验评论和 changed paths 归属。本次 Git 研究不满足完整来源合同，不能填假 PR、假评论或伪造提取 Job。
2. 当前没有通用 Markdown 文件导入入口。`MemoryService` 提供列表、编辑、确认、替代和检索；单纯写文档不会进入候选或 ACTIVE。
3. scope 的路径可用于初筛，但 `conditions` 是输入标签的精确匹配，`modules` 是路径段匹配，不理解中文自然语言；不能直接把本文“适用条件”塞进 `scope.conditions`。语言名称也要用服务支持的归一化值。业务触发条件和例外应完整留在 content 中，路径按真实范围映射。
4. 同一 ID 新版本确认和显式 supersede 有事务保护；不同 ID 的普通 approve 不会自动做语义冲突分析。不能以“系统支持替代”为由承诺任何两条矛盾候选都不会同时激活。解析结构中的 `conflictsWith` 也不等于已实现语义冲突阻断。
5. 未来入库前需读取该仓库已有 ACTIVE／CANDIDATE，逐条判断重复、更新、替代或局部例外。对数据库规则等明确替代项使用替代操作；不要分别批准相反要求。
6. 本次本地只读查询没有找到目标仓库登记，未新增仓库、修改 enabled 或创建任何 Memory。未来接入还需要确认实际部署与 App 授权范围。

### 建议的后续选择

| 方案 | 效果与代价 |
| --- | --- |
| 先审核本文，再补齐来源明确的已合并 PR 讨论，沿现有提取／确认流程接入（推荐先评估） | 复用现有安全边界；未必每条都有足够人类讨论，代码不能保证能提取全部 50 条。历史 PR 的重新提取入口和可靠合并快照还需单独核对。 |
| 增加历史规范／提交证据导入能力 | 可完整保留文档、提交及维护者确认来源；需要扩展来源类型、校验、候选创建、审计和测试，是独立业务改动，应先明确方案。 |
| 仅保留为人工评审参考 | 无业务改动；自动 Review 不会引用这些规则。 |

无论采用哪种方案，都先导入候选，保留证据性质和不确定项，再由维护者确认。不要把这份规则集合直接塞进服务系统 Prompt，也不要绕过当前模型为其编造 Memory ID／version。

## 维护约定

后续更新以新的已确认 dev SHA 为基准，只复查相关规范和调用路径。发现明确替代决定时记录旧编号与新版本，不能让两份相反正文并列作为当前要求；只新增局部例外时保留原规则并标明精确范围。每条保留至少一个应提示例和不应提示例，用作以后评审样本，不能拿“全文无重复句子”代替语义冲突核对。

本轮实际命令、验证结果与未验证项记在 [UX 任务清单](../tasks/UX.md)。本文只维护来源和接入边界，不把历史提交中的测试结论记作本轮测试通过。

[s-agents]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/AGENTS.md#L49
[s-db-rules]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/01-database-operations.md#L1
[s-ci]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.github/workflows/model-call-ci.yml#L110
[s-idempotency]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/request_billing_idempotency.go#L33
[s-migration-rules]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/02-database-migration.md#L1
[s-main-entry]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/main.go#L856
[s-main-db]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/main.go#L871
[s-protected]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/protected_table_migration.go#L23
[s-request-log]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/request_billing_log.go#L17
[s-log-delivery]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/request_billing_log_delivery.go#L33
[s-billing-rules]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/11-billing-payment.md#L1
[s-error-rules]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/08-error-handling.md#L1
[s-transaction]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/transaction.go#L77
[s-lease]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/alert_migration.go#L171
[s-video]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/edge_video.go#L158
[s-expr]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/pkg/billingexpr/expr.md#L72
[s-task-billing]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/task_billing.go#L230
[s-h3-test]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/task/hailuo/missing_usage_settlement_test.go#L16
[s-security-rules]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/12-permission-security.md#L1
[s-auth]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/token_auth.go#L22
[s-auth-middleware]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/middleware/auth.go#L880
[s-json]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/common/json.go#L330
[s-credential]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/credential_outbound.go#L16
[s-api-request]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/api_request.go#L1184
[s-registry]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/user_data_registry.go#L67
[s-mcp-security]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/mcp_security.go#L44
[s-restore]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/user_deletion_restore.go#L219
[s-relay-rules]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/06-relay-channel.md#L1
[s-zero-test]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/dto/openai_request_zero_value_test.go#L11
[s-seedream]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/seedream_flash.go#L145
[s-price]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/helper/price.go#L1715
[s-edge-review]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/edge_review.go#L128
[s-i18n]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/i18n/i18n.js#L43
[s-payment-checklist]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/2026-08-10-%E7%BB%9F%E4%B8%80%E6%94%AF%E4%BB%98%E4%BF%AE%E6%94%B9%E9%98%B2%E5%9B%9E%E5%BD%92%E6%A3%80%E6%9F%A5%E6%B8%85%E5%8D%95.md#L1
[s-epay]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/payment/epay.go#L97
[s-unified-payment]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/payment_unified.go#L106
[s-edge-architecture]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/edge-architecture-v2.md#L147
[h-mysql]: https://github.com/tuziapi/tuzi-api/commit/6b7289da9657475fcd2a8d2f2d155903a56a0a4d
[h-migration]: https://github.com/tuziapi/tuzi-api/commit/f3c29b436a37e38964eeb75cb89b3ebead769ece
[h-log]: https://github.com/tuziapi/tuzi-api/commit/d2e98f85a57cb8ecceee2978ed1c2530509a7e9c
[h-unknown]: https://github.com/tuziapi/tuzi-api/commit/c5e66246fe89e7dd8c3a06cb014ccf9b4902c564
[h-lease]: https://github.com/tuziapi/tuzi-api/commit/f48aec3b8253bf7ba98fd8dd600cf58d938cc530
[h-video-sync]: https://github.com/tuziapi/tuzi-api/commit/28332df7f93d5394f4c82cf58bd2bcc4cfcfe7ae
[h-h3]: https://github.com/tuziapi/tuzi-api/commit/b14109575d513bead63bee7432d375a409f254b2
[h-auth]: https://github.com/tuziapi/tuzi-api/commit/677141481cac62eb704a9f1df33057b56871ae29
[h-secrets]: https://github.com/tuziapi/tuzi-api/commit/4dda19cd80d70498907277a055c6fa93fae5dba6
[h-mcp]: https://github.com/tuziapi/tuzi-api/commit/8d91796ac74856013e74bacc394d8ac08af71d66
[h-zero]: https://github.com/tuziapi/tuzi-api/commit/2cf3c1836c084268249bd0fa8a9c01312948b36a
[h-resource]: https://github.com/tuziapi/tuzi-api/commit/7bfea48fdf1a40ea5789e57e19a329c40d3b09ef
[h-i18n]: https://github.com/tuziapi/tuzi-api/commit/54b76ea7e5647724018a0d063c0c23878f461e5a
[h-payment]: https://github.com/tuziapi/tuzi-api/commit/dd9ca513ee6d91c231412016c2d52e1dec2545a0
[h-attribution]: https://github.com/tuziapi/tuzi-api/commit/238e190bb8002d42709084ab55645a9024e26682
[s-v2-16-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/2026-10-27-Seedance-%E6%B8%A0%E9%81%93%E7%8B%AC%E7%AB%8B%E9%80%82%E9%85%8D%E5%99%A8%E4%B8%8E%E4%BA%B2%E5%92%8C%E6%80%A7%E4%BF%AE%E5%A4%8D.md#L5
[s-v2-16-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/seedance_asset_access.go#L61
[h-v2-5e1c45d81]: https://github.com/tuziapi/tuzi-api/commit/5e1c45d818134d722487d4cb3aac44eae6a2ec8e
[h-v2-cf4b67f2b]: https://github.com/tuziapi/tuzi-api/commit/cf4b67f2b4c2e243dae2a845391ddd89a6243092
[s-v2-17-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/channel_select.go#L345
[s-v2-17-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/model_route_filter.go#L1
[h-v2-5925e4a34]: https://github.com/tuziapi/tuzi-api/commit/5925e4a34b874a4798dd923f70d2f7ce76d31754
[s-v2-18-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/openai/relay_responses.go#L743
[s-v2-18-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/openai/relay_responses.go#L1077
[h-v2-a1b380873]: https://github.com/tuziapi/tuzi-api/commit/a1b38087385c79622eb4d223e0a7d71140f90413
[s-v2-19-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/superpowers/specs/2026-10-16-claude-http-200-stream-completion-design.md#L3
[s-v2-19-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/helper/http200_stream_recovery.go#L9
[s-v2-19-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/openai/relay-openai.go#L534
[h-v2-23216ba52]: https://github.com/tuziapi/tuzi-api/commit/23216ba520cbc2b6c966eac86647920e51e7eadc
[h-v2-c0938890b]: https://github.com/tuziapi/tuzi-api/commit/c0938890bb3237d9e182f240812f00755aafae9e
[s-v2-20-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/task/doubao/adaptor.go#L73
[s-v2-20-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/task/doubao/adaptor.go#L385
[h-v2-2486a60c4]: https://github.com/tuziapi/tuzi-api/commit/2486a60c4e6c8880e5f70a152b5c6be983476401
[s-v2-21-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/06-relay-channel.md#L20
[s-v2-21-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/relay_adaptor.go#L154
[s-v2-21-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/task_polling.go#L1703
[s-v2-21-4]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/relay_task.go#L1428
[s-v2-22-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/common/upstream_attempt_outcome.go#L1
[s-v2-23-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/2026-09-24-user-model-discount-replaces-tier.md#L1
[s-v2-23-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/helper/price.go#L197
[s-v2-23-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/task_billing.go#L5735
[h-v2-36a86cd8d]: https://github.com/tuziapi/tuzi-api/commit/36a86cd8dc30c0e698fda8b6a32b8c48dc5a64f8
[h-v2-901e682b8]: https://github.com/tuziapi/tuzi-api/commit/901e682b869f61d4a98c02513c1d86e6a2db0de4
[s-v2-24-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/11-billing-payment.md#L1
[s-v2-24-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/quota_currency.go#L19
[s-v2-24-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/user.go#L1419
[h-v2-7686d40aa]: https://github.com/tuziapi/tuzi-api/commit/7686d40aab3a50f5d98b2ceaf16176eea125bbc1
[s-v2-25-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/user.go#L1609
[s-v2-25-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/request_billing_idempotency.go#L33
[s-v2-26-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/task_billing.go#L2064
[h-v2-8b552c2b8]: https://github.com/tuziapi/tuzi-api/commit/8b552c2b89d75ada5f99e9684bfa8399d43aaffd
[s-v2-27-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/2026-08-29-%E8%AE%A1%E8%B4%B9%E4%BC%98%E5%85%88%E5%90%8E%E5%8F%B0%E4%BB%BB%E5%8A%A1%E4%B8%8E%E4%BB%B7%E6%A0%BC%E9%AB%98%E5%8F%AF%E7%94%A8%E6%B2%BB%E7%90%86.md#L1
[s-v2-27-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/model_pricing_sync_rows.go#L281
[s-v2-27-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/model_pricing_authority.go#L379
[h-v2-37cc7b4c6]: https://github.com/tuziapi/tuzi-api/commit/37cc7b4c6e2e2a2ef0f916e7b9a32ad05489f14e
[s-v2-28-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/model_pricing_authority.go#L594
[s-v2-28-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/option.go#L1038
[s-v2-29-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/pkg/billingexpr/expr.md#L118
[s-v2-29-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/tiered_settle.go#L26
[s-v2-30-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/task_runtime_context.go#L262
[s-v2-30-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/task_runtime_context.go#L664
[s-v2-30-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/task_billing.go#L3486
[s-v2-31-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/user_settings.go#L54
[h-v2-202c12bc3]: https://github.com/tuziapi/tuzi-api/commit/202c12bc35490887659d41924d24bb332fedf2d8
[s-v2-32-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/main.go#L649
[h-v2-3febd0e95]: https://github.com/tuziapi/tuzi-api/commit/3febd0e959a7d61ede3ebaf59bba7f20f4fd8e42
[s-v2-33-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/01-database-operations.md#L1
[s-v2-33-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/main.go#L3644
[h-v2-fe8d06b87]: https://github.com/tuziapi/tuzi-api/commit/fe8d06b878421f94c97265563f0b5a8188abfab3
[s-v2-34-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/log.go#L280
[s-v2-34-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/log_export_page.go#L20
[s-v2-34-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/log_export_page.go#L93
[s-v2-34-4]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/log_export_page.go#L1
[h-v2-a43d15e5f]: https://github.com/tuziapi/tuzi-api/commit/a43d15e5f8d6cf9014ddd700e654fff806db7dbe
[s-v2-35-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/backend_error_ai_job.go#L1
[s-v2-35-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/backend_error_worker.go#L1
[h-v2-28bd0e7bf]: https://github.com/tuziapi/tuzi-api/commit/28bd0e7bfd1b4ed1775af3194d50f1b9e34d3f2d
[h-v2-f42463a11]: https://github.com/tuziapi/tuzi-api/commit/f42463a11f5df8c7f86ae4f7d3064ec8fb4c4236
[s-v2-36-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/2026-08-29-%E8%AE%A1%E8%B4%B9%E4%BC%98%E5%85%88%E5%90%8E%E5%8F%B0%E4%BB%BB%E5%8A%A1%E4%B8%8E%E4%BB%B7%E6%A0%BC%E9%AB%98%E5%8F%AF%E7%94%A8%E6%B2%BB%E7%90%86.md#L1
[s-v2-36-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/background_db_coordinator.go#L23
[s-v2-37-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/12-permission-security.md#L1
[s-v2-37-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/router/api-router.go#L282
[s-v2-37-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/router/api-router.go#L753
[h-v2-7ca40bd36]: https://github.com/tuziapi/tuzi-api/commit/7ca40bd366b2d8394da8e91e6078cb2375f22a8f
[h-v2-30781ad03]: https://github.com/tuziapi/tuzi-api/commit/30781ad0369fa9886173fa3b2cbe701942f5cc95
[s-v2-38-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/seedance_asset.go#L319
[s-v2-38-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/router/video-router_test.go#L163
[h-v2-5131d3e5e]: https://github.com/tuziapi/tuzi-api/commit/5131d3e5ebcd3fae7f3cf55754a762f6fa7ec695
[s-v2-39-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/service/http_client.go#L386
[h-v2-5ed53099c]: https://github.com/tuziapi/tuzi-api/commit/5ed53099c2fe266e14955526a66ab77dc339154f
[s-v2-40-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/.claude/rules/12-permission-security.md#L1
[s-v2-40-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/pkg/usagelogcsv/export.go#L473
[s-v2-40-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/pkg/tasklogcsv/export.go#L304
[s-v2-41-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/channel/task/hailuo/query_integrity.go#L27
[h-v2-111bcb0b5]: https://github.com/tuziapi/tuzi-api/commit/111bcb0b5f0e53da717fde2a836a37d5eae212a2
[s-v2-42-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/hooks/common/useAutoRefresh.js#L22
[h-v2-2b6f1f6dd]: https://github.com/tuziapi/tuzi-api/commit/2b6f1f6dd0d29cd92e8cbddb32f37a9cd763d0aa
[s-v2-43-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/hooks/site-message/useSiteMessages.js#L84
[s-v2-43-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/hooks/support-ticket/useSupportTicketUnread.js#L78
[h-v2-d825b347a]: https://github.com/tuziapi/tuzi-api/commit/d825b347a55d68d7f5a64f046d523df999e65d42
[s-v2-44-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/hooks/usage-logs/useUsageLogsData.jsx#L2143
[h-v2-6b90f46bc]: https://github.com/tuziapi/tuzi-api/commit/6b90f46bcd8d564bafb09afd8899a571de50dba8
[s-v2-45-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/hooks/usage-logs/useUsageLogsData.jsx#L654
[s-v2-45-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/helpers/usageLogExportBackground.js#L1
[s-v2-45-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/components/layout/UsageLogExportFloatingBar.jsx#L1
[h-v2-f5b8c0439]: https://github.com/tuziapi/tuzi-api/commit/f5b8c0439240f83a19fd410df29944055d5a82d3
[s-v2-46-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/hooks/usage-logs/useUsageLogsData.jsx#L2402
[s-v2-46-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/controller/log.go#L375
[s-v2-46-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/pkg/usagelogcsv/export.go#L1
[h-v2-cca70815c]: https://github.com/tuziapi/tuzi-api/commit/cca70815c8f2a1a90ffdaeb205e4d132279ce067
[s-v2-47-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/helpers/usageLogExportBackground.js#L209
[s-v2-47-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/components/layout/UsageLogExportFloatingBar.jsx#L345
[h-v2-67254f2db]: https://github.com/tuziapi/tuzi-api/commit/67254f2db3694eb61da01a210f50bb12835c2080
[s-v2-48-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/web/src/helpers/auth.jsx#L87
[h-v2-c77cf5167]: https://github.com/tuziapi/tuzi-api/commit/c77cf51673d642faf4c2ce2c9e9df78a7d08409d
[s-v2-49-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/relay/local_async_image.go#L1383
[h-v2-751336826]: https://github.com/tuziapi/tuzi-api/commit/751336826ae71b280d05b43e791d3f7ffe358519
[s-v2-50-1]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/docs/2026-10-27-Seedance-%E6%B8%A0%E9%81%93%E7%8B%AC%E7%AB%8B%E9%80%82%E9%85%8D%E5%99%A8%E4%B8%8E%E4%BA%B2%E5%92%8C%E6%80%A7%E4%BF%AE%E5%A4%8D.md#L5
[s-v2-50-2]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/group_model_adapter_storage.go#L12
[s-v2-50-3]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/group_model_adapter_storage_test.go#L50
[s-v2-50-4]: https://github.com/tuziapi/tuzi-api/blob/d2d412bec96698e0f7450b1bd5684f88231887c5/model/seedance_asset_schema.go#L1
[h-v2-51227e323]: https://github.com/tuziapi/tuzi-api/commit/51227e323fe973030e890c7b159b86d3a5d54387

[h-v2-2af50075c]: https://github.com/tuziapi/tuzi-api/commit/2af50075c741d44f364560dc6a4ab433666ae0d9
