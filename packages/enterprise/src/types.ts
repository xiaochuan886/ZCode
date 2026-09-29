export type Role = "admin" | "member";
export type CaseStatus = "open" | "in_progress" | "resolved" | "closed";
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
export interface ServiceSpace {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
}
export interface ServiceObject {
  id: string;
  tenantId: string;
  serviceSpaceId: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface ObjectSnapshot {
  name: string;
  type: string;
  metadata: Record<string, unknown>;
}
export interface EnterpriseCase {
  id: string;
  tenantId: string;
  serviceSpaceId: string;
  serviceObjectId: string;
  title: string;
  category: string;
  status: CaseStatus;
  workspacePath: string;
  objectSnapshot: ObjectSnapshot;
  contextSnapshot: Record<string, unknown>;
  nativeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface EnterpriseSession {
  id: string;
  userId: string;
  activeCaseId: string | null;
  expiresAt: string;
}
export interface SharedSkill {
  id: string;
  tenantId: string;
  serviceSpaceId: string | null;
  sourceCaseId: string;
  name: string;
  content: string;
  contentHash: string;
  createdAt: string;
}
export interface McpBinding {
  id: string;
  tenantId: string;
  serviceSpaceId: string | null;
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
