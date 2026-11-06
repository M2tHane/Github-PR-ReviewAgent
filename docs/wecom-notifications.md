# 企业微信 PR 审查完成通知

## 通知效果与范围

GitHub PR 审查结果发布成功后，服务通过企业微信「消息推送」（原群机器人）向一个内部群发送普通 Markdown 消息：

```text
@成员

AI 审查已完成
项目：owner/repository
PR：#123 修复订单金额计算
查看审查结果（可点击）
```

消息首行通过 `<@userid>` 指定 PR 作者对应的企业微信成员 ID；后续分行显示状态、项目、PR 编号与标题，以及独立一行的「查看审查结果」链接，不显示提交 SHA。使用支持 @ 的普通 `markdown`，不使用 `markdown_v2`。PR 标题使用发送时从 GitHub 读取的最新值，按现有密钥规则打码并转义格式；消息不包含 PR 描述、问题明细或修改建议；部分审查会说明「部分检查未完成」。新提交触发的新一轮有效审查仍会通知，同一发布记录只创建一条通知。

首版支持一个通知群；各项目的成员关联在前端「仓库 → 通知成员」分别维护，支持新增、编辑企业微信 ID 和删除。不同项目可以为同一 GitHub 账号关联不同 ID，不跨仓库兜底。不包含群内指令、私聊、自建应用或审查失败通知。GitHub 仍要求访问者拥有仓库访问权限。@ 的实际客户端提醒效果必须通过下文的真实群验收，接口返回成功不代表对方已阅读或收到系统通知。

## 配置与启用

1. 在企业微信内部群添加「消息推送」，由创建者取得 Webhook。外部群不适用。
2. 取得需要通知的成员 ID，确保该成员已在目标群内。对应关系使用 GitHub 登录名，不是提交作者姓名或 Webhook 操作者。
3. 在被 Git 忽略的 `.env` 中配置群 Webhook，所有实例保持一致：

```dotenv
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=replace-me
```

Webhook 只接受 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`，禁止重定向。Webhook 是发送凭据，不要放入 Git、截图或普通日志。

4. 升级服务前手动执行 `npm run migrate`，应用增量迁移 `004_wecom_notifications.sql`；启动不会自动迁移。然后构建并启动服务。不要对已有数据库单独执行 baseline。

5. 登录管理页，打开「仓库」，点击对应项目的「通知成员」。在成员关联表格右上角点击「添加成员」，在弹窗填写 GitHub 登录名（如 `alice`）及企业微信成员 ID（如 `zhangsan`），点击「保存关联」。为每个项目分别添加成员；每行末尾的「编辑」打开编辑弹窗，「删除」需要确认。只有该仓库的 maintain/admin 可查看和修改；写操作校验 CSRF。

GitHub 登录名忽略大小写，同一项目重复保存该账号会更新关联。非法账号、非法成员 ID、`@all` 或伪造其他仓库字段会被拒绝。账号关联存入数据库，保存后生效，不需要重启；页面不会返回 Webhook。未配置 Webhook 时可先设置成员，界面会提示尚未接入消息推送。

未配置 `WECOM_WEBHOOK_URL` 时关闭通知。只对启用期间新确认发布的 Review 建立通知，不扫描并补发历史审查。更换 Webhook key 后，旧通知仍绑定原 key 的哈希，不会投递到新群；旧队列需要按实际情况人工处理。滚动部署时应统一各实例配置，仍运行的旧实例无法产生通知记录。

## 流程与失败处理

```text
GitHub Review 已确认发布
  → 同一条数据库语句保存发布状态及待通知记录
  → 独立通知轮询领取
  → 检查仓库授权、启用状态与 installation
  → 从 GitHub 读取当前 PR 状态、head 和 PR 作者
  → 在当前仓库的成员关联表中，按 GitHub 登录名查成员 ID
  → 再检查仓库启用状态
  → 记录发送开始并调用企业微信
  → 保存发送结果
```

通知发送不进入 AI Job 的重试路径，不消耗额外模型 token。GitHub 发布尚不确定、失败或被取消时没有完成通知。新 head、Draft、关闭、仓库停用或撤销授权会取消待发送的旧通知。

通知状态保存在 `review_notifications`：

| 状态 | 含义与处理 |
| --- | --- |
| `pending` | 等待发送，或发送前 GitHub 读取失败、企微明确返回限流/系统繁忙。间隔至少 60 秒，GitHub 返回等待时间时遵守该时间（上限 1 小时），最多尝试 3 次。 |
| `sending` | 已记录投递开始，外部结果尚未保存。 |
| `sent` | 收到企微 `errcode=0`。不代表成员已读或收到 @ 提醒。 |
| `failed` | 缺少成员映射、明确的接口拒绝、权限问题、响应字段错误（GitHub）或次数耗尽。日志给出原因代码。 |
| `uncertain` | POST 断网、超时、非成功 HTTP 状态、企微响应损坏，或进程在 `sending` 时中断。可能已发送，不自动重试。 |
| `cancelled` | PR 状态/head 或仓库授权不再满足发送条件。 |

通知日志事件为 `wecom_notification_result`，保留 Job、仓库、PR、状态和原因代码；不记录 Webhook、企微成员 ID、消息正文或上游原始错误消息。

只读查询示例（使用运维数据库连接，不能向分析 Agent 开放）：

```sql
SELECT n.job_id, j.repository, j.pr_number, j.target_sha,
       n.status, n.attempt, n.last_error, n.updated_at
FROM review_notifications n JOIN jobs j ON j.id=n.job_id
ORDER BY n.created_at DESC LIMIT 50;
```

缺少映射会记录 `author_mapping_missing`，不会降级成普通消息或 @ 所有人。在前端补齐映射后，可以只重排这类明确未发送的通知；将下面的 `JOB_UUID` 替换为查询到的任务 ID：

```sql
UPDATE review_notifications
SET status='pending', attempt=0, last_error=NULL, next_run_at=now(), updated_at=now()
WHERE job_id='JOB_UUID'::uuid AND status='failed' AND last_error='author_mapping_missing';
```

`uncertain` 必须先检查群聊天记录，不能直接套用重试 SQL。企微 Webhook 不提供本项目可用于按本次投递 ID 核对消息的接口，因此不承诺 exactly-once。发送前检查与外部请求之间仍有短暂竞态，不能承诺在新提交到达的同一瞬间阻止所有已开始发送的通知。

## 多实例与性能

通知使用独立的 PostgreSQL 会话锁，按 Webhook key 哈希串行发送。每次发出请求前保存群的最近发送时间，跨实例保持至少 3.1 秒间隔，低于官方每分钟 20 条上限；人工或其他系统共用同一 Webhook 的发送不在本服务计数内。进程退出后，下一实例将残留的 `sending` 标为 `uncertain`，不重发。

每实例每 4 秒轮询一次，空闲时一条索引查询（约 0.25 次/秒）。一次正常投递约 12 次数据库往返、2 次 GitHub HTTP 请求（installation token、读取 PR）、1 次企微 HTTP 请求；不调用模型。发送时占用一条数据库连接，每实例最多处理一个通知，不与审查 Worker 共用任务槽位。积压通知只保存在数据库，不整体加载到内存。企微请求含响应读取超时为 10 秒；GitHub 使用现有客户端超时和停止信号。

以上开销来自代码路径计数，真实网络延迟和高负载性能尚未测量。成员关联按仓库 ID 隔离，通知发送时通过主键单次查询，不增加整表加载或模型开销。成员界面只在打开指定仓库抽屉时加载；成员随仓库删除级联清理。通知随 Review/Job 的数据保留策略级联删除；群限速表只保留 key 哈希和最后发送时间，不保存密钥。后续若更换过很多 Webhook，可人工清理不再使用的群限速记录。

## 真实群验收

自动化使用 GitHub 和企微替身，不发送真实消息。正式启用前，在授权的测试仓库和内部测试群完成：

1. 配置两名测试成员，创建测试 PR，确认审查结果先出现在 GitHub。
2. 确认群消息只有完成状态和链接，@ 的是 PR 作者；由另一人推送新提交时仍通知 PR 作者。
3. 接收方切换到其他会话，检查是否出现真正的被 @ 提示；分别记录桌面、手机和群免打扰时的表现。仅看到名字、`errcode=0` 或普通未读消息都不足以证明 @ 提醒有效。
4. 点击链接，确认有权限的成员可打开对应 PR。
5. 记录客户端版本、测试时间、Job/Review/PR 链接和接收方观察结果。真实验收证据写入 [UX 任务清单](tasks/UX.md)。

官方资料存在冲突：[接口文档](https://developer.work.weixin.qq.com/document/path/99110) 提供 `mentioned_list`；[腾讯云接入文档](https://cloud.tencent.com/document/product/1263/71731) 说明指定成员会被 @；[企微帮助中心](https://open.work.weixin.qq.com/help2/pc/14931) 却有暂不支持 @ 提醒的说明。当前实现采用普通 Markdown 的 `<@userid>` 扩展语法，实际提醒效果保留为必须实测的验收项。
