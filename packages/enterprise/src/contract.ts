import type { EnterpriseCase, EnterpriseSession, McpBinding, SharedSkill } from "./types.js";

/** Case preparation and gateway consume these scoped reads. */
export interface EnterpriseCaseReader {
  getCase(actorId: string, caseId: string): EnterpriseCase;
  getActiveCase(sessionId: string): EnterpriseCase | null;
  listSkillsForCase(actorId: string, caseId: string): SharedSkill[];
  listMcpBindingsForCase(actorId: string, caseId: string): McpBinding[];
}
export interface EnterpriseSessionReader {
  resolveSession(tokenHash: string): EnterpriseSession | null;
}
