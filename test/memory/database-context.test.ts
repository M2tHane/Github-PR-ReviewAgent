import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../../src/persistence/database.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import { useTestDatabase } from "../helpers/database.js";
import { seedTeamRule } from "../helpers/team-rule.js";

const fixture = useTestDatabase();
test("上下文读取 ACTIVE 最新版、多团队同范围、项目级别覆盖与成员移除", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!);
  try {
    await database.pool.query(
      "INSERT INTO repositories(id,installation_id,full_name) VALUES(901,1,'context/versions'),(902,1,'context/other')",
    );
    const a = await seedTeamRule(database, 901);
    const b = await seedTeamRule(database, 901);
    await seedTeamRule(database, 902);
    await database.pool.query(
      `INSERT INTO memories(id,version,team_id,type,title,content,rationale,scope,source,status,source_fingerprint,level)
       SELECT id,2,team_id,type,'生效 v2',content,rationale,scope,source,'ACTIVE',source_fingerprint||':v2',level FROM memories WHERE id=$1;
      `,
      [a.id],
    );
    await database.pool.query(
      `INSERT INTO memories(id,version,team_id,type,title,content,rationale,scope,source,status,source_fingerprint,level)
       SELECT id,3,team_id,type,'待确认 v3',content,rationale,scope,source,'CANDIDATE',source_fingerprint||':v3','should' FROM memories WHERE id=$1 AND version=2`,
      [a.id],
    );
    await database.pool.query(
      "INSERT INTO rule_overrides(repository_id,memory_id,team_id,action,level,reason,actor) VALUES(901,$1,$2,'level','info','项目选择','test')",
      [a.id, a.teamId],
    );
    const memories = new MemoryService(database);
    const input = { paths: ["src/a.ts"], text: "" };
    const context = await memories.context(901, input);
    assert.deepEqual(
      context.full.map((rule) => rule.id),
      [b.id, a.id],
    );
    assert.equal(context.full[1]?.version, 2);
    assert.equal(context.full[1]?.level, "info");
    assert.equal(context.full[1]?.teamLevel, "must");
    assert.equal(context.total, 2);
    await database.pool.query("DELETE FROM team_repositories WHERE team_id=$1 AND repository_id=901", [a.teamId]);
    assert.deepEqual(
      (await memories.context(901, input)).full.map((rule) => rule.id),
      [b.id],
    );
  } finally {
    await database.close();
  }
});
