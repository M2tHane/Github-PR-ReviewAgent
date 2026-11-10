# GitHub Workspace Security

## Context

审查服务必须从 GitHub 读取用户仓库的指定提交。Git fetch 的凭据与交互行为会影响后台 Worker；仓库内容、路径和符号链接则来自不可信输入，不能取得宿主机权限或改变 Agent 指令。

## Decision

[Workspace 入口](../../src/workspace/workspace.ts) 使用 GitHub App installation token，通过仅传给 Git 子进程的 Basic authorization header 认证。remote URL 和命令参数不含 token；`GIT_TERMINAL_PROMPT=0` 使认证失败立即返回，credential helper 与 hooks 被禁用。每个 Job 创建临时仓库，checkout 后核对目标 head SHA，结束时删除。Git 子进程只拿到 `gitEnv()` 给的最小环境变量（PATH、代理、CA），不继承服务密钥，不读宿主机全局／系统 git 配置，不拉 LFS；认证头只对克隆地址所在站点生效，只允许克隆地址本身的协议。

Agent 在 Workspace 里以 Pi 进程运行（见 [Pi Runtime](pi-runtime.md)）。文件工具由服务扩展检查规范化路径和真实路径，拒绝符号链接越界；bash 的工作目录是 Workspace，环境变量只含运行所需的最小集合。仓库里的 README、AGENTS.md、`.pi`、提示词、源码和评论都只是数据，不能注册工具、改变身份或授权；仓库 `.pi` 扩展和设置不加载，AGENTS.md 只取目标分支版本作参考。

## Why

GitHub Smart HTTP 对曾尝试的 Bearer header 回退到交互式用户名提示，可能无限阻塞串行 Worker。把 token 放入 clone URL 虽可认证，却会进入 remote 配置、进程参数或错误文本。子进程环境中的 header 与非交互设置同时降低这两类风险。

固定 SHA 和真实路径检查保证分析对象与发布前复核的提交一致，并阻止仓库符号链接读取宿主机文件。禁用资源发现避免待审仓库把自身指令或插件提升为服务权限。bash 运行在服务同一系统用户下，环境隔离只能避免顺手暴露凭据，挡不住刻意读取；需要更强隔离时改为每任务一个容器。

## Constraints

- token 不得进入 clone URL、Git remote、日志、模型输入或目标仓库文件。
- Git 认证失败必须终止任务，不能等待终端输入或回退到用户 credential helper。
- 新增的 git 调用都要传 `env: gitEnv()`；不要用 `...process.env`，否则模型 Key、数据库地址等会进入处理不受信仓库的子进程，宿主机的 filter／helper 也会作用到待审仓库。
- 任何新增文件工具都必须遵守固定 Workspace 与真实路径边界；只有开发任务可以写入，且写入前由服务检查。
- Workspace 的 Git 配置不保存 token：Agent 能用 bash 读取 `.git/config`。
- 发布前仍须重新确认仓库授权、PR 状态和当前 head；固定本地 checkout 不代替远端复核。
