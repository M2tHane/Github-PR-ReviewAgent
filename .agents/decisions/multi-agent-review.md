# Review Agent 结构

## Context

M2 曾按复杂度触发 Main + Specialist 多 Agent 审查。固定样本对比显示：多 Agent 的 token 消耗是单 Agent 的 3–9 倍、耗时 2–3 倍，5 个样本里 3 个出现专项失败，只有 1 个疑似增益且未经人工确认。迁到 Pi 进程后，专项视角可以写成 Skill，由同一个 Agent 按需读取。

## Decision

PR Review 只用一个 Agent。Java、安全、架构、团队规则冲突的检查方法写成服务自有的 [Skills](../../agent/skills/)，Agent 根据变更自行读取。仓库设置里的审查方式和专项数不再生效，数据库列保留，历史任务的编排记录仍可在管理页查看。

单 Agent 仍输出完整候选 finding 和 `findingGroups`：同一根因的意见分到一组，服务检查每个候选恰好出现一次、不遗漏、不伪造引用，并保留原始证据。

## Why

多 Agent 的成本和失败率没有换来可确认的质量提升。Skill 只在需要时进入上下文，不额外创建会话，也没有委派、子预算和 partial 结果这些需要额外处理的状态。

## Constraints

- 不重新引入委派前，先用 `eval/` 固定样本对比单 Agent，每个样本至少运行 3 次。
- Skill 是服务资源，只写通用检查方法，不写评测样本的答案。
- 分组只能合并同一根因；不同团队规则的意见不能合并。
- Reply 只复核已绑定的人类线程和当前 head，不能直接修改 `ACTIVE` Memory。
