import type { MemoryRecord } from "../src/memory/types.js";

import type { JobPage, JobRow, Overview, Repository } from "../src/admin/dto.js";

export type { JobPage, Overview, Repository };
export type Job = JobRow;
export type Memory = MemoryRecord;
export type SessionResponse = { user: { id: number; login: string }; csrf: string };
export type BootstrapResponse = { repositories: Repository[]; memories: Memory[] };
