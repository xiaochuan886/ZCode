import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelCredentialCipher } from "../src/model-credential-format.js";
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
    assert.throws(
      () => store.updateCustomer(b.user.id, renamed.id, { name: "Foreign" }),
      /not_found/,
    );
    assert.throws(
      () => store.updateCustomer(provisioned.user.id, renamed.id, { name: "Member" }),
      /forbidden/,
    );
    assert.equal(
      (await store.updateCustomer(a.user.id, renamed.id, { name: "Customer Support" })).name,
      "Customer Support",
    );
    assert.throws(() => store.getCustomer(b.user.id, customer.id), /not_found/);
    assert.throws(() => store.listCustomers(b.user.id, a.tenant.id), /not_found/);
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
      ).db
        .prepare("PRAGMA user_version")
        .get().user_version,
    );
    assert.equal(version, 7);
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
      ).db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    for (const dropped of [
      "cases",
      "service_objects",
      "service_spaces",
      "shared_skills",
      "mcp_bindings",
    ]) {
      assert.equal(tables.has(dropped), false, `${dropped} should be dropped`);
    }
    // v5 非破坏性追加:租户共享 Skill 表在迁移链末尾就位。
    assert.equal(tables.has("tenant_skills"), true, "tenant_skills should exist after v5");
    // v6:绑定令牌列就位(稳定中继令牌,专家 runtime 共享)。
    const bindingColumns = (
      migrated as unknown as {
        db: { prepare(sql: string): { all(): Array<{ name: string }> } };
      }
    ).db
      .prepare("PRAGMA table_info(customer_mcp_bindings)")
      .all();
    assert.equal(
      bindingColumns.some((column) => column.name === "token"),
      true,
    );
    // v7:供应商目录与系统连接器表就位。
    assert.equal(tables.has("tenant_model_providers"), true, "v7 provider table should exist");
    assert.equal(tables.has("tenant_mcp_connectors"), true, "v7 connector table should exist");
  } finally {
    migrated.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tenant shared skills are admin-gated and customer skills stay scoped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-tenant-skills-"));
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const a = store.bootstrapAdmin("Alpha", "a@example.test", "hash-a");
    store.provisionUser(a.user.id, a.tenant.id, {
      email: "member@example.test",
      passwordHash: "hash-member",
      role: "member",
    });
    const member = store.findCredential("member@example.test")!;
    const customer = await store.createCustomer(a.user.id, a.tenant.id, {
      name: "Acme",
      type: "account",
    });

    const shared = store.createTenantSkill(a.user.id, a.tenant.id, {
      name: "Playbook",
      content: "---\nname: playbook\ndescription: shared\n---\n# Playbook\n",
    });
    assert.equal(shared.name, "Playbook");
    assert.equal(store.listTenantSkills(a.user.id, a.tenant.id).length, 1);
    // 成员可读(分发可见性),但写入与删除是管理员操作。
    assert.equal(store.listTenantSkills(member.user.id, a.tenant.id).length, 1);
    assert.throws(
      () => store.createTenantSkill(member.user.id, a.tenant.id, { name: "X", content: "y" }),
      /forbidden/,
    );
    assert.throws(
      () => store.deleteTenantSkill(member.user.id, a.tenant.id, shared.id),
      /forbidden/,
    );

    const customerSkill = store.createCustomerSkill(a.user.id, customer.id, {
      name: "Only this customer",
      content: "# Local\n",
    });
    const distribution = store.tenantSkillsForDistribution(a.tenant.id);
    assert.deepEqual(
      distribution.map((skill) => skill.id),
      [shared.id],
    );
    assert.equal(distribution[0]!.contentHash, shared.contentHash);
    // 客户级 Skill 不进入租户分发集合。
    assert.equal(
      distribution.some((skill) => skill.id === customerSkill.id),
      false,
    );

    store.deleteTenantSkill(a.user.id, a.tenant.id, shared.id);
    assert.equal(store.tenantSkillsForDistribution(a.tenant.id).length, 0);
    assert.throws(() => store.deleteTenantSkill(a.user.id, a.tenant.id, shared.id), /not_found/);
  } finally {
    store.close();
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
    // 专家模型:目标身份 = (用户, 租户),客户只是主工作区。
    const target = store.getActiveRuntimeTarget(session.id)!;
    assert.equal(target.tenantId, first.tenant.id);
    assert.equal(target.userId, first.user.id);
    assert.equal(target.workspacePath, firstCustomer.workspacePath);
    assert.equal(target.kind, "expert");
    assert.equal(target.runtimeId, target.id);
    assert.match(target.runtimeId, new RegExp(`^e-${first.user.id}-${first.tenant.id}$`));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const catalogEncryptionKey = Buffer.alloc(32, 0x42);

test("v7 migration creates catalog tables on a fresh database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-v7-fresh-"));
  const dbPath = join(dir, "enterprise.db");
  const store = await EnterpriseStore.open(dbPath, join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: catalogEncryptionKey,
  });
  try {
    const raw = new DatabaseSync(dbPath);
    const version = (raw.prepare("PRAGMA user_version").get() as Record<string, unknown>)
      .user_version;
    const tables = new Set(
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    raw.close();
    assert.equal(version, 7);
    assert.equal(tables.has("tenant_model_providers"), true);
    assert.equal(tables.has("tenant_mcp_connectors"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("v7 migration seeds the provider catalog from the legacy single credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-v7-seed-"));
  const dbPath = join(dir, "enterprise.db");
  const store = await EnterpriseStore.open(dbPath, join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: catalogEncryptionKey,
  });
  const seeded = store.bootstrapAdmin("Legacy", "legacy-seed@example.test", "hash");
  const revokedTenant = store.bootstrapAdmin("Revoked", "revoked-seed@example.test", "hash");
  const secret = "legacy-live-secret-1234";
  store.close();

  // 回退成 v6 形态:live legacy 凭据 + 已撤销行 + 目录表缺失。
  const raw = new DatabaseSync(dbPath);
  const envelope = new ModelCredentialCipher(catalogEncryptionKey).encrypt(
    secret,
    seeded.tenant.id,
    "custom",
  );
  const timestamp = new Date().toISOString();
  raw
    .prepare(
      `INSERT INTO model_credentials
        (tenant_id,provider_family,provider_name,api_type,base_url,model_id,key_version,ciphertext,nonce,auth_tag,last_four,created_at,updated_at,revoked_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      seeded.tenant.id,
      "custom",
      "Legacy provider",
      "openai-chat-completions",
      "https://api.example.com/v1",
      "legacy-model",
      envelope.keyVersion,
      envelope.ciphertext,
      envelope.nonce,
      envelope.authTag,
      "1234",
      timestamp,
      timestamp,
      null,
    );
  raw
    .prepare(
      `INSERT INTO model_credentials
        (tenant_id,provider_family,provider_name,api_type,base_url,model_id,key_version,ciphertext,nonce,auth_tag,last_four,created_at,updated_at,revoked_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      revokedTenant.tenant.id,
      "custom",
      "Revoked provider",
      "anthropic-messages",
      "https://revoked.example.com",
      "revoked-model",
      envelope.keyVersion,
      envelope.ciphertext,
      envelope.nonce,
      envelope.authTag,
      "1234",
      timestamp,
      timestamp,
      timestamp,
    );
  raw.exec(`
    DROP TABLE tenant_model_providers;
    DROP TABLE tenant_mcp_connectors;
    PRAGMA user_version = 6;
  `);
  raw.close();

  const migrated = await EnterpriseStore.open(dbPath, join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: catalogEncryptionKey,
  });
  try {
    const providers = migrated.listTenantModelProviders(seeded.user.id, seeded.tenant.id);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.providerKey, "custom");
    assert.equal(providers[0]!.displayName, "Legacy provider");
    assert.equal(providers[0]!.isDefault, true);
    assert.equal(providers[0]!.enabled, true);
    assert.equal(providers[0]!.apiKeyLast4, "1234");
    assert.deepEqual(providers[0]!.models, ["legacy-model"]);
    assert.equal(providers[0]!.defaultModel, "legacy-model");
    assert.equal(JSON.stringify(providers[0]).includes(secret), false);
    const distribution = migrated.tenantModelProvidersForDistribution(seeded.tenant.id);
    assert.equal(distribution.length, 1);
    assert.equal(distribution[0]!.apiKey, secret);
    // 撤销的 legacy 行不 seed。
    assert.deepEqual(
      migrated.listTenantModelProviders(revokedTenant.user.id, revokedTenant.tenant.id),
      [],
    );
  } finally {
    migrated.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tenant model provider catalog is admin-gated, encrypted at rest and keeps one default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-providers-"));
  const dbPath = join(dir, "enterprise.db");
  const store = await EnterpriseStore.open(dbPath, join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: catalogEncryptionKey,
  });
  try {
    const { tenant, user } = store.bootstrapAdmin("Catalog", "catalog@example.test", "hash");
    const member = store.provisionUser(user.id, tenant.id, {
      email: "catalog-member@example.test",
      passwordHash: "hash-member",
      role: "member",
    });
    const foreign = store.bootstrapAdmin("Foreign", "foreign-catalog@example.test", "hash");

    const first = store.createTenantModelProvider(user.id, tenant.id, {
      providerKey: "acme",
      displayName: "Acme AI",
      apiType: "openai-chat-completions",
      baseUrl: "https://acme.example.com/v1",
      apiKey: "acme-secret-1111",
      models: ["acme-a", "acme-b"],
    });
    // 首个供应商自动成为租户默认。
    assert.equal(first.isDefault, true);
    assert.equal(first.apiKeyLast4, "1111");
    assert.equal(first.defaultModel, "acme-a");
    assert.equal(JSON.stringify(first).includes("acme-secret-1111"), false);

    assert.throws(
      () =>
        store.createTenantModelProvider(member.user.id, tenant.id, {
          providerKey: "member",
          displayName: "Denied",
          apiType: "anthropic-messages",
          baseUrl: "https://member.example.com",
          apiKey: "member-key",
        }),
      /forbidden/,
    );
    assert.throws(
      () =>
        store.createTenantModelProvider(foreign.user.id, tenant.id, {
          providerKey: "foreign",
          displayName: "Denied",
          apiType: "anthropic-messages",
          baseUrl: "https://foreign.example.com",
          apiKey: "foreign-key",
        }),
      /not_found/,
    );
    assert.throws(
      () =>
        store.createTenantModelProvider(user.id, tenant.id, {
          providerKey: "Bad Key",
          displayName: "Bad",
          apiType: "anthropic-messages",
          baseUrl: "https://acme.example.com",
          apiKey: "key",
        }),
      /validation/,
    );
    assert.throws(
      () =>
        store.createTenantModelProvider(user.id, tenant.id, {
          providerKey: "insecure",
          displayName: "Insecure",
          apiType: "anthropic-messages",
          baseUrl: "http://127.0.0.1:8080",
          apiKey: "key",
        }),
      /validation/,
    );
    assert.throws(
      () =>
        store.createTenantModelProvider(user.id, tenant.id, {
          providerKey: "acme",
          displayName: "Duplicate",
          apiType: "anthropic-messages",
          baseUrl: "https://acme.example.com",
          apiKey: "key",
        }),
      /conflict/,
    );
    assert.throws(
      () =>
        store.createTenantModelProvider(user.id, tenant.id, {
          providerKey: "badmodel",
          displayName: "Bad model",
          apiType: "anthropic-messages",
          baseUrl: "https://acme.example.com",
          apiKey: "key",
          models: ["a", "b"],
          defaultModel: "c",
        }),
      /validation/,
    );
    // 成员可读目录(可见性),但不能改。
    assert.equal(store.listTenantModelProviders(member.user.id, tenant.id).length, 1);

    const second = store.createTenantModelProvider(user.id, tenant.id, {
      providerKey: "beta",
      displayName: "Beta AI",
      apiType: "anthropic-messages",
      baseUrl: "https://beta.example.com",
      apiKey: "beta-key-2222",
      models: ["beta-a"],
      isDefault: true,
    });
    // 切默认清兄弟:同一时刻只有一个默认。
    assert.deepEqual(
      store
        .listTenantModelProviders(user.id, tenant.id)
        .map((provider) => [provider.providerKey, provider.isDefault]),
      [
        ["acme", false],
        ["beta", true],
      ],
    );
    store.updateTenantModelProvider(user.id, first.id, { isDefault: true });
    assert.deepEqual(
      store
        .listTenantModelProviders(user.id, tenant.id)
        .map((provider) => [provider.providerKey, provider.isDefault]),
      [
        ["acme", true],
        ["beta", false],
      ],
    );
    assert.throws(
      () => store.updateTenantModelProvider(member.user.id, first.id, { displayName: "X" }),
      /forbidden/,
    );
    assert.throws(
      () => store.updateTenantModelProvider(foreign.user.id, first.id, { displayName: "X" }),
      /not_found/,
    );
    // key 轮换与模型列表更新;分发集合拿到的是解密后的真实 key。
    const rotated = store.updateTenantModelProvider(user.id, second.id, {
      apiKey: "rotated-key-3333",
      models: ["beta-a", "beta-b"],
      defaultModel: "beta-b",
    });
    assert.equal(rotated.apiKeyLast4, "3333");
    assert.deepEqual(rotated.models, ["beta-a", "beta-b"]);
    assert.equal(rotated.defaultModel, "beta-b");

    // 停用的供应商不进分发集合。
    store.updateTenantModelProvider(user.id, second.id, { enabled: false });
    assert.deepEqual(
      store.tenantModelProvidersForDistribution(tenant.id).map((provider) => provider.providerKey),
      ["acme"],
    );
    assert.equal(
      store.tenantModelProvidersForDistribution(tenant.id)[0]!.apiKey,
      "acme-secret-1111",
    );

    // 删除默认供应商后最早的启用行自动补位。
    store.updateTenantModelProvider(user.id, second.id, { enabled: true });
    store.deleteTenantModelProvider(user.id, first.id);
    const afterDelete = store.listTenantModelProviders(user.id, tenant.id);
    assert.deepEqual(
      afterDelete.map((provider) => [provider.providerKey, provider.isDefault]),
      [["beta", true]],
    );
    assert.throws(() => store.deleteTenantModelProvider(member.user.id, second.id), /forbidden/);
    store.close();

    // 密文落盘校验:明文 key 不在库中;错误密钥读取 fail closed。
    const raw = new DatabaseSync(dbPath);
    const rows = raw
      .prepare("SELECT api_key_encrypted FROM tenant_model_providers")
      .all() as Array<{ api_key_encrypted: string }>;
    raw.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.api_key_encrypted.includes("rotated-key-3333"), false);
    assert.equal(rows[0]!.api_key_encrypted.includes("acme-secret-1111"), false);

    const wrong = await EnterpriseStore.open(dbPath, join(dir, "workspaces"), {
      modelCredentialsEncryptionKey: Buffer.alloc(32, 0x24),
    });
    try {
      assert.throws(() => wrong.tenantModelProvidersForDistribution(tenant.id), /conflict/);
    } finally {
      wrong.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // The test closes the store before inspecting SQLite directly.
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("tenant connectors hold stable relay tokens and stay admin-gated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-connectors-"));
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const { tenant, user } = store.bootstrapAdmin("Connector", "connector@example.test", "hash");
    const member = store.provisionUser(user.id, tenant.id, {
      email: "connector-member@example.test",
      passwordHash: "hash-member",
      role: "member",
    });
    const secretEnv = `ZCODE_ENTERPRISE_MCP_SECRET_${tenant.id.replaceAll("-", "").toUpperCase()}_CATALOG`;
    const priorSecret = process.env[secretEnv];
    process.env[secretEnv] = "connector-secret-value";
    try {
      const connector = store.createTenantMcpConnector(user.id, tenant.id, {
        connectorKey: "search",
        displayName: "Search connector",
        url: "https://mcp.example.test/stream",
        secretEnv,
      });
      assert.equal(connector.endpointHost, "mcp.example.test");
      assert.equal(connector.headerName, "Authorization");
      assert.equal(connector.secretConfigured, true);
      assert.equal("token" in connector, false);
      assert.equal(JSON.stringify(connector).includes("connector-secret-value"), false);

      const token = store.ensureMcpConnectorToken(connector.id);
      assert.ok(token.length >= 32, "connector token must be non-empty");
      // 令牌稳定:重复 ensure 返回同一值,跨网关重启一致。
      assert.equal(store.ensureMcpConnectorToken(connector.id), token);
      const relayed = store.findMcpConnectorForRelay(connector.id, token);
      assert.equal(relayed!.url, "https://mcp.example.test/stream");
      assert.equal(relayed!.secretEnv, secretEnv);
      assert.equal(store.findMcpConnectorForRelay(connector.id, "x".repeat(token.length)), null);
      assert.equal(store.findMcpConnectorForRelay(connector.id, ""), null);

      assert.throws(
        () =>
          store.createTenantMcpConnector(member.user.id, tenant.id, {
            connectorKey: "member",
            displayName: "Denied",
            url: "https://mcp.example.test/denied",
            secretEnv,
          }),
        /forbidden/,
      );
      assert.throws(
        () => store.updateTenantMcpConnector(member.user.id, connector.id, { displayName: "X" }),
        /forbidden/,
      );
      const patched = store.updateTenantMcpConnector(user.id, connector.id, {
        displayName: "Renamed",
        headerName: "x-api-key",
      });
      assert.equal(patched.displayName, "Renamed");
      assert.equal(patched.headerName, "x-api-key");
      assert.equal(store.findMcpConnectorForRelay(connector.id, token)!.headerName, "x-api-key");

      // 停用后:中继拒绝,分发集合为空;成员可读目录。
      store.updateTenantMcpConnector(user.id, connector.id, { enabled: false });
      assert.equal(store.findMcpConnectorForRelay(connector.id, token), null);
      assert.deepEqual(store.tenantMcpConnectorsForDistribution(tenant.id), []);
      assert.equal(store.listTenantMcpConnectors(member.user.id, tenant.id)[0]!.enabled, false);

      store.updateTenantMcpConnector(user.id, connector.id, { enabled: true });
      assert.equal(store.tenantMcpConnectorsForDistribution(tenant.id).length, 1);
      store.deleteTenantMcpConnector(user.id, connector.id);
      assert.throws(() => store.getTenantMcpConnector(user.id, connector.id), /not_found/);
      assert.equal(store.findMcpConnectorForRelay(connector.id, token), null);
      assert.throws(() => store.deleteTenantMcpConnector(user.id, connector.id), /not_found/);
    } finally {
      if (priorSecret === undefined) delete process.env[secretEnv];
      else process.env[secretEnv] = priorSecret;
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
