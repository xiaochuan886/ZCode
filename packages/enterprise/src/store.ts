import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type CaseStatus,
  type EnterpriseCase,
  type EnterpriseSession,
  type McpBinding,
  type SharedSkill,
} from "./types.js";
import { EnterpriseStoreBase, type Row, now, id, json, parse, fail } from "./store-base.js";
import {
  ModelCredentialStore,
  type ModelCredentialEncryptionKey,
  type ModelCredentialStatus,
} from "./model-credentials.js";

export interface EnterpriseStoreOptions {
  modelCredentialsEncryptionKey?: ModelCredentialEncryptionKey;
}

export class EnterpriseStore extends EnterpriseStoreBase {
  private readonly modelCredentials: ModelCredentialStore;

  private constructor(
    db: DatabaseSync,
    workspaceRoot: string,
    modelCredentialsEncryptionKey?: ModelCredentialEncryptionKey,
  ) {
    super(db, workspaceRoot);
    this.modelCredentials = new ModelCredentialStore(
      db,
      this.transaction.bind(this),
      this.membership.bind(this),
      modelCredentialsEncryptionKey,
    );
  }
  static async open(
    dbPath: string,
    workspaceRoot: string,
    options: EnterpriseStoreOptions = {},
  ): Promise<EnterpriseStore> {
    await mkdir(dirname(resolve(dbPath)), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const store = new EnterpriseStore(
      db,
      resolve(workspaceRoot),
      options.modelCredentialsEncryptionKey,
    );
    store.migrate();
    return store;
  }
  private case(row: Row): EnterpriseCase {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      serviceSpaceId: String(row.service_space_id),
      serviceObjectId: String(row.service_object_id),
      title: String(row.title),
      category: String(row.category),
      status: row.status as CaseStatus,
      workspacePath: String(row.workspace_path),
      objectSnapshot: parse(row.object_snapshot) as unknown as EnterpriseCase["objectSnapshot"],
      contextSnapshot: parse(row.context_snapshot),
      nativeSessionId: row.native_session_id == null ? null : String(row.native_session_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  createCase(
    actorId: string,
    objectId: string,
    input: { title: string; category?: string; contextSnapshot?: Record<string, unknown> },
  ): EnterpriseCase {
    return this.transaction(() => {
      const object = this.getServiceObject(actorId, objectId);
      if (!input.title.trim()) fail("validation");
      const caseId = id();
      const objectSnapshot = { name: object.name, type: object.type, metadata: object.metadata };
      const record = {
        id: caseId,
        tenantId: object.tenantId,
        serviceSpaceId: object.serviceSpaceId,
        serviceObjectId: object.id,
        title: input.title.trim(),
        category: input.category?.trim() || "general",
        status: "open" as const,
        workspacePath: join(this.workspaceRoot, caseId),
        objectSnapshot,
        contextSnapshot: { ...input.contextSnapshot, serviceObject: objectSnapshot },
        nativeSessionId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.run(
        "INSERT INTO cases VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        record.id,
        record.tenantId,
        record.serviceSpaceId,
        record.serviceObjectId,
        record.title,
        record.category,
        record.status,
        record.workspacePath,
        json(record.objectSnapshot),
        json(record.contextSnapshot),
        null,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    });
  }
  getCase(actorId: string, caseId: string): EnterpriseCase {
    const row = this.one("SELECT * FROM cases WHERE id=?", caseId);
    if (!row) throw new EnterpriseError("not_found");
    this.membership(actorId, String(row.tenant_id));
    return this.case(row);
  }
  listCases(actorId: string, spaceId: string): EnterpriseCase[] {
    this.space(actorId, spaceId);
    return this.all(
      "SELECT * FROM cases WHERE service_space_id=? ORDER BY created_at",
      spaceId,
    ).map((row) => this.case(row));
  }
  transitionCase(actorId: string, caseId: string, status: CaseStatus): EnterpriseCase {
    return this.transaction(() => {
      const record = this.getCase(actorId, caseId);
      const allowed: Record<CaseStatus, CaseStatus[]> = {
        open: ["in_progress"],
        in_progress: ["resolved"],
        resolved: ["closed", "in_progress"],
        closed: ["in_progress"],
      };
      if (!allowed[record.status].includes(status)) fail("invalid_transition");
      this.run("UPDATE cases SET status=?,updated_at=? WHERE id=?", status, now(), caseId);
      return this.getCase(actorId, caseId);
    });
  }
  bindNativeSession(
    actorId: string,
    caseId: string,
    nativeSessionId: string | null,
  ): EnterpriseCase {
    this.getCase(actorId, caseId);
    this.run(
      "UPDATE cases SET native_session_id=?,updated_at=? WHERE id=?",
      nativeSessionId,
      now(),
      caseId,
    );
    return this.getCase(actorId, caseId);
  }
  issueSession(userId: string, tokenHash: string, csrfHash: string): EnterpriseSession {
    const session = {
      id: id(),
      userId,
      activeCaseId: null,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    this.run(
      "INSERT INTO sessions VALUES(?,?,?,?,?,?)",
      session.id,
      userId,
      tokenHash,
      csrfHash,
      null,
      session.expiresAt,
    );
    return session;
  }
  private session(row: Row): EnterpriseSession {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      activeCaseId: row.active_case_id == null ? null : String(row.active_case_id),
      expiresAt: String(row.expires_at),
    };
  }
  resolveSession(tokenHash: string): EnterpriseSession | null {
    const row = this.one(
      "SELECT * FROM sessions WHERE token_hash=? AND expires_at>?",
      tokenHash,
      now(),
    );
    if (!row) return null;
    if (row.active_case_id) {
      const c = this.one("SELECT tenant_id FROM cases WHERE id=?", String(row.active_case_id));
      if (
        !c ||
        !this.one(
          "SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=?",
          String(row.user_id),
          String(c.tenant_id),
        )
      )
        return null;
    } else if (!this.one("SELECT 1 FROM memberships WHERE user_id=? LIMIT 1", String(row.user_id)))
      return null;
    return this.session(row);
  }
  revokeSession(tokenHash: string): void {
    this.run("DELETE FROM sessions WHERE token_hash=?", tokenHash);
  }
  matchesCsrf(sessionId: string, csrfHash: string): boolean {
    return Boolean(
      this.one("SELECT 1 FROM sessions WHERE id=? AND csrf_hash=?", sessionId, csrfHash),
    );
  }
  activateCase(sessionId: string, caseId: string): EnterpriseSession {
    return this.transaction(() => {
      const row = this.one("SELECT * FROM sessions WHERE id=? AND expires_at>?", sessionId, now());
      if (!row) throw new EnterpriseError("forbidden");
      this.getCase(String(row.user_id), caseId);
      this.run("UPDATE sessions SET active_case_id=? WHERE id=?", caseId, sessionId);
      return { ...this.session(row), activeCaseId: caseId };
    });
  }
  getActiveCase(sessionId: string): EnterpriseCase | null {
    const row = this.one("SELECT * FROM sessions WHERE id=? AND expires_at>?", sessionId, now());
    if (!row || !row.active_case_id) return null;
    try {
      return this.getCase(String(row.user_id), String(row.active_case_id));
    } catch {
      return null;
    }
  }
  createSkill(
    actorId: string,
    sourceCaseId: string,
    input: { name: string; content: string; serviceSpaceId?: string | null },
  ): SharedSkill {
    const source = this.getCase(actorId, sourceCaseId);
    if (input.serviceSpaceId && input.serviceSpaceId !== source.serviceSpaceId) fail("not_found");
    const skill = {
      id: id(),
      tenantId: source.tenantId,
      serviceSpaceId: input.serviceSpaceId ?? null,
      sourceCaseId,
      name: input.name,
      content: input.content,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      createdAt: now(),
    };
    this.run(
      "INSERT INTO shared_skills VALUES(?,?,?,?,?,?,?,?)",
      skill.id,
      skill.tenantId,
      skill.serviceSpaceId,
      sourceCaseId,
      skill.name,
      skill.content,
      skill.contentHash,
      skill.createdAt,
    );
    return skill;
  }
  listSkillsForCase(actorId: string, caseId: string): SharedSkill[] {
    const c = this.getCase(actorId, caseId);
    return this.all(
      "SELECT * FROM shared_skills WHERE tenant_id=? AND (service_space_id IS NULL OR service_space_id=?)",
      c.tenantId,
      c.serviceSpaceId,
    ).map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      serviceSpaceId: r.service_space_id == null ? null : String(r.service_space_id),
      sourceCaseId: String(r.source_case_id),
      name: String(r.name),
      content: String(r.content),
      contentHash: String(r.content_hash),
      createdAt: String(r.created_at),
    }));
  }
  createMcpBinding(
    actorId: string,
    tenantId: string,
    input: {
      name: string;
      endpoint: string;
      secretRef?: string | null;
      serviceSpaceId?: string | null;
    },
  ): McpBinding {
    this.membership(actorId, tenantId, "admin");
    if (input.serviceSpaceId) {
      const space = this.space(actorId, input.serviceSpaceId);
      if (space.tenantId !== tenantId) fail("not_found");
    }
    const binding = {
      id: id(),
      tenantId,
      serviceSpaceId: input.serviceSpaceId ?? null,
      name: input.name,
      endpoint: input.endpoint,
      secretRef: input.secretRef ?? null,
      createdAt: now(),
    };
    this.run(
      "INSERT INTO mcp_bindings VALUES(?,?,?,?,?,?,?)",
      binding.id,
      tenantId,
      binding.serviceSpaceId,
      binding.name,
      binding.endpoint,
      binding.secretRef,
      binding.createdAt,
    );
    return binding;
  }
  listMcpBindings(actorId: string, tenantId: string, serviceSpaceId?: string): McpBinding[] {
    this.membership(actorId, tenantId, "admin");
    if (serviceSpaceId && this.space(actorId, serviceSpaceId).tenantId !== tenantId)
      fail("not_found");
    return this.all(
      serviceSpaceId
        ? "SELECT * FROM mcp_bindings WHERE tenant_id=? AND service_space_id=?"
        : "SELECT * FROM mcp_bindings WHERE tenant_id=?",
      ...(serviceSpaceId ? [tenantId, serviceSpaceId] : [tenantId]),
    ).map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      serviceSpaceId: r.service_space_id == null ? null : String(r.service_space_id),
      name: String(r.name),
      endpoint: String(r.endpoint),
      secretRef: r.secret_ref == null ? null : String(r.secret_ref),
      createdAt: String(r.created_at),
    }));
  }
  listMcpBindingsForCase(actorId: string, caseId: string): McpBinding[] {
    const c = this.getCase(actorId, caseId);
    return this.all(
      "SELECT * FROM mcp_bindings WHERE tenant_id=? AND (service_space_id IS NULL OR service_space_id=?)",
      c.tenantId,
      c.serviceSpaceId,
    ).map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      serviceSpaceId: r.service_space_id == null ? null : String(r.service_space_id),
      name: String(r.name),
      endpoint: String(r.endpoint),
      secretRef: r.secret_ref == null ? null : String(r.secret_ref),
      createdAt: String(r.created_at),
    }));
  }

  upsertModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
    apiKey: string,
  ): ModelCredentialStatus {
    return this.modelCredentials.upsertModelCredential(actorId, tenantId, providerFamily, apiKey);
  }

  rotateModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
    apiKey: string,
  ): ModelCredentialStatus {
    return this.modelCredentials.rotateModelCredential(actorId, tenantId, providerFamily, apiKey);
  }

  revokeModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
  ): ModelCredentialStatus {
    return this.modelCredentials.revokeModelCredential(actorId, tenantId, providerFamily);
  }

  deleteModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
  ): ModelCredentialStatus {
    return this.modelCredentials.deleteModelCredential(actorId, tenantId, providerFamily);
  }

  listModelCredentialStatuses(actorId: string, tenantId: string): ModelCredentialStatus[] {
    return this.modelCredentials.listModelCredentialStatuses(actorId, tenantId);
  }

  getModelCredentialForGateway(
    tenantId: string,
    providerFamily: string,
  ): ReturnType<ModelCredentialStore["getModelCredentialForGateway"]> {
    return this.modelCredentials.getModelCredentialForGateway(tenantId, providerFamily);
  }
}
