export type Role = "admin" | "member";
export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}
export interface Membership {
  tenantId: string;
  userId: string;
  role: Role;
}
export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}
export type EnterpriseRuntimeKind = "customer";
export interface EnterpriseRuntimeTarget {
  id: string;
  tenantId: string;
  customerId: string;
  workspacePath: string;
  runtimeId: string;
  kind: EnterpriseRuntimeKind;
}
export interface EnterpriseSession {
  id: string;
  userId: string;
  activeCustomerId: string | null;
  expiresAt: string;
}
export interface SharedSkill {
  id: string;
  tenantId: string;
  sourceCustomerId: string;
  name: string;
  content: string;
  contentHash: string;
  createdAt: string;
}
export interface McpBinding {
  id: string;
  tenantId: string;
  customerId: string | null;
  name: string;
  endpoint: string;
  secretRef: string | null;
  createdAt: string;
}
export class EnterpriseError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_transition"
      | "invalid_credentials"
      | "conflict"
      | "validation",
  ) {
    super(code);
    this.name = "EnterpriseError";
  }
}
