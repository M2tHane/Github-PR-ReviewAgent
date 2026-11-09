---
name: memory-conflict-review
description: 检查本次变更与团队规则（activeTeamMemories）的范围、例外、替代关系和相互冲突。输入里有团队规则时读取。
---

# 团队规则冲突检查

- **适用范围：** 规则的 scope（paths、languages、modules、conditions）是否真的覆盖本次改动的文件。不覆盖的规则不能作为 finding 依据。
- **例外：** 有 `exceptionTo` 的规则是对另一条规则的窄范围豁免；落在例外范围内的代码按例外判断，不按原规则报问题。
- **替代：** 被 supersedes 替代的旧规则不再作为依据。
- **冲突：** 两条规则对同一处代码给出相反要求时，不按任何一条报 finding，在 summary 里写明冲突的两条规则，请维护者处理。
- 不能修改、新增或捏造规则；引用时逐字使用规则的 id、version、source。
