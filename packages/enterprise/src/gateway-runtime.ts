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

export function runtimeTargetsForTenant(
  store: EnterpriseStore,
  actorId: string,
  tenantId: string,
): EnterpriseRuntimeTarget[] {
  const targets = new Map<string, EnterpriseRuntimeTarget>();
  for (const customer of store.listCustomers(actorId, tenantId)) {
    const target = store.getCustomerRuntimeTarget(actorId, customer.id);
    targets.set(target.runtimeId, target);
  }
  return [...targets.values()];
}

export function runtimeTargetForId(
  store: EnterpriseStore,
  actorId: string,
  runtimeId: string,
): EnterpriseRuntimeTarget {
  return store.getCustomerRuntimeTarget(actorId, runtimeId);
}
