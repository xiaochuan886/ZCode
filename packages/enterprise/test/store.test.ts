import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnterpriseStore } from "../src/store.js";

test("tenant boundaries, memberships and admin-only updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-"));
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const a = store.bootstrapAdmin("Alpha", "a@example.test", "hash-a");
    const b = store.bootstrapAdmin("Beta", "b@example.test", "hash-b");
    const provisioned = store.provisionUser(a.user.id, a.tenant.id, {
      email: "member@example.test",
      passwordHash: "hash-member",
      role: "member",
    });
    assert.equal(provisioned.membership.tenantId, a.tenant.id);
    assert.throws(
      () =>
        store.provisionUser(a.user.id, a.tenant.id, {
          email: "member@example.test",
          passwordHash: "another-hash",
          role: "member",
        }),
      /conflict/,
    );
    assert.throws(
      () =>
        store.provisionUser(b.user.id, a.tenant.id, {
          email: "leak@example.test",
          passwordHash: "hash",
          role: "member",
        }),
      /not_found/,
    );
    assert.equal(store.findCredential("leak@example.test"), null);
    const customer = await store.createCustomer(a.user.id, a.tenant.id, {
      name: "Acme",
      type: "account",
    });
    const renamed = await store.createCustomer(a.user.id, a.tenant.id, {
      name: "Renamed target",
    });
    assert.throws(() => store.updateCustomer(b.user.id, renamed.id, { name: "Foreign" }), /not_found/);
    assert.throws(
      () => store.updateCustomer(provisioned.user.id, renamed.id, { name: "Member" }),
      /forbidden/,
    );
    assert.equal(
      (await store.updateCustomer(a.user.id, renamed.id, { name: "Customer Support" })).name,
      "Customer Support",
    );
    assert.throws(() => store.getCustomer(b.user.id, customer.id), /not_found/);
    assert.throws(
      () => store.listCustomers(b.user.id, a.tenant.id),
      /not_found/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("v4 migration drops the legacy per-case schema and keeps customer rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-migration-"));
  const dbPath = join(dir, "enterprise.db");
  const workspaces = join(dir, "workspaces");
  const store = await EnterpriseStore.open(dbPath, workspaces);
  const { tenant, user } = store.bootstrapAdmin("Live", "live@example.test", "hash");
  const customer = await store.createCustomer(user.id, tenant.id, {
    name: "Acme",
    type: "customer",
  });
  const session = store.issueSession(user.id, "live-token", "live-csrf");
  store.activateCustomer(session.id, customer.id);
  store.close();

  // 把库回退成 v3 形态：补回旧架构列与旧表，模拟尚未删除 legacy 的存量库。
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE service_spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,name));
    CREATE TABLE service_objects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT NOT NULL REFERENCES service_spaces(id), name TEXT NOT NULL, type TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE cases (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT NOT NULL REFERENCES service_spaces(id), service_object_id TEXT NOT NULL REFERENCES service_objects(id), title TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, workspace_path TEXT NOT NULL UNIQUE, object_snapshot TEXT NOT NULL, context_snapshot TEXT NOT NULL, native_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE shared_skills (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT REFERENCES service_spaces(id), source_case_id TEXT NOT NULL REFERENCES cases(id), name TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE mcp_bindings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), service_space_id TEXT REFERENCES service_spaces(id), name TEXT NOT NULL, endpoint TEXT NOT NULL, secret_ref TEXT, created_at TEXT NOT NULL);
    CREATE TABLE customers_v3 (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      legacy_service_space_id TEXT REFERENCES service_spaces(id),
      legacy_service_object_id TEXT UNIQUE REFERENCES service_objects(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      metadata TEXT NOT NULL,
      workspace_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );
    INSERT INTO customers_v3 (id,tenant_id,legacy_service_space_id,legacy_service_object_id,name,type,metadata,workspace_path,created_at,updated_at,last_used_at)
      SELECT id,tenant_id,NULL,NULL,name,type,metadata,workspace_path,created_at,updated_at,last_used_at FROM customers;
    DROP TABLE customers;
    ALTER TABLE customers_v3 RENAME TO customers;
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 3;
  `);
  raw.close();

  const migrated = await EnterpriseStore.open(dbPath, workspaces);
  try {
    const version = Number(
      (
        migrated as unknown as {
          db: { prepare(sql: string): { get(): { user_version: number } } };
        }
      ).db.prepare("PRAGMA user_version").get().user_version,
    );
    assert.equal(version, 4);
    const customers = migrated.listCustomers(user.id, tenant.id);
    assert.equal(customers.length, 1);
    assert.equal(customers[0]!.id, customer.id);
    assert.equal(migrated.getActiveCustomer(session.id)?.id, customer.id);
    assert.equal(migrated.resolveSession("live-token")?.activeCustomerId, customer.id);
    const tables = new Set(
      (
        migrated as unknown as {
          db: { prepare(sql: string): { all(): Array<{ name: string }> } };
        }
      ).db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
    );
    for (const dropped of ["cases", "service_objects", "service_spaces", "shared_skills", "mcp_bindings"]) {
      assert.equal(tables.has(dropped), false, `${dropped} should be dropped`);
    }
  } finally {
    migrated.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("customer activation is tenant isolated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-customer-"));
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const first = store.bootstrapAdmin("First", "first@example.test", "hash");
    const second = store.bootstrapAdmin("Second", "second@example.test", "hash");
    const firstCustomer = await store.createCustomer(first.user.id, first.tenant.id, {
      name: "Acme",
      type: "account",
    });
    const secondCustomer = await store.createCustomer(second.user.id, second.tenant.id, {
      name: "Acme",
      type: "account",
    });
    const untypedCustomer = await store.createCustomer(first.user.id, first.tenant.id, {
      name: "Untyped customer",
    });
    assert.equal(untypedCustomer.type, "");
    assert.equal(
      (await store.updateCustomer(first.user.id, untypedCustomer.id, { name: "Untyped customer" }))
        .type,
      "",
    );
    assert.equal(store.listCustomers(first.user.id, first.tenant.id)[0]?.id, firstCustomer.id);
    assert.equal(store.listCustomers(second.user.id, second.tenant.id)[0]?.id, secondCustomer.id);
    assert.throws(() => store.getCustomer(first.user.id, secondCustomer.id), /not_found/);
    const session = store.issueSession(first.user.id, "customer-token", "customer-csrf");
    store.activateCustomer(session.id, firstCustomer.id);
    assert.equal(store.getActiveCustomer(session.id)?.id, firstCustomer.id);
    assert.deepEqual(store.getActiveRuntimeTarget(session.id), {
      id: firstCustomer.id,
      tenantId: first.tenant.id,
      customerId: firstCustomer.id,
      workspacePath: firstCustomer.workspacePath,
      runtimeId: firstCustomer.id,
      kind: "customer",
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
