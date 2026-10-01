import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EnterpriseError, type Membership, type Role, type Tenant, type User } from "./types.js";
import { migrateStoreSchema } from "./store-schema.js";

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
    migrateStoreSchema(this.db);
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
        `UPDATE sessions
            SET active_customer_id=NULL
          WHERE user_id=? AND active_customer_id IN (SELECT id FROM customers WHERE tenant_id=?)`,
        userId,
        tenantId,
      );
      this.run("DELETE FROM memberships WHERE tenant_id=? AND user_id=?", tenantId, userId);
    });
  }
}
