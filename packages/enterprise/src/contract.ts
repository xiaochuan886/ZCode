import type {
  Customer,
  EnterpriseRuntimeTarget,
  EnterpriseSession,
  McpBinding,
  SharedSkill,
} from "./types.js";

/** Customer preparation and gateway consume these scoped reads. */
export interface EnterpriseCustomerReader {
  getCustomer(actorId: string, customerId: string): Customer;
  getActiveCustomer(sessionId: string): Customer | null;
  getActiveRuntimeTarget(sessionId: string): EnterpriseRuntimeTarget | null;
  listSkillsForCustomer(actorId: string, customerId: string): SharedSkill[];
  listMcpBindingsForCustomer(actorId: string, customerId: string): McpBinding[];
}
export interface EnterpriseSessionReader {
  resolveSession(tokenHash: string): EnterpriseSession | null;
}
