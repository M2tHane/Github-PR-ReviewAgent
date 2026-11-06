# 企业微信群开发任务

状态：开发引用回复与审查直发群已本地升级；真实图文开发及完成引用待验收｜2026-11-06

基线：`c4276b2` 加既有 30 个文件的暂存修改；保留通知、主题、规则研究等前序工作。

用户已确认：每群绑定一个仓库和目标分支；服务从目标分支创建开发分支和 PR；管理页设置角色；管理员可修改受保护文件，开发命中后整项拒绝，原保护规则继续有效。

- [x] 群绑定、管理员／开发及文件保护设置、维护权限和审计。
- [x] 智能机器人接收 @ 图文、可信身份、消息去重。
- [x] 固定目标分支快照、规则读取、图片理解、代码修改及权限检查。
- [x] GitHub App 创建分支、提交、PR，自动生成 PR 跳过审查。
- [x] 原群引用任务消息回复 PR，拒绝／失败明确告知；审查结果直接发绑定群，不 @成员。
- [x] 服务测试、独立数据库、管理页验证、文档及依赖检查。
- [ ] 授权测试群／仓库真实图文开发验收（连接、绑定及写权限已就绪；真实任务因模型误解发布职责而拒绝，已澄清开发提示词，待重发验证）。

## 实施边界

开发使用独立的任务表和 Worker，复用现有模型预算与受限读取工具。模型提出完整文件改动，服务统一验证后生成 Git 对象，不向模型开放宿主机 shell 或 GitHub 凭据。PR Review／Reply／Health 保持只读。目标仓库的安装、测试及 hooks 不在服务宿主机执行；PR 明确说明未运行测试，由仓库 CI 验证。

保护范围支持精确文件、目录及 `目录/**`、`**`（全部）；权限检查使用完整保护集，不受团队规则召回排序影响。设置变更会取消未发布任务；普通 ACTIVE 团队规则随任务保存快照。


## 2026-11-05：实现与本地验证

所有变更仍在 `feat/wecom-development-tasks` 工作区，HEAD 为 `c4276b2f8ad94a98ce843786e08a0d469517a36c`；未提交或推送，原有 30 个暂存文件保持前序工作。实现入口与运行说明见 [企业微信群内 AI 开发](../wecom-development.md)。

### 实际验证

| 命令／操作 | 结果与范围 |
| --- | --- |
| `npm test` | 首次运行有一项既有 Semgrep 缺失程序用例超时；单独 `node --test dist/test/health/sast.test.js` 3 项通过。随后完整重跑：158 项、113 通过、45 个数据库用例由独立命令执行、0 失败，18.70 秒。日志 `work/development-tests.log`、`work/development-tests-final.log`。 |
| `npm run test:db` | 46 项全部通过、0 skip、0 失败，10.41 秒；使用临时 schema，未操作真实任务。日志 `work/development-db-final.log`。 |
| 最终增量 `npm run build` 与 `node --env-file=.env --test dist/test/development/database-development.test.js` | 构建通过；10 项数据库验证全部通过，4.85 秒。覆盖最终索引、权限、规则快照与归属查询位置调整，日志 `work/development-db-final-incremental.log`。 |
| `node --test dist/test/development/policy.test.js dist/test/review/agent-session.test.js dist/test/github/webhook.test.js` | 最终增量 26 项通过，0.75 秒；真实 Pi Session 配合 Provider 替身验证图片进入模型消息，日志 `work/development-unit-final-incremental.log`。 |
| `npm run check:docs`、`git diff --check` | 25 篇 Markdown、237 个本地链接与锚点通过；差异格式通过。 |
| 新模块定向 `biome lint` | 0 error，29 个 warning（主要为非空断言与测试替身的 any）；未将其表述为零告警。日志 `work/development-lint-final.log`。 |
| `npm audit --audit-level=high --json` | 未通过：2 high、2 moderate，仍位于原 Pi SDK 的 brace-expansion／minimatch／undici 依赖链。新增官方企微 SDK 未出现在告警链中；未擅自升级既有依赖。日志 `work/development-audit.json`。 |
| 凭据值匹配检查 | 检查 56 个修改及新文件；唯一匹配是 `.env.example` 中原先已有的数据库示例值，确认暂存基线已包含它。本次未写入新凭据或私钥。 |

### 覆盖的行为

- 按仓库维护群、目标分支、管理员／开发、保护范围；群唯一绑定、设置版本防覆盖、维护权限／CSRF、变更审计和未知身份拒绝。
- 固定目标 SHA；已生效规则和版本进入模型及任务快照，候选不进入；图片解密、地址／体积限制及真实 Pi 图片参数；预算包含图像预留。
- 开发触及保护路径时无任何 GitHub 写操作；管理员同一任务成功且保护规则保持原样；执行中撤权／修改设置／目标分支前进时取消。
- 修改路径拒绝符号链接、越界、大小写和父子冲突；普通文本新建／修改／删除；未完整读取或含被打码凭据的文件不整文件覆盖。
- PR Webhook 先于创建响应到达仍跳过审查；记录过的 PR 后续新 head 也免审查；伪造分支无效；普通 PR 原有测试通过。
- 创建 PR 超时只核对不重发；无法核对保留 `uncertain`；服务中断与旧执行令牌失效；重复群消息只执行一次。
- 智能机器人替身经过群消息接收、持久任务、完成状态、原群 @ 提出者及 PR 链接整个发送链路。真实群消息和 GitHub 发布没有发生。

### 管理页与性能

ego-browser TaskSpace 1；独立 `development_preview_1793947530743` schema、替身登录及 GitHub 权限服务，使用真实管理 API 和前端。

实测新增群绑定、目标分支、管理员／开发、保护规则并保存；刷新保留；移除最后管理员后明确拒绝；恢复管理员后保存成功；删除中间成员不串改下一行；Escape 关闭且焦点返回入口。1440px 桌面与 390px 手机截图目视通过，手机 document 宽 390px、dialog 宽 389px，无水平溢出。最终截图 `work/development-desktop.png`、`work/development-mobile.png`。任务空间已关闭，预览进程停止并回收 schema。

使用相同 esbuild 参数对原暂存前端与当前构建测量：JS 从 320568 bytes 到 329304 bytes（+8736），gzip 从 94466 到 96496（+2030）；CSS 从 34634 到 35093（+459），gzip +105 bytes。测量脚本及输出为 `work/development-bundle-size.mjs`、`work/development-bundle-size.json`。服务空闲查询、活动权限复核、GitHub 请求数、图片内存上限见接入说明；未做线上延迟或压力测试。

### 尚未完成的真实验收

本地未配置 `WECOM_BOT_ID`、`WECOM_BOT_SECRET`。没有启动连接真实队列的主服务、执行日常数据库迁移 005、发送真实群消息、调用真实模型开发或创建真实 PR；真实 delivery／任务 ID／PR URL、模型耗时和 usage 不适用（测试使用替身）。

需要配置智能机器人长连接凭据，确认授权测试群、仓库、目标分支及 App 写权限后，在真实群分别运行开发普通任务、开发保护拒绝、管理员保护修改及文字加图片任务。还需由接收方确认 @ 提醒与消息样式；不能把 SDK／HTTP 替身成功当成这项验收通过。目标仓库构建和测试不在本服务宿主机执行，由 PR CI 验证。

## 2026-11-06：日常本地服务升级

用户授权本地升级及提交合并。已执行增量迁移 005、006 并启动 3000 端口的最新服务；没有导入真实规则、发送群消息或创建业务 PR。升级和性能探测证据见 [规则导入清单](RULE-IMPORT.md#2026-11-06本地升级与提交收口)。智能机器人凭据仍未配置，开发 Worker 未启动，真实群验收保持未完成。

## 2026-11-06：智能机器人真实连接

用户提供长连接凭据并授权尝试接入。基线 SHA：`f0bf906fdd64c19531bf0c6571ee83c0da036e34`。凭据仅写入 Git 忽略的本地 `.env`，文件权限设为 `0600`，没有写入本文或普通日志。

- 使用 `node --env-file=.env --input-type=module` 调用官方 `WSClient`，真实收到 `authenticated`，耗时 217 毫秒，随后断开验证连接；未发送消息。
- 重启本地服务后，`http://localhost:3000/` 返回 200；数据库确认一个开发 Worker 主锁，并观察到仅在认证成功后执行的开发任务轮询。
- 重启前确认群绑定为 0、开发任务为 0，原任务队列没有 queued/running 任务。未新增群绑定、成员身份或保护规则。
- GitHub App 安装的实际权限为 `contents: read`、`pull_requests: write`。创建分支和提交代码前仍需管理员将 Contents 更新为写权限并批准安装权限更新。

连接认证通过不代表图文任务验收通过。待用户将机器人加入授权测试群并 @Bot 获取群 ID，再配置目标分支和成员身份。尚未收到真实群图文、调用开发模型或创建 PR；delivery／任务 ID／PR URL、模型角色与 usage 不适用。性能只测到单次认证耗时，未进行群消息延迟或压力测试。

## 2026-11-06：真实群绑定与审查通知验证

用户明确确认测试群绑定 `M2tHane/pi-review-sandbox` 的 `main`，成员 `JiZhaoQi` 为管理员，并授权向此群发送审查通知进行验证。

- 使用 ego-browser TaskSpace 2，经真实 GitHub OAuth 登录为 `M2tHane`，通过管理页保存启用的群绑定和管理员身份；保持空的保护规则列表，未额外新增保护范围。通知成员映射更新为 `m2thane → JiZhaoQi`。管理页提示保存成功。
- 群内截图已证明用户的 @文字被接收，并收到未绑定提示；截图中的 `<@JiZhaoQi>` 是普通文字，不能作为客户端 @提醒成功证据。
- 在 GitHub 只读核对 PR #4 当前 head、作者与已发布 Review 后，手工为该历史真实审查补建一次通知记录，由正常 NotificationWorker 发送。任务 `f06d6b9e-e318-4a87-99dc-fd6e52aa38e4`，head `b423506c1f37cd0c434c173e7ca4272adcd32721`，结果 `sent`，attempt 1，无错误，发送时间 `2026-11-06T09:29:33.490Z`。链接：[PR #4 审查](https://github.com/M2tHane/pi-review-sandbox/pull/4#pullrequestreview-5782036262)。未重新运行模型或重新发布 Review，本次不是新 Webhook 触发的完整审查验收，模型 usage 不适用。客户端送达群及真正 @提醒仍待用户确认。
- 内置 imagegen 生成测试参考图，保存在忽略路径 `work/wecom-acceptance/focus-desk-reference.png`，1254 × 1254，1,316,265 bytes，满足现有图片限制。配套 `prompt.md` 要求模型从图片读取独有标识、卡片文字和数字，再创建三个静态页面文件与 PR；提示词没有预填图中识别答案。
- GitHub App 的 Contents 写权限仍未补齐。打开 App 权限页后遇到 GitHub 二次身份验证，已将浏览器交给用户，未绕过验证或修改权限。暂未进行真实图文开发调用、创建分支／PR 或开发完成通知。

本轮未改业务代码；文档验证使用 `npm run check:docs` 和 `git diff --check`。只变更既有设置及发送一条通知，没有新增常驻查询、内存或包体积开销；端到端图文任务耗时、usage 和手机 @效果仍待实测。

### 接收群更正

用户随后确认：旧 `WECOM_WEBHOOK_URL` 是另一个群的 Message Push 地址，与当前智能机器人绑定群不同。上面的 PR #4 通知经旧 Webhook 发送，因此只证明旧通知通道返回成功，**不是绑定群送达或 @提醒的成功证据**。本次错误假设导致测试通知发往非预期群；不能据此完成真实群验收。

确认没有 queued/running 审查任务、活动开发任务或 pending/sending 通知后，注释本地 `.env` 的旧 Webhook 配置并重启服务。配置校验为 `legacyWebhookEnabled=false`、`intelligentBotConfigured=true`，保留已保存的群绑定与成员身份。未继续发送消息。当前审查通知代码仍使用旧 Webhook，尚未接到智能机器人绑定群；改为按仓库绑定群发送与验证智能机器人 @能力属于下一步工作。

### 智能机器人群提醒直接探测

用户希望只使用智能机器人，并再次要求深入调查。沿用其已授权的新群通知验证，先确认无活动审查或开发任务，再暂时停止服务，用同一机器人建立单个探测连接；探测断开后恢复正常服务，避免第二连接踢掉现有连接。没有使用旧 Webhook、修改绑定或业务代码、创建任务或 PR。

目标群严格取已确认绑定记录，`chat_type=2`，提醒目标使用用户明确确认的 `jizhaoqi`。测试间隔 3.2 秒，消息标明验证编号，不包含业务审查结果：

| 探测 | 实际回执 | 限制 |
| --- | --- | --- |
| A：主动 Markdown，正文含 `<@jizhaoqi>` | `errcode=0`，309 ms | 仅证明服务端接受；客户端是否解析为成员提醒待用户确认。 |
| B：主动 text，`text.mentioned_list=["jizhaoqi"]` | `errcode=40008`，96 ms | 服务端拒绝该消息类型；第三方文章中的此种示例在当前机器人不可用。 |
| C：主动 Markdown，body 与 markdown 内附 `mentioned_list`，正文不含 @标签 | `errcode=0`，347 ms | 字段可能被忽略；不能据回执认定 @成功。 |

脚本和原始回执在忽略路径 `work/wecom-research/probe-mentions.mjs`、`mention-probe-result.json`。正常服务恢复后 HTTP 返回 200。此次为消息协议探测，无模型角色、usage、delivery／开发任务 ID 或 PR。客户端证据仍待用户提供，不能将该探测计为群内 @提醒验收通过。

用户随后提供客户端截图，确认 A、C 消息出现在目标新群：A 的 `<@jizhaoqi>` 显示为普通文本，C 没有显示成员提及。截图证明主动消息送达正确群，但没有可见的真实 @效果；未另行观察系统推送或聊天列表的提醒状态，因此不声称已验证所有客户端提醒行为。结合 B 的 40008，三种候选方式均未完成群内 @验收。截图来源为用户本轮附件 `image-1793958707145.png`。正常服务恢复后进一步观察到认证后的任务轮询；旧 Webhook 仍关闭。

## 2026-11-06：引用开发结果与审查直发群

用户接受引用原消息对应需求，不再要求 @强提醒；明确要求 PR 审查完成后直接发绑定群，只保留智能机器人。验证对象为基线 `f0bf906fdd64c19531bf0c6571ee83c0da036e34` 上的本轮工作区实现。

### 实现与自动验证

- 开发接收时保存原回调 req_id 和 24 小时回复期限；接收确认与完成结果分别使用独立 stream ID，引用同一原需求。不再拼接 `<@userid>`。重启后仍使用持久化标识；超期、缺少上下文或群绑定变化时停止回复并在管理页明确显示原因。未知发送结果保持 uncertain。
- 审查发布时记录机器人通道、绑定群和版本；正常 NotificationWorker 复用智能机器人连接直接发群。认证前不领取，限速等待后再次确认绑定；不要求作者映射，也不使用旧 Webhook。开发运行不阻塞审查通知。隐藏不再使用的通知成员入口，保留历史映射数据。
- 增量迁移 007：增加开发回复上下文及通知错误字段、审查通知群快照。旧待发 Webhook 记录取消；旧中断发送保持 uncertain，不投向新群。

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm run build` 后定向运行开发／通知单元与数据库测试 | 首轮 33 项全通过，0 skip，5.64 秒；日志 `work/wecom-quoted-targeted.log`。随后增加共享连接／开发运行中审查投递及限速后改绑用例。 |
| `npm test` | 173 项，121 通过，52 个数据库用例由独立命令验证，0 失败，14.81 秒；包含构建，日志 `work/wecom-quoted-tests.log`。 |
| `npm run test:db` | 53 项全部通过，0 skip，0 失败，16.25 秒；包含构建并使用独立临时 schema，日志 `work/wecom-quoted-db.log`。 |
| `npm run check:docs`、`git diff --check` | 通过；文档链接及差异格式有效。 |
| 修改的 12 个业务／前端模块定向 `biome lint` | 0 error，6 warning、1 info；日志 `work/wecom-quoted-lint.log`。 |
| `npm audit --audit-level=high --json` | 0 漏洞；历史 2 high、2 moderate 的升级证据保留在 [SDK 升级清单](SDK-UPGRADE.md)。 |

### 本地升级与真实通知

确认无活动审查／开发任务后，停止旧服务，执行 `node --env-file-if-exists=.env dist/src/migrate.js` 的等价显式 `.env` 命令应用 007，再重启本地 3000 服务。确认迁移记录存在、HTTP 200、一个开发主锁，保留原群绑定与身份设置。未修改 GitHub App 权限。

只读核对 PR #2 的作者、当前 head 与真实历史 Review 后，为尚未通知过的历史任务手工补建一条新通道通知，由正常服务处理：

- Job：`902bc74c-9367-48be-ad05-fec8a113e6d6`；head：`c9c5f1dfedb17ed66ece66ec98669fd3b05e2099`。
- [实际审查链接](https://github.com/M2tHane/pi-review-sandbox/pull/2#pullrequestreview-5780737477)。绑定版本 1，使用当前确认的新群与智能机器人，不使用旧 Webhook。
- 入队时间 `2026-11-06T10:12:23.458Z`；`sent` 时间 `2026-11-06T10:12:26.334Z`，attempt 1，无错误；约 2.9 秒，包含轮询等待和 GitHub 核对，不是压力测试指标。证据 `work/wecom-acceptance/bound-review-evidence.json`。
- 没有重新运行模型、发布 Review 或创建 PR；本次模型角色、耗时和 usage 不适用，不冒充新 Webhook 驱动的完整审查验收。
- 用户随后明确回复“我已收到”，并提供客户端截图 `image-1793960473071.png`：当前智能机器人在正确群中显示“AI 审查已完成”、仓库 `M2tHane/pi-review-sandbox`、PR #2 标题及“查看审查结果”链接，没有成员 @。绑定群送达及客户端排版验收通过；截图不证明链接已点击，也不替代真实图文开发与最终引用回复验收。实现提交 `03dcb94`，合并后的服务基线 `e96fa1d`。

### 性能与未验证项

同参数 esbuild 对比基线与本轮：JS 343627 → 337140 bytes，gzip 100232 → 98825 bytes（减少 1407 bytes）；CSS 未修改。首次基线包测量因本机 Python 不支持 tarfile filter 参数及未包含共享源码而失败，补齐只读基线文件后成功；最终测量见 `work/wecom-quoted-bundle.json`。

复用现有 WebSocket；空闲主实例每 4 秒约增加一次审查通知待发查询，实际发送通过原有 3.1 秒串行队列。未测生产负载、峰值内存或端到端模型延迟。此轮未重新进行浏览器交互验收：先前的 GitHub App 权限页仍停在交给用户的二次验证步骤，未绕过控制权。

真实开发完成后的原生引用仍需新群消息验证；历史消息未保存 req_id，不能伪造其回调。GitHub App 实际权限仍为 `contents: read`、`pull_requests: write`，因此完整图文开发、真实创建分支／PR 仍待用户完成写权限更新后测试。此前发现的明文 UserID 大小写比较问题未在本轮改动，当前绑定仍保留与已观察回调一致的 `JiZhaoQi`。

### 客户端确认后的继续检查

2026-11-06，用户要求继续验收。通过 App 身份只读查询安装 `160592861`，实际权限仍为 `contents: read`、`pull_requests: write`；本地 `http://127.0.0.1:3000/` 返回 200。原 GitHub 二次验证 TaskSpace 2 已不在浏览器任务空间列表，未另建空间绕过验证，也未变更 App 权限。需用户完成 GitHub 身份验证、将 Contents 调整为 Read and write 并批准安装权限更新，再发送已准备的同条图文消息。此次只更新验收记录，没有调用开发模型或新建分支／业务 PR，无新增运行时性能开销。

## 2026-11-06：图文验收的图片下载域名修复

用户完成 App 设置与安装权限确认后，通过 App API 核实安装 `160592861` 的权限为 `contents: write`、`pull_requests: write`。本地 HTTP 200，群绑定仍启用，目标分支 main、绑定版本 1。

用户发送同条图文消息后，客户端截图 `image-1793962674727.png` 显示机器人引用原需求并回复“图片不是受支持的企微下载地址”。代码路径为：解析图文和检查群成员权限 → 下载图片前检查 URL → 拒绝并引用回复；此时尚未保存开发任务。数据库实际查询开发任务表为空，没有此次开发模型调用、usage、分支或 PR。

已有图片白名单缺少[企微官方接收消息文档](https://work.weixin.qq.com/api/doc/90000/90136/100719)中明确展示的专用域名 `ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com`（此前获取的文档快照为忽略路径 `work/wecom-research/100719.txt`）。补充该精确主机，不放行其他 COS 存储桶。真实拒绝消息的 URL 未持久化，因此不能宣称已确认其具体主机或真实下载成功。

- 修改 `src/development/images.ts`，保留 HTTPS、无用户名密码、443 端口、禁止重定向、15 秒超时、大小／解密／图片尺寸校验。
- 更新图片下载回归，验证官方域名与查询签名传递、解密结果，以及伪装后缀、额外子域、其他租户、HTTP、凭据 URL 和异常端口在请求前被拒绝。
- `npm test`：173 项，121 通过、52 个数据库用例跳过、0 失败，11.77 秒；`npm run test:db`：53 项全部通过、0 skip、0 失败，16.02 秒。日志 `work/wecom-image-host-tests.log`、`work/wecom-image-host-db.log`。
- `npm audit --audit-level=high`：0 漏洞。文档和差异另经 `npm run check:docs`、`git diff --check` 验证。
- 确认审查／开发任务及通知无待处理项后，正常停止旧服务并启动新构建。HTTP 200，一个开发主锁，并观察到仅在机器人认证成功后才执行的开发任务轮询。

实现基线 `2510bb5`。此次仅增加一次主机字符串比较，不增加查询、网络请求或前端包体积；未做生产负载或内存测量。待用户重新发送原图文后，继续验证真实图片下载、模型识图、分支／PR 和开发完成原生引用；不将自动测试替代端到端验收。

## 2026-11-06：开发提案与服务发布职责澄清

用户再次发送需求后，接收确认截图 `image-1793964228334.png` 显示原生引用；随后截图 `image-1793969701748.png` 显示开发任务已拒绝。真实任务 `2ca96270-a7cb-49c4-971f-c4515935c147`，创建时间 `2026-11-06T11:23:09.344Z`，仓库 `M2tHane/pi-review-sandbox`，base SHA `3f1ffcc908023c0f06c744538f21bab2baf29a39`。状态 refused，通知 sent，无 notification_error；head SHA 和 PR 号均为空。

开发角色使用 `tuzi/gpt-6.1-sol`，耗时 169328 ms；usage：input 4189、output 7581、cacheRead 6912、cacheWrite 0、totalTokens 18682、unreportedTokens 0。模型拒绝理由明确称只读工具无法创建分支、提交、PR 或群回复。服务在解析非空 refusal 后停止，未进入 GitHub 发布流程；模型声称已提供三个完整文件，但原提案没有持久化，不能当作文件内容或识图正确性的证据。图片在任务结束时按既有策略清除，当前记录无法证明该请求实际带有几张图片。

实现基线 `62aa46e`。开发提示词补充明确分工：模型读取仓库并输出完整 changes、title、summary；服务校验权限及文件后负责提交、分支、PR 和群回复，缺少模型写工具本身不构成拒绝理由。保留真实权限拒绝、缺失信息拒绝和未运行测试的说明，不放宽解析和发布校验。同时落实用户文案要求，将接收确认缩短为“已收到开发任务。”，保持引用机制。

- `npm test`：173 项，121 通过、52 个数据库用例跳过、0 失败，11.02 秒；日志 `work/wecom-development-handoff-tests.log`。
- `npm run test:db`：53 项全部通过、0 skip、0 失败，15.35 秒；日志 `work/wecom-development-handoff-db.log`。已有测试验证合法提案由服务依次提交、开分支、提 PR，以及开发触及保护时不写 GitHub；这些替身测试不能证明真实模型一定遵循新提示词。
- 无活动任务或待发通知后正常重启本地服务，HTTP 200，一个机器人主锁，认证后的任务轮询已观察到。`npm run check:docs` 和 `git diff --check` 验证文档与差异。
- 不自动重试已拒绝任务、不伪造群回调；待用户重发图文后验收真实识图与 PR 创建。最终截图未显示原需求引用，不能将 notification_status=sent 视作最终原生引用已经验收通过。

性能影响仅为每次开发模型请求增加两段职责说明，输入 token 随请求次数略增，无新增查询、工具、网络调用或前端包体积；未测修改后的真实模型耗时或生产负载。
