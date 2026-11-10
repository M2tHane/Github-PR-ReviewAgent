# 管理端修改服务设置

状态：实现及本地验证完成，未在真实服务上启用，未推送｜日期：2026-11-09

分支 `feat/integration`（worktree `work/integration`）。行为说明见 [reliability-security 的服务设置](../reliability-security.md#服务设置)。

## 做了什么

- [x] 迁移 `011_service_settings.sql`：`service_settings`（改过的值）和 `service_setting_audits`（修改记录）。
- [x] `src/config/service-settings.ts`：16 项设置的定义、范围校验、启动时和每 30 秒读库并写进共享 config、修改与恢复默认（一个事务，全部校验通过才写）。
- [x] 可改的项：审查／回复复核／规则抽取时限、健康检查时限、开发任务时限；补投 Webhook 检查间隔、数据清理间隔、补投开关；已结束任务保留天数、撤销后删除天数；模型名称、思考强度；OSV 查询和 Semgrep 开关；Worker 并发数、开发任务并发数、开发任务排队上限、开发任务 token 上限。开发相关的 4 项只在启用群内开发时显示。
- [x] 原来写死在代码里的三个值改为可配置：补投间隔（5 分钟）、清理间隔（6 小时）、健康检查时限（120 秒，原来取它和 `AGENT_TIMEOUT_MS` 的较小值，现在只看它）。
- [x] Worker 并发数改完即时生效：调整领取槽位和连接池上限，不用重启。
- [x] 权限：新增 `SERVICE_ADMINS`；接口 `GET/PUT /api/service-settings`。
- [x] 页面「设置 → 服务设置」：按组显示，标明每项来自默认值还是谁何时改的，可恢复默认；调小保留天数时再确认；最近 20 条修改记录，窄屏改为卡片。

## 验证

2026-11-09，在 `work/integration` 顺序运行；模型和 GitHub 用替身。

| 实际命令／操作 | 结果 |
| --- | --- |
| `node --test dist/test/config/service-settings.test.js dist/test/admin/service-settings.test.js dist/test/admin/admin.test.js` | 8 项通过 |
| `node --test dist/test/persistence/database-service-settings.test.js`（临时 schema） | 1 项通过 |
| `SEMGREP_PATH=… npm test` | 230 项：166 通过、0 失败、64 跳过（都是数据库用例，由下一行覆盖） |
| `DATABASE_URL=…（未回显） npm run test:db` | 65 项通过，0 失败，0 跳过 |
| `npm run check:docs`、`npm run check:format`、`git diff --check` | 通过 |
| 预览页（`work/ui-review/preview.mjs`，临时 schema 的演示数据）1440 和 390 宽度截图 | 见下 |

页面看过的情况：超长 GitHub 用户名（来源说明和修改记录里）、100 字符的模型名、token 上限 10 亿、保留天数 0（显示“永久保留”）、思考强度留空（“不指定”）、不是整分钟的默认值（健康检查 95 秒）、超过 20 条修改记录（只显示 20 条）、已删除设置的旧修改记录（显示原 key 和“—”）、只读账号（输入禁用并提示）。操作过：调小保留天数弹出确认、取消后不保存；保存后来源说明和修改记录立即更新；输入小于下限时浏览器拦下。

## 未验证

- 没有在连真实队列的服务上启用；多实例 30 秒内一致只由替身测试和数据库测试覆盖。
- 没看：深色主题、900px 左右的中间宽度、`SERVICE_ADMINS` 为空时的提示（文案只在代码里核对过）。
- 模型名称不做可用性校验，写错要等任务失败才知道。
