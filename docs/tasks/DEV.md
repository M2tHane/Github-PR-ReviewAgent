# 企业微信群开发任务

状态：真实图文开发已创建测试 PR；开发完成引用的客户端效果待验收｜2026-11-06

基线：`c4276b2` 加既有 30 个文件的暂存修改；保留通知、主题、规则研究等前序工作。

用户已确认：每群绑定一个仓库和目标分支；服务从目标分支创建开发分支和 PR；管理页设置角色；管理员可修改受保护文件，开发命中后整项拒绝，原保护规则继续有效。

- [x] 群绑定、管理员／开发及文件保护设置、维护权限和审计。
- [x] 智能机器人接收 @ 图文、可信身份、消息去重。
- [x] 固定目标分支快照、规则读取、图片理解、代码修改及权限检查。
- [x] GitHub App 创建分支、提交、PR，自动生成 PR 跳过审查。
- [x] 原群引用任务消息回复 PR，拒绝／失败明确告知；审查结果直接发绑定群，不 @成员。
- [x] 服务测试、独立数据库、管理页验证、文档及依赖检查。
- [ ] 授权测试群／仓库真实图文开发验收（测试 PR #6 已创建；完成回复的客户端引用、页面交互及保护角色真实用例仍待验收）。

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

## 2026-11-06：真实 PR 创建与描述可读性

用户提供真实 [测试 PR #6](https://github.com/M2tHane/pi-review-sandbox/pull/6) 截图，并要求描述按“主要改动 → 配套调整 → 数据库变更／迁移及相关影响 → 验证情况”组织。

只读核对数据库及 GitHub：任务 `f9614090-2e51-46c4-8362-d294581af49a` 为 succeeded，notification_status 为 sent；创建于 `2026-11-06T13:21:48.543Z`，耗时 188777 ms。模型为 `tuzi/gpt-6.1-sol`，usage：input 4419、output 7789、cacheRead 7168、cacheWrite 0、totalTokens 19376、unreportedTokens 0。分支 `bot/development/f9614090-2e51-46c4-8362-d294581af49a`，base SHA `3f1ffcc908023c0f06c744538f21bab2baf29a39`，head SHA `2d9578a38001ed0c1b09dc8bd11d5bdb5d76beeb`，PR 目标 main，发布者为 GitHub App。

实际仅新增 `demos/focus-desk/` 下的 index.html、README.md、image-observations.md；识图记录含 VISION-742、Plan/03、Focus/25、Rest/05 及按钮原文，与参考图一致。未在宿主机执行目标代码或浏览器交互，不能据此认定倒计时与页面视觉验收通过；最终群引用仍需客户端确认，sent 仅表示发送回执成功。

实现基线 `fe042e8`：只调整开发提示词和 PR 正文固定结尾，沿用现有 summary 字段与发布接口。要求简短段落、配套改动列表和基于真实改动的迁移说明；有迁移时说明文件及操作，无法确定时明确待确认，不套用“无需迁移”。删除识图流水账与服务交接话术要求，固定结尾只保留未运行构建、测试和浏览器验收的说明。

经用户授权，用 App installation token 更新测试 PR #6 正文。更新前核对 head、作者及旧正文未变化，更新后确认 API 返回正文与预期一致；没有修改代码、head、目标分支或合并 PR。证据为忽略路径 `work/wecom-acceptance/pr6-description-update.json`，原正文和文件列表保存在同目录 `pr6.json`、`pr6-files.json`。

本次无数据库结构或配置变化，无需迁移；无新增模型调用、查询或前端包体积。后续开发请求的提示词增加格式要求，尚未测量实际 token 和延迟差异。新格式的真实模型生成效果待下一条开发任务验证，不将手工整理既有 PR 描述当作自动生成验收。

实际验证：`npm test` 173 项，121 通过、52 个数据库用例跳过、0 失败，12.92 秒；`npm run test:db` 53 项全部通过、0 skip、0 失败，15.68 秒。日志 `work/wecom-pr-description-tests.log`、`work/wecom-pr-description-db.log`。`npm run check:docs`（28 篇文档、248 个链接）与 `git diff --check` 通过。确认无活动任务及待发通知后重启新构建，HTTP 200，一个机器人主锁，认证后的开发轮询正常。

## 2026-11-07：Docker 打包与测试服务器部署准备

用户授权为项目提供镜像打包脚本，将服务与数据库容器部署到 `192.168.50.207`，允许安装 Docker 及传输 `.env`。基线 `3d1f5370a95f1f9c005924e9a8ded8c220bf4755`；当前完成的是本地镜像与隔离容器验证，目标服务器尚未部署成功。

新增 Dockerfile、多阶段构建、构建上下文白名单、[打包脚本](../../scripts/build-image.sh) 和独立的 [部署 Compose](../../compose.deploy.yaml)。保留原开发 Compose；服务和数据库分容器，数据库不发布端口并使用持久卷，迁移容器成功后才启动应用。沿用现有 Semgrep 1.136.0，镜像包含 Git、扫描规则和管理页。`.env` 与私钥仅在运行时只读挂载，不进入镜像。操作步骤见 [Docker 测试部署](../docker-deployment.md)。

| 实际操作 | 结果与限制 |
| --- | --- |
| `ssh -o ConnectTimeout=8 root@192.168.50.207`，随后 TCP 22 检查 | 均超时，尚未到认证步骤。路由走本机 en0、网关 192.168.1.1；SSH 用户名和端口仍需确认。没有提交服务器密码或传输真实凭据。 |
| `bash -n scripts/build-image.sh`、`scripts/build-image.sh --help` | 通过。 |
| `scripts/build-image.sh pr-review-agent:test-deploy work/docker/pr-review-agent-test-deploy.tar.gz` | 成功构建、加载并导出 Linux amd64 镜像；包含 `npm ci`、服务和前端构建。压缩包约 214 MiB，`gzip -t` 通过。日志 `work/docker-build.log`。 |
| 独立 Compose 配置校验和 `up -d --wait` | 使用 `work/docker-smoke/` 中的假凭据、临时私钥及独立 PostgreSQL 卷，迁移 7 项成功，应用和数据库健康，jobs 和 development_tasks 均为 0。无真实机器人连接和外部业务发布。 |
| 再次运行迁移容器 | 成功退出，无重复迁移错误。 |
| HTTP 探针与管理页 | `/healthz`、`/readyz`、`/`、JS 和 CSS 均 200；单次耗时 3–19 ms，JS 337140 bytes、CSS 35490 bytes。结果 `work/docker-smoke/http.json`。 |
| 容器工具与文件检查 | 非 root（UID 1000）；Node 24.22.2、Git 2.39.5、Semgrep 1.136.0。无 `/app/.env`、work、Git 历史或测试目录。使用合成 JS 文件调用服务 Semgrep 扫描，complete、无 missingData，未执行目标仓库代码。 |
| `docker stats --no-stream` | 空闲应用 158.8 MiB、CPU 0.52%；数据库 43.44 MiB、CPU 0.37%。本机 ARM Docker 执行 amd64 应用，单次采样不是目标服务器容量或性能承诺。 |
| 清理隔离测试 | 停止并删除 `prreview-deploy-smoke` 的临时容器与专用卷；保留镜像包及日志，未停止真实本地应用或修改业务库。 |

新增运行开销：应用 readiness 每 30 秒约一次数据库 SELECT 1，数据库每 5 秒一次 pg_isready，单服务日志约 30 MB 轮转上限。无应用依赖或业务逻辑修改；未重跑业务单元和数据库套件，已在镜像内完成构建、真实空库迁移及容器启动验证。未运行真实 GitHub／模型／企微任务，因此本轮模型角色、usage 与业务 PR URL 不适用。

待继续：恢复到服务器的 SSH 访问并确认登录用户／端口；确认迁移当前业务库还是新空库；确认 OAuth 和 GitHub Webhook 对外入口。迁移既有机器人时需停止旧连接，不能把新空库上的实例与本机机器人同时启动。不能将镜像构建成功表述为服务器部署完成。

新增的拒绝路径：无业务请求校验或报错规则；构建／迁移失败沿用工具退出状态，Compose 等迁移成功再启动应用。部署凭据未进入 Git，服务器登录密码未写入项目文件。

## 2026-11-07：GitHub Actions 镜像发布

用户确认先实现 main 自动构建并发布 GHCR，测试机暂时手工更新。将已验证的 Docker 打包文件一并提交，新增 [Docker image 工作流](../../.github/workflows/docker-image.yml)：PR 构建仅有 contents:read，不发布；main push 的独立任务使用 packages:write 和内置 GITHUB_TOKEN 发布 Linux amd64 镜像。镜像为 `ghcr.io/m2thane/github-pr-reviewagent`，带 latest、sha-完整提交号和发布摘要 digest。业务凭据不进入 Actions 或镜像，未设置个人 PAT，也不改变 GHCR 包可见性。

本地 actionlint 1.7.12、文档链接（29 篇、259 个链接）、差异格式和打包脚本语法检查通过；8 个提交文件未匹配到当前配置敏感值。Dockerfile 沿用上一节实际构建与隔离数据库验证的版本；本轮没有修改业务代码、依赖、数据库结构或请求校验。

[PR #8](https://github.com/M2tHane/Github-PR-ReviewAgent/pull/8) 的首次真实 [Actions 构建](https://github.com/M2tHane/Github-PR-ReviewAgent/actions/runs/42365760703) 已通过，源提交 `5cf1066cf726023bec1df075c5eb64e720d68eb9`；2026-11-07T10:52:14Z 开始，10:53:46Z 完成，约 92 秒（含排队与清理）。PR 发布任务按预期 skipped，没有登录或推送 GHCR。main 的发布记录及镜像 digest 由后续 [Docker image 运行摘要](https://github.com/M2tHane/Github-PR-ReviewAgent/actions/workflows/docker-image.yml) 保存；不能用 PR 构建成功代替 main 发布成功。

新增的拒绝路径：无。运行时性能没有新增开销；CI 消耗一次镜像构建及推送，通过 GitHub Actions 缓存复用层，具体耗时以真实运行记录为准。原测试机网络和数据迁移的阻塞仍保留，镜像发布不代表已部署到测试机。

## 2026-11-09：开发任务按路径附加团队规则

用户确认：开发任务不再一次性给出全部规则。没有路径、语言或模块范围的全局规则在开头给全文；限定范围的规则开头只给目录，`read_file` 读到匹配文件时附全文；新建文件命中尚未给出的规则时，提交后在同一会话补发一次，补发后仍有遗漏则不发布。不按描述做语义召回。行为说明见 [企业微信群内 AI 开发](../wecom-development.md#规则和代码修改)。

基线 `75b04f1`，分支 `feat/development-path-rules`，未提交或推送。改动：新增规则分配模块 `src/development/rules.ts`；开发处理器改提示词、附加规则、提交后补查；`runAgentSession` 增加可选的提交后复核轮（Review、Reply、健康检查不传，行为不变）；记忆模块的范围匹配函数放宽为只需 `scope` 字段。数据库结构、管理页和保护规则不变。

| 命令／操作 | 结果与范围 |
| --- | --- |
| `npm test` | 180 项：127 通过、53 个数据库用例由独立命令执行、0 失败，12.85 秒。日志 `work/path-rules-test.log`。 |
| `npm run test:db` | 54 项全部通过、0 skip、0 失败，17.44 秒；临时 schema，未领取真实任务。新增用例覆盖读到文件附规则、新建文件补发、补发后仍遗漏时失败且不调用 GitHub 写接口、快照记录给出方式。日志 `work/path-rules-db.log`。 |
| `node --test dist/test/development/rules.test.js` | 5 项通过：全局与目录分流、同一规则只给一次、语言按扩展名匹配、条件标签不阻止、例外带原规则、补发后不再算遗漏、每任务标记不同。 |
| `node --test dist/test/review/agent-session.test.js` | 9 项通过；新增用例用 Provider 替身验证复核轮在同一会话进行、返回最后结果并累计两轮 usage。 |
| `npm run check:docs`、`git diff --check` | 29 篇 Markdown、259 个本地链接与锚点通过；差异格式通过。 |
| `npm run check:format` | 本次改动文件通过；整体仍报 `src/development/worker.ts`，该文件本次未修改，保留原状。全量测试后仅调整了 `rules.ts` 一处注释位置，随后重新构建并通过规则单测。 |

未运行：真实模型与企微群开发验收，因此本轮没有模型角色、usage、delivery 或 PR URL；`npm audit` 未运行（无依赖变更）。限制：规则附加的效果取决于模型是否遵守，需在测试群用带路径规则的真实任务确认。

## 2026-11-09：所有 Agent 改为 Pi 进程运行

用户确认：不再在服务进程里用 Pi SDK，所有 Agent 改为启动 Pi 进程（RPC 模式），直接用 Pi 内置工具、服务扩展、AGENTS.md、Skills 和 codegraph 插件；bash 在服务里直接运行；Review 移除多 Agent，改为单 Agent + Skills；仓库规则文件不加载，仓库 AGENTS.md 只取目标分支版本作参考；工作区没有 codegraph 索引时每次新建，不缓存。设计见 [Pi Runtime 决策](../../.agents/decisions/pi-runtime.md)、[Review Agent 结构决策](../../.agents/decisions/multi-agent-review.md)，开发任务行为见 [企业微信群内 AI 开发](../wecom-development.md#规则和代码修改)。

基线 `75b04f1`，分支 `feat/development-path-rules`，未提交或推送。主要改动：

- 新增 `src/pi/`：进程运行器（临时配置目录、关闭资源发现、最小环境变量、进程组回收）、本地模型代理（请求前持久化预留、收紧输出上限、超预算不转发、占位 key 换真实 key）、服务扩展（路径按 Pi 的解析方式限制在工作区、读取与 codegraph 结果打码、写入前问服务、读写后附团队规则、服务端工具转发）。
- 新增 `agent/`：服务 AGENTS.md 与 7 个 Skills（代码审查、Java、安全、架构、团队规则冲突、开发流程、提交与 PR 规范）。
- 开发任务：Agent 用 edit / write 直接改工作区，可运行检查；服务写入前检查保护范围与"覆盖前先读"，结束后和快照比较收集改动并再查一遍；只交 PR 标题与说明；失败原因写入服务日志。
- 删除 `orchestration.ts`、`delegation.ts`；管理页和 API 去掉审查方式与专项数（数据库列保留）；eval 脚本改为单 Agent，支持 `--runs=N`；Dockerfile 加入 `agent/`、ripgrep、fd-find。

| 命令／操作 | 结果与范围 |
| --- | --- |
| `npm test` | 177 项：123 通过、54 个数据库用例由独立命令执行、0 失败，14.3 秒。 |
| `npm run test:db` | 55 项全部通过、0 skip、0 失败，21.7 秒；临时 schema。 |
| `node --test dist/test/pi/session.test.js` | 13 项通过，真实 Pi 进程 + 本地假模型服务：预留先于发送、usage 结算、预算拒绝不发请求、读取打码与附规则、`@`/`file://`/`~` 等越界写法被拦截、写入需服务批准、`.git` 不可写、服务端工具转发、复核轮、不加载仓库 `.pi` 与 AGENTS.md、子进程拿不到服务变量和模型 key、取消结束进程组、超时与错误分类、图片原样传入、codegraph 建索引不算改动且结果打码。路径越界与 codegraph 打码两项用例在修复前的产物上确认会失败。 |
| `npm run check:docs`、`npm run check:format`、`npm audit --audit-level=high` | 30 篇 Markdown、279 个链接通过；164 个文件格式通过；0 个漏洞。 |
| `docker build`（本机 arm64） | 成功，镜像 1.49 GB；容器内 rg、fdfind、git、`agent/` 与 codegraph 平台包就位。容器内用假模型跑 Pi：find、grep、codegraph_search 均返回结果，小仓库建索引 1245 ms，工作区无残留改动。未构建 amd64。 |

### 固定样本单 Agent 回归（真实模型）

`eval/evaluate-m2.mjs --runs=3`，固定 SHA `ad75aa1e`，预算 160,000，模型 `tuzi/gpt-6.1-sol`（thinking high），结果 `work/m2-evaluation-pi.json`。旧数据见 [M2 清单](./M2.md) 第 2290 行起的表。

| 样本 | 有效次数 | finding 数 | 平均 tokens / 耗时 | 旧 single / 旧 selective |
| --- | --- | --- | --- | --- |
| complex | 3/3 | 5 / 6 / 7 | 69,345 / 141.3 s | 6,994 / 16.1 s；59,686 / 51.7 s |
| java | 3/3 | 5 / 4 / 5 | 89,244 / 133.4 s | 14,583 / 28.4 s；45,530 / 50.6 s |
| security | 0/6 | — | — | 24,100 / 26.2 s；专项全失败 |
| architecture | 2/3 | 3 / 3 | 69,877 / 140.3 s | 结构无效；67,325 / 45.8 s |
| memory | 3/3 | 1 / 1 / 1 | 54,996 / 44.7 s | 7,966 / 10.5 s；43,018 / 37.2 s |
| small | 1/6 | 0 | 35,509 / 202.4 s | 16,351 / 19.9 s |

complex 3 次都指出旧对照里只有专项找到的问题：收款账户不存在时已先扣款、入账抛异常后不恢复；另外稳定指出请求头覆盖会话租户、幂等记录缺租户维度、并发重复扣款、CSV 公式注入。这是 Agent 复核，不代替人工标注。

失败 13 次中 12 次是模型服务在正常响应里返回 `Upstream request failed`，1 次是请求挂起直到 300 秒超时。绕过 Pi 和代理直接请求模型服务，6 次中 1 次出现同样错误，属于上游不稳定。security 没有有效结果，不能据此判断质量。代价：单 Agent 会读代码和用 codegraph，token 约为旧 single 的 6–10 倍、与旧 selective 相当，耗时约为旧 selective 的 2.7 倍。

### 真实开发任务

测试仓库 `M2tHane/tuzi-main-service`（用户授权），GitHub App installation `160592861`。为不影响正在运行的本地服务（旧代码、已连接机器人），任务写入独立 schema、使用独立 bot ID，经真实开发处理器、真实模型和 GitHub App 创建 PR；没有经过企微收发，没有群回复。脚本 `work/dev-e2e/run.mjs`。本次放宽了时限与预算：时限 20 分钟（`.env` 为 300 秒）、预算 1,500,000（默认 160,000）。

需求：令牌 IP 白名单在同一行用英文逗号分隔多个 IP 时会被拼成无效地址，要求普通令牌（允许、禁止列表）和开放平台令牌都支持换行和逗号分隔，并补单元测试。团队规则：全局"JSON 编解码用 common 封装"，`model/**` 范围"解析逻辑要有表驱动测试"；开发身份，保护 `deploy/**`、`.github/**`。

| 项目 | 结果 |
| --- | --- |
| 第 1 次（task `61901708-09af-4f62-b3b2-90498ea15251`，schema `pi_dev_e2e_20261109_23260`，预算 400,000） | failed，180 秒，283,114 tokens，未创建 PR。处理器当时不记录失败原因；结束时没有未结算预留，说明是请求在发送前被拒绝。推断是按字节估算输入的预算预检：代码约 3–4 字节 / token，长会话后单次预留超过剩余额度。已补失败日志。 |
| 第 2 次（task `2ad633e7-e85d-4a8e-bd3b-d66d01d36ee8`，schema `pi_dev_e2e_20261109_9463`） | succeeded，[PR #2](https://github.com/M2tHane/tuzi-main-service/pull/2)，分支 `bot/development/2ad633e7-…`，base `089fd36f`，head `94d769aa`。202 秒（其中 codegraph 建索引 46.6 秒），381,316 tokens（input 33,779、output 3,217、cacheRead 344,320），未知消耗 0。 |
| 改动 | `model/token.go` 改为按换行和逗号拆分；`model/open_platform.go` 复用同一函数；新增表驱动测试 `model/token_ip_limits_test.go`（含 IPv6、CIDR、混合分隔、空值、空白、非法条目保留）。未触及保护路径。标题 `fix(token): 支持 IP 允许和禁止列表使用英文逗号分隔`，正文按三段式并写明运行过的 `go test`。 |
| 规则 | 全局规则随任务给出；`model/**` 规则在 read `model/token.go` 时附加，模型按它补了表驱动测试。 |
| 本地复核 | 在 PR head `94d769a` 上运行 `go test ./model -run 'Test(TokenIPLimitsSeparators\|OpenPlatformTokenIPLimitsNilToken)$'` 与 PR 正文所列 controller 测试，均通过；`go vet ./model` 无输出。 |

未做：企微群收发与群回复、amd64 镜像、真实 Webhook 触发的 Review（本轮只有固定样本回归）。PR #2 保持打开，未合并。两个 `pi_dev_e2e_20261109_*` schema 留在本地库作为证据，可删除。

用户随后决定（同日）：开发任务先不设 token 上限；开发任务时限改为 1 小时；`Upstream request failed` 自动重试整个任务；可以重启本地服务；暂不处理真实 Webhook。

### 预算、时限、重试与本地服务重启

- `DEVELOPMENT_BUDGET_TOKENS` 默认留空表示不限制（设置后仍按额度拦截）；新增 `DEVELOPMENT_TIMEOUT_MS`，默认 3,600,000，开发任务不再使用 `AGENT_TIMEOUT_MS`。审查类任务的预算和时限不变。
- `Upstream request failed` 归为可重试的模型服务错误：Review / Reply / Decision / Health 按任务队列现有规则整单重试（最多 5 次）；开发任务新增整单重试，在新工作区从头执行，最多 3 次，间隔 30 秒、60 秒，用量累加；开始发布后不重试。
- 验证：`npm test` 178 项（123 通过、55 个数据库用例独立执行、0 失败）；`npm run test:db` 56 项全部通过；新增用例覆盖重试后成功且用量累加（40 + 150 = 190）、确定性错误不重试、3 次用尽后失败且三次用量都计入、配置默认值与非法值；`check:format`、`check:docs` 通过。
- 本机安装 `fd`（`brew install fd`），Pi 的 find 工具离线运行需要它；`rg` 已有。
- 重启前确认没有排队或执行中的任务和开发任务；向旧进程（PID 40431，11-06 启动）发 SIGTERM，2 秒内退出；用原命令 `node --env-file-if-exists=.env dist/src/main.js` 启动新构建（PID 18507），日志仍写 `work/local-service.log`。`/healthz`、`/readyz` 均返回 200。企微连接在日志里没有成功事件，需在群里发一条开发需求确认。
