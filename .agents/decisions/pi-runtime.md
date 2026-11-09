# Pi Runtime

## Context

Agent 最初用 Pi SDK 在服务进程内运行，读写、搜索等基础工具都由服务自己实现。开发任务需要像编码助手一样边读边改、运行检查，还要用上 Pi 的插件（codegraph）、AGENTS.md 和 Skills；继续自写工具成本高，也用不上这些生态。

## Decision

所有 Agent（Review、Reply、Decision Extractor、Health、开发任务）都由 [Pi 运行器](../../src/pi/session.ts) 启动独立的 `pi` 进程（RPC 模式），一个任务一个进程，结束时连同它启动的命令（同一进程组）一起结束。

- **资源只来自服务。** 关闭 Pi 的扩展、Skills、提示模板、主题和上下文文件自动发现；只加载服务的 [AGENTS.md 与 Skills](../../agent/)、[服务扩展](../../src/pi/extension.ts) 和锁定版本的 codegraph 扩展。Pi 配置目录每次新建，不读宿主机 `~/.pi` 和仓库 `.pi`。仓库 AGENTS.md 由服务从目标分支读出后附在系统提示末尾，作为参考。
- **规则优先级：** 服务的安全要求与输出格式 > 团队规则（例外优先于原规则）> 仓库 AGENTS.md。仓库的 CLAUDE.md、`.claude/rules` 不加载。
- **工具：** 使用 Pi 内置的 read、grep、find、ls、bash；只有开发任务另有 edit、write。Health 只用服务端工具，按读过的行核对证据。
- **服务扩展只转发：** 文件工具的路径限制在工作区内，读取结果打码；写入前问服务（保护范围、覆盖前先读），读写后由服务附加匹配的团队规则；服务端工具在服务进程里执行。状态都留在服务里。
- **预算由本地模型代理执行：** Pi 只拿到占位 key 和代理地址。代理在每次请求前持久化预留额、收紧输出上限，超预算直接拒绝，不转发；转发时换成真实 key。
- **开发改动从工作区收集：** 和运行前记录的快照逐个比较（Agent 自己 commit 也算），按 .gitignore 过滤未跟踪文件，再查路径、保护范围、文件数和大小。
- 工作区没有 `.codegraph/` 时先建索引，不缓存；建索引失败不影响任务，只是不加载 codegraph 工具。

## Why

Pi 的 `before_provider_request` 钩子抛错不会阻止请求，预算只能在进程外拦截，所以用本地代理。凭据不出现在 Pi 的配置、命令行和环境变量里。bash 让 Agent 能运行检查，代价是它和服务同一系统用户：环境变量和 HOME 隔离只能避免顺手暴露，挡不住刻意读取，需要更强隔离时再改为每任务一个容器。

## Constraints

- 新增 Agent 调用一律走 `runPiSession`（经 `runAgentSession`），不要直接启动 Pi 或调用 SDK 的 `createAgentSession`。
- Pi 子进程只拿 `processEnv()` 给的变量，不继承数据库、GitHub、企微和模型凭据；新增变量要逐个评估。
- 关闭 Pi 自身的重试和上下文压缩：重试由任务队列按错误类型决定，压缩会让预算和证据难以核对。
- 写入检查只是第一道关：命令也能改文件，开发任务发布前必须对收集到的全部改动再查一遍。
- 升级 Pi 或 codegraph 要跑 `test/pi/session.test.ts`：RPC 事件、扩展钩子和 CLI 参数都和版本绑定。
