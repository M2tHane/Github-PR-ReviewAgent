# Pi SDK 安全升级

状态：实现与隔离验证完成，待本地服务切换｜2026-11-06

基线：`edee1fd34dd7de7ea9d77a4a0f1431f7ccbafb43`。用户确认升级官方 Pi SDK 至 1.5.0、完成兼容性验证后升级本地服务并提交合并。使用独立 `fix/pi-sdk-security` 分支及 worktree 安装和测试，验证期间日常服务继续使用原依赖。

## 改动

- 固定 `@earendil-works/pi-coding-agent` 为 1.5.0，更新锁文件；不使用 overrides 或强制自动修复。
- 依赖树中的 minimatch 为 11.0.3、brace-expansion 为 5.0.12、undici 为 8.12.3，原 2 high、2 moderate 告警消除。
- 适配新版图片规范化行为：SDK 丢弃损坏图片时，在 Provider 请求发送前明确拒绝，防止无图继续执行任务。没有放宽工具、路径或预算权限。
- 会话测试使用明确注册的自定义模型替身，避免依赖随 SDK 更新的内置模型目录；按新版 system 消息中的指令和 toolsAdded 校验权限，图像样本改为有效 PNG。
- 新增损坏图片拒绝、工具参数校验与 shell 禁用、真实 SDK 连接本地 HTTP 流的回归；加强待审仓库 `.pi` 配置／扩展不被加载的检查。

## 验证

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm install --save-exact @earendil-works/pi-coding-agent@1.5.0`（独立 worktree） | 安装通过，审计 0 漏洞；日志 `work/pi-sdk-install.log`。 |
| `npm run build` 与 `node --test dist/test/review/agent-session.test.js` | 构建通过，8 项会话测试全部通过，约 0.77 秒。 |
| `SEMGREP_PATH=<本机既有 Semgrep 绝对路径> npm test` | 173 项：122 通过、51 项数据库用例单独执行、0 失败，10.19 秒；日志 `work/pi-sdk-tests-final.log`。 |
| 通过父进程加载本地 `.env` 后执行 `npm run test:db` | 52 项全部通过，0 skip、0 失败，9.30 秒；数据库用例使用临时 schema，未领取真实任务。日志 `work/pi-sdk-db.log`。 |
| `npm audit --audit-level=high --json` | 0 漏洞；完整报告 `work/pi-sdk-audit.json`。 |
| `npm run check:docs`、`git diff --check` | 通过。 |

首轮失败保留于 `work/pi-sdk-tests.log`：旧测试使用不在新内置目录的模型名、无效图片、旧请求上下文结构；独立 worktree 尚无 `work/` 临时目录。修正测试输入与消息断言、创建临时目录后复验；Semgrep 使用已有安装的绝对路径，避免独立 worktree 缺少工具而跳过三项验证。未为通过测试放宽生产校验或更换实际服务模型。

会话验证涵盖：服务系统指令与工具定义进入 HTTP 请求、输出上限、预算不足时不发送请求、usage 记账、失败时未知消耗保留、并发取消、会话消息隔离、视觉输入、参数拒绝及禁用 shell。HTTP 服务为本机替身，未连接真实模型供应商；没有真实模型 usage、业务 delivery／Job／finding／Review／reply URL。图片完整性检查的业务逻辑不涉及数据库迁移。

本地运行和提交证据在切换完成后补充。未升级远程生产环境，企微开发机器人未配置的限制继续有效。
