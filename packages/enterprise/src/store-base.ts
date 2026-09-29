import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type Membership,
  type Role,
  type ServiceObject,
  type ServiceSpace,
  type Tenant,
  type User,
} from "./types.js";

export type Row = Record<string, unknown>;
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const json = (value: unknown) => JSON.stringify(value);
export const parse = (value: unknown) => JSON.parse(String(value)) as Record<string, unknown>;
export const fail = (code: ConstructorParameters<typeof EnterpriseError>[0]): never => {
  throw new EnterpriseError(code);
};

export class EnterpriseStoreBase {
  protected constructor(
    protected readonly db: DatabaseSync,
    protected readonly workspaceRoot: string,
  ) {}
  close(): void {
    this.db.close();
  }
  protected one(sql: string, ...values: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...values) as Row | undefined;
  }
  protected all(sql: string, ...values: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...values) as Row[];
  }
  protected run(sql: string, ...values: (string | number | null)[]): void {
    this.db.prepare(sql).run(...values);
  }
  protected transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  protected migrate(): void {
    const version = Number(this.one("PRAGMA user_version")?.user_version ?? 0);
    if (version > 1) fail("conflict");
    if (version === 1) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE memberships (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('admin','member')), PRIMARY KEY (tenant_id,user_id));
        CREATE TABLE service_spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,name));
        CREATE TABLE service_objects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT NOT NULL REFERENCES service_spaces(id), name TEXT NOT NULL, type TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE cases (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT NOT NULL REFERENCES service_spaces(id), service_object_id TEXT NOT NULL REFERENCES service_objects(id), title TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved','closed')), workspace_path TEXT NOT NULL UNIQUE, object_snapshot TEXT NOT NULL, context_snapshot TEXT NOT NULL, native_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, active_case_id TEXT REFERENCES cases(id), expires_at TEXT NOT NULL);
        CREATE TABLE shared_skills (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT REFERENCES service_spaces(id), source_case_id TEXT NOT NULL REFERENCES cases(id), name TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE mcp_bindings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT REFERENCES service_spaces(id), name TEXT NOT NULL, endpoint TEXT NOT NULL, secret_ref TEXT, created_at TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    });
  }
  protected membership(userId: string, tenantId: string, role?: Role): Membership {
    const row = this.one(
      "SELECT tenant_id,user_id,role FROM memberships WHERE tenant_id=? AND user_id=?",
      tenantId,
      userId,
    );
    if (!row) throw new EnterpriseError("not_found");
    if (role && row.role !== role) fail("forbidden");
    return { tenantId, userId, role: row.role as Role };
  }
  getMembership(userId: string, tenantId: string): Membership {
    return this.membership(userId, tenantId);
  }
  protected tenant(tenantId: string): Tenant {
    const row = this.one("SELECT * FROM tenants WHERE id=?", tenantId);
    if (!row) throw new EnterpriseError("not_found");
    return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at) };
  }
  createTenant(name: string): Tenant {
    if (!name.trim()) fail("validation");
    const tenant = { id: id(), name: name.trim(), createdAt: now() };
    this.run("INSERT INTO tenants VALUES(?,?,?)", tenant.id, tenant.name, tenant.createdAt);
    return tenant;
  }
  createUser(email: string, passwordHash: string, displayName?: string): User {
    if (!email.includes("@") || !passwordHash) fail("validation");
    const normalizedEmail = email.trim().toLowerCase();
    const user = {
      id: id(),
      email: normalizedEmail,
      displayName: displayName?.trim() || normalizedEmail.split("@")[0] || normalizedEmail,
      createdAt: now(),
    };
    this.run(
      "INSERT INTO users VALUES(?,?,?,?,?)",
      user.id,
      user.email,
      user.displayName,
      passwordHash,
      user.createdAt,
    );
    return user;
  }
  bootstrapAdmin(
    tenantName: string,
    email: string,
    passwordHash: string,
    displayName?: string,
  ): { tenant: Tenant; user: User } {
    return this.transaction(() => {
      const tenant = this.createTenant(tenantName);
      const user = this.createUser(email, passwordHash, displayName);
      this.run("INSERT INTO memberships VALUES(?,?,?)", tenant.id, user.id, "admin");
      return { tenant, user };
    });
  }
  getUser(userId: string): User | null {
    const row = this.one("SELECT id,email,display_name,created_at FROM users WHERE id=?", userId);
    return row
      ? {
          id: String(row.id),
          email: String(row.email),
          displayName: String(row.display_name),
          createdAt: String(row.created_at),
        }
      : null;
  }
  listTenantsForUser(userId: string): Tenant[] {
    return this.all(
      "SELECT t.* FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=? ORDER BY t.created_at",
      userId,
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
    }));
  }
  findCredential(email: string): { user: User; passwordHash: string } | null {
    const row = this.one("SELECT * FROM users WHERE email=? COLLATE NOCASE", email.trim());
    if (!row) return null;
    return {
      user: {
        id: String(row.id),
        email: String(row.email),
        displayName: String(row.display_name),
        createdAt: String(row.created_at),
      },
      passwordHash: String(row.password_hash),
    };
  }
  addMembership(actorId: string, tenantId: string, userId: string, role: Role): Membership {
    this.membership(actorId, tenantId, "admin");
    this.tenant(tenantId);
    if (!this.one("SELECT id FROM users WHERE id=?", userId)) fail("not_found");
    this.run("INSERT INTO memberships VALUES(?,?,?)", tenantId, userId, role);
    return { tenantId, userId, role };
  }
  provisionUser(
    actorId: string,
    tenantId: string,
    input: { email: string; passwordHash: string; displayName?: string; role: Role },
  ): { user: User; membership: Membership } {
    return this.transaction(() => {
      this.membership(actorId, tenantId, "admin");
      if (this.findCredential(input.email)) fail("conflict");
      const user = this.createUser(input.email, input.passwordHash, input.displayName);
      const membership = this.addMembership(actorId, tenantId, user.id, input.role);
      return { user, membership };
    });
  }
  removeMembership(actorId: string, tenantId: string, userId: string): void {
    this.transaction(() => {
      this.membership(actorId, tenantId, "admin");
      this.run(
        "UPDATE sessions SET active_case_id=NULL WHERE user_id=? AND active_case_id IN (SELECT id FROM cases WHERE tenant_id=?)",
        userId,
        tenantId,
      );
      this.run("DELETE FROM memberships WHERE tenant_id=? AND user_id=?", tenantId, userId);
    });
  }
  createServiceSpace(actorId: string, tenantId: string, input: { name: string }): ServiceSpace {
    this.membership(actorId, tenantId, "admin");
    if (!input.name.trim()) fail("validation");
    const space = { id: id(), tenantId, name: input.name.trim(), createdAt: now() };
    this.run(
      "INSERT INTO service_spaces VALUES(?,?,?,?)",
      space.id,
      tenantId,
      space.name,
      space.createdAt,
    );
    return space;
  }
  updateServiceSpace(actorId: string, spaceId: string, input: { name: string }): ServiceSpace {
    return this.transaction(() => {
      const current = this.space(actorId, spaceId);
      this.membership(actorId, current.tenantId, "admin");
      const name = input.name.trim();
      if (!name) fail("validation");
      this.run("UPDATE service_spaces SET name=? WHERE id=?", name, spaceId);
      return { ...current, name };
    });
  }
  listServiceSpaces(actorId: string, tenantId: string): ServiceSpace[] {
    this.membership(actorId, tenantId);
    return this.all(
      "SELECT * FROM service_spaces WHERE tenant_id=? ORDER BY created_at",
      tenantId,
    ).map((row) => ({
      id: String(row.id),
      tenantId,
      name: String(row.name),
      createdAt: String(row.created_at),
    }));
  }
  protected space(actorId: string, spaceId: string): ServiceSpace {
    const row = this.one("SELECT * FROM service_spaces WHERE id=?", spaceId);
    if (!row) throw new EnterpriseError("not_found");
    this.membership(actorId, String(row.tenant_id));
    return {
      id: spaceId,
      tenantId: String(row.tenant_id),
      name: String(row.name),
      createdAt: String(row.created_at),
    };
  }
  protected object(row: Row): ServiceObject {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      serviceSpaceId: String(row.service_space_id),
      name: String(row.name),
      type: String(row.type),
      metadata: parse(row.metadata),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  createServiceObject(
    actorId: string,
    spaceId: string,
    input: { name: string; type: string; metadata?: Record<string, unknown> },
  ): ServiceObject {
    const space = this.space(actorId, spaceId);
    if (!input.name.trim() || !input.type.trim()) fail("validation");
    const object = {
      id: id(),
      tenantId: space.tenantId,
      serviceSpaceId: spaceId,
      name: input.name.trim(),
      type: input.type.trim(),
      metadata: input.metadata ?? {},
      createdAt: now(),
      updatedAt: now(),
    };
    this.run(
      "INSERT INTO service_objects VALUES(?,?,?,?,?,?,?,?)",
      object.id,
      object.tenantId,
      spaceId,
      object.name,
      object.type,
      json(object.metadata),
      object.createdAt,
      object.updatedAt,
    );
    return object;
  }
  listServiceObjects(actorId: string, spaceId: string): ServiceObject[] {
    this.space(actorId, spaceId);
    return this.all(
      "SELECT * FROM service_objects WHERE service_space_id=? ORDER BY created_at",
      spaceId,
    ).map((row) => this.object(row));
  }
  getServiceObject(actorId: string, objectId: string): ServiceObject {
    const row = this.one("SELECT * FROM service_objects WHERE id=?", objectId);
    if (!row) throw new EnterpriseError("not_found");
    this.membership(actorId, String(row.tenant_id));
    return this.object(row);
  }
  updateServiceObject(
    actorId: string,
    objectId: string,
    input: { name: string; type: string; metadata?: Record<string, unknown> },
  ): ServiceObject {
    this.getServiceObject(actorId, objectId);
    if (!input.name.trim() || !input.type.trim()) fail("validation");
    this.run(
      "UPDATE service_objects SET name=?,type=?,metadata=?,updated_at=? WHERE id=?",
      input.name.trim(),
      input.type.trim(),
      json(input.metadata ?? {}),
      now(),
      objectId,
    );
    return this.getServiceObject(actorId, objectId);
  }
}
