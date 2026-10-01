import type { EnterpriseRuntimeTarget } from "./types.js";
import type { EnterpriseStore } from "./store.js";

export function publicCustomer(value: import("./types.js").Customer) {
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    metadata: value.metadata,
    workspacePath: value.workspacePath,
  };
}

/** 租户下全部成员的专家 runtime;凭据/Skill/客户变更时逐一停止。 */
export function runtimeTargetsForTenant(
  store: EnterpriseStore,
  actorId: string,
  tenantId: string,
): EnterpriseRuntimeTarget[] {
  return store.expertRuntimeTargetsForTenant(actorId, tenantId);
}
