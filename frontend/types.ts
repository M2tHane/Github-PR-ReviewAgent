import type { MemoryWithUsage } from "../src/memory/types.js";

import type { JobPage, JobRow, Overview, Repository } from "../src/admin/dto.js";

export type { JobPage, Overview, Repository };
export type { Team, RuleOverride } from "../src/admin/teams.routes.js";
export type Job = JobRow;
export type Memory = MemoryWithUsage;
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
export type BootstrapResponse = {
  repositories: Repository[];
  memories: Memory[];
  teams: import("../src/admin/teams.routes.js").Team[];
};
