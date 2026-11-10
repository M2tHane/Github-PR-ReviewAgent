import type { MemoryRecord } from "../src/memory/types.js";

import type { JobPage, JobRow, Overview, Repository } from "../src/admin/dto.js";

export type { JobPage, Overview, Repository };
export type Job = JobRow;
export type Memory = MemoryRecord;
export type SessionResponse = { user: { id: number; login: string }; csrf: string };
export type SettingValue = import("../src/config/service-settings.js").SettingValue;
export type SettingDefinition = Omit<import("../src/config/service-settings.js").SettingDefinition, "read" | "write">;
export type ServiceSettingsResponse = {
  canEdit: boolean;
  adminsConfigured: boolean;
  developmentConfigured: boolean;
  definitions: SettingDefinition[];
  settings: import("../src/config/service-settings.js").SettingState[];
  audits: import("../src/config/service-settings.js").SettingAudit[];
};
export type BootstrapResponse = { repositories: Repository[]; memories: Memory[] };
