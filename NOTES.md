# NOTES

记录容易被误判成缺陷、但其实是有意为之的做法。评审或改代码前先看这里。

## Review 的 bash 不做限制（有意为之）

2026-11-09 用户确认：PR Review Agent 的 bash 不受限制，是特意这么做的，不是遗漏。

- 现状：`src/pi/extension.ts` 只检查 read、grep、find、ls、edit、write 的路径；bash 不做命令、路径或网络限制，只对输出打码。Review 的提示词允许用 bash 运行不修改仓库的检查或测试（`src/review/agent.ts` 的 `REVIEW_RULES`）。
- 目的：让 Agent 能用类型检查、单个测试等实际运行结果确认问题，而不是只靠读代码猜。
- 已知代价：bash 和服务是同一个系统用户，环境变量和 HOME 隔离只能避免顺手暴露凭据，挡不住刻意读取。这一点在 [Pi Runtime](.agents/decisions/pi-runtime.md) 和 [工作区安全](.agents/decisions/github-workspace-security.md) 里已经写明，属于已接受的风险。
- 不要把它当缺陷去修：不给 bash 加命令白名单、路径拦截、禁网或容器，也不从 Review 提示词里去掉“可以运行检查或测试”，除非用户明确提出。
