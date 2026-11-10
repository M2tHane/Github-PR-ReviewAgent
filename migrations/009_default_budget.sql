-- 改为 Pi 进程后，单 Agent 审查一个小 PR 实测约 7–9 万 token，旧默认 2 万会让审查几乎都超预算。
-- 新默认 50 万；仍是旧默认值的仓库一起调整，单独设置过的不动。
ALTER TABLE repositories ALTER COLUMN budget_tokens SET DEFAULT 500000;
UPDATE repositories SET budget_tokens=500000 WHERE budget_tokens=20000;
