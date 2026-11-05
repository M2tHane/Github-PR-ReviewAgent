import type { MemoryRecord } from "../src/memory/types.js";

import type { JobRow, Repository } from "../src/admin/dto.js";

export type { Repository };
export type Job = JobRow;
export type Memory = MemoryRecord;
export type SessionResponse = { user: { id: number; login: string }; csrf: string };
export type BootstrapResponse = { repositories: Repository[]; jobs: Job[]; memories: Memory[] };
