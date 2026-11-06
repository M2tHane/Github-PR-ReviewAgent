# 企业微信群开发任务

状态：实现与本地验证完成，真实群联调待配置｜2026-11-05｜分支：`feat/wecom-development-tasks`

基线：`c4276b2` 加既有 30 个文件的暂存修改；保留通知、主题、规则研究等前序工作。

用户已确认：每群绑定一个仓库和目标分支；服务从目标分支创建开发分支和 PR；管理页设置角色；管理员可修改受保护文件，开发命中后整项拒绝，原保护规则继续有效。

- [x] 群绑定、管理员／开发及文件保护设置、维护权限和审计。
- [x] 智能机器人接收 @ 图文、可信身份、消息去重。
- [x] 固定目标分支快照、规则读取、图片理解、代码修改及权限检查。
- [x] GitHub App 创建分支、提交、PR，自动生成 PR 跳过审查。
- [x] 原群 @ 提出者并汇报 PR，拒绝／失败明确告知。
- [x] 服务测试、独立数据库、管理页验证、文档及依赖检查。
- [ ] 授权测试群／仓库真实验收（需要智能机器人接入配置）。

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
