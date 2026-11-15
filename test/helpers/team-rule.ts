import { randomUUID } from "node:crypto";
import type { Database } from "../../src/persistence/database.js";
import type { MemoryRecord } from "../../src/memory/types.js";

export async function seedTeamRule(
  database: Database,
  repositoryId: number,
  fields: Partial<Pick<MemoryRecord, "title" | "scope" | "level">> = {},
) {
  const teamId = randomUUID(),
    id = randomUUID();
  await database.pool.query("INSERT INTO teams(id,name,created_by) VALUES($1,$2,1)", [teamId, `team-${teamId}`]);
  await database.pool.query("INSERT INTO team_repositories(team_id,repository_id) VALUES($1,$2)", [
    teamId,
    repositoryId,
  ]);
  await database.pool.query(
    `INSERT INTO memories(id,version,team_id,type,title,content,rationale,scope,source,status,source_fingerprint,level)
     VALUES($1::uuid,1,$2,'engineering_rule',$3,'团队规则正文','团队规则理由',$4,'{}','ACTIVE',$1::text,$5)`,
    [id, teamId, fields.title ?? "团队规则", fields.scope ?? { paths: ["**/*.ts"] }, fields.level ?? "must"],
  );
  return { id, teamId };
}
