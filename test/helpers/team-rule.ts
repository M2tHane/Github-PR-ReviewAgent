import { randomUUID } from "node:crypto";
import type { Database } from "../../src/persistence/database.js";
import type { MemoryRecord } from "../../src/memory/types.js";

export async function seedTeamRule(
  database: Database,
  repositoryId: number,
  fields: Partial<Pick<MemoryRecord, "title" | "scope" | "level">> = {},
) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,status,source_fingerprint,level)
     SELECT $1::uuid,1,id,installation_id,'engineering_rule',$3,'团队规则正文','团队规则理由',$4,'{}','ACTIVE',$1::text,$5 FROM repositories WHERE id=$2`,
    [id, repositoryId, fields.title ?? "团队规则", fields.scope ?? { paths: ["**/*.ts"] }, fields.level ?? "must"],
  );
  return { id };
}
