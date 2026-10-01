import { DatabaseSync } from "node:sqlite";
import { ensureModelCredentialMetadataColumns } from "./model-credential-schema.js";
import { EnterpriseError } from "./types.js";

type SchemaRow = Record<string, unknown>;

const one = (db: DatabaseSync, sql: string): SchemaRow | undefined =>
  db.prepare(sql).get() as SchemaRow | undefined;

const all = (db: DatabaseSync, sql: string): SchemaRow[] => db.prepare(sql).all() as SchemaRow[];

const transaction = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const CUSTOMER_SKILLS_V4 = `
  CREATE TABLE customer_skills (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

const CUSTOMER_MCP_BINDINGS_V4 = `
  CREATE TABLE customer_mcp_bindings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    secret_ref TEXT,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

const TENANT_SKILLS_V5 = `
  CREATE TABLE IF NOT EXISTS tenant_skills (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tenant_skills_tenant_idx ON tenant_skills(tenant_id, created_at);
`;

const TENANT_MODEL_PROVIDERS_V7 = `
  CREATE TABLE IF NOT EXISTS tenant_model_providers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    api_type TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    models TEXT NOT NULL DEFAULT '[]',
    default_model TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, provider_key)
  );
  CREATE INDEX IF NOT EXISTS tenant_model_providers_tenant_idx
    ON tenant_model_providers(tenant_id, is_default DESC, created_at);
`;

const TENANT_MCP_CONNECTORS_V7 = `
  CREATE TABLE IF NOT EXISTS tenant_mcp_connectors (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connector_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    url TEXT NOT NULL,
    header_name TEXT NOT NULL DEFAULT 'Authorization',
    secret_env TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    auth_mode TEXT NOT NULL DEFAULT 'shared',
    authorize_url TEXT NOT NULL DEFAULT '',
    token_url TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    client_secret_encrypted TEXT NOT NULL DEFAULT '',
    scopes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, connector_key)
  );
`;

/** v8:每个 (连接器, 用户) 一行的 OAuth 授权;令牌密文落库,relay_token 首次授予后稳定。 */
const USER_MCP_CONNECTOR_AUTHORIZATIONS_V8 = `
  CREATE TABLE IF NOT EXISTS user_mcp_connector_authorizations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    connector_id TEXT NOT NULL REFERENCES tenant_mcp_connectors(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL DEFAULT '',
    relay_token TEXT NOT NULL,
    expires_at TEXT NOT NULL DEFAULT '',
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (connector_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS user_mcp_connector_authorizations_connector_idx
    ON user_mcp_connector_authorizations(connector_id, user_id);
`;

const CUSTOMER_SCHEMA_V4 = `
  CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    metadata TEXT NOT NULL,
    workspace_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  );
${CUSTOMER_SKILLS_V4}${CUSTOMER_MCP_BINDINGS_V4}
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    active_customer_id TEXT REFERENCES customers(id)
  );
`;

/** v7 迁移钩子:在同一事务内把 legacy 单凭据 seed 成目录行(需要调用方的加密器)。 */
export interface StoreSchemaHooks {
  seedTenantCatalogV7?: (db: DatabaseSync) => void;
}

export function migrateStoreSchema(db: DatabaseSync, hooks: StoreSchemaHooks = {}): void {
  const version = Number(one(db, "PRAGMA user_version")?.user_version ?? 0);
  if (version > 8) throw new EnterpriseError("conflict");
  if (version === 0) {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE memberships (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('admin','member')), PRIMARY KEY (tenant_id,user_id));
        CREATE TABLE model_credentials (
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          provider_family TEXT NOT NULL,
          provider_name TEXT,
          api_type TEXT,
          base_url TEXT,
          model_id TEXT,
          key_version INTEGER NOT NULL,
          ciphertext TEXT,
          nonce TEXT,
          auth_tag TEXT,
          last_four TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revoked_at TEXT,
          PRIMARY KEY (tenant_id, provider_family),
          CHECK ((revoked_at IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL) OR revoked_at IS NOT NULL)
        );
        ${CUSTOMER_SCHEMA_V4}${TENANT_SKILLS_V5}${TENANT_MODEL_PROVIDERS_V7}${TENANT_MCP_CONNECTORS_V7}${USER_MCP_CONNECTOR_AUTHORIZATIONS_V8}
        PRAGMA user_version = 8;
      `);
    });
    ensureModelCredentialMetadataColumns(db);
    return;
  }
  if (version === 1) {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE model_credentials (
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          provider_family TEXT NOT NULL,
          provider_name TEXT,
          api_type TEXT,
          base_url TEXT,
          model_id TEXT,
          key_version INTEGER NOT NULL,
          ciphertext TEXT,
          nonce TEXT,
          auth_tag TEXT,
          last_four TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revoked_at TEXT,
          PRIMARY KEY (tenant_id, provider_family),
          CHECK ((revoked_at IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL) OR revoked_at IS NOT NULL)
        );
        PRAGMA user_version = 2;
      `);
    });
  }
  const customerReady = Number(one(db, "PRAGMA user_version")?.user_version ?? 0);
  if (customerReady === 2) {
    const tables = new Set(
      all(db, "SELECT name FROM sqlite_master WHERE type='table'").map((row) => String(row.name)),
    );
    const hasCustomerSchema =
      ["customers", "customer_skills", "customer_mcp_bindings"].every((name) => tables.has(name)) &&
      all(db, "PRAGMA table_info(sessions)").some((column) => column.name === "active_customer_id");
    // Some operators/tests may restore only PRAGMA user_version after a partial repair.
    // Existing v3 tables are already complete; keep the recorded version stable in that case.
    if (!hasCustomerSchema)
      transaction(db, () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS customers (
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
          CREATE TABLE IF NOT EXISTS customer_skills (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            source_shared_skill_id TEXT REFERENCES shared_skills(id),
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(customer_id, source_shared_skill_id)
          );
          CREATE TABLE IF NOT EXISTS customer_mcp_bindings (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            source_mcp_binding_id TEXT REFERENCES mcp_bindings(id),
            name TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            secret_ref TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(customer_id, source_mcp_binding_id)
          );
        `);
        const sessionColumns = all(db, "PRAGMA table_info(sessions)");
        if (!sessionColumns.some((column) => column.name === "active_customer_id")) {
          db.exec(
            "ALTER TABLE sessions ADD COLUMN active_customer_id TEXT REFERENCES customers(id)",
          );
        }
        db.exec("PRAGMA user_version = 3");
      });
  }
  const currentVersion = Number(one(db, "PRAGMA user_version")?.user_version ?? 0);
  if (currentVersion === 3) {
    // v4 破坏性删除旧 per-Case 架构：初始开发阶段，不保留 ServiceSpace/ServiceObject/Case
    // 兼容数据。按 SQLite 官方建议在重构 schema 时关闭外键约束，完成后重新启用；
    // customers 行与 sessions 的 active_customer_id 绑定原样保留。
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      transaction(db, () => {
        db.exec(`
          DROP TABLE customer_skills;
          DROP TABLE customer_mcp_bindings;
          CREATE TABLE sessions_v4 (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            csrf_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            active_customer_id TEXT REFERENCES customers(id)
          );
          INSERT INTO sessions_v4 (id,user_id,token_hash,csrf_hash,expires_at,active_customer_id)
            SELECT id,user_id,token_hash,csrf_hash,expires_at,active_customer_id FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_v4 RENAME TO sessions;
          DROP TABLE shared_skills;
          DROP TABLE mcp_bindings;
          DROP TABLE cases;
          DROP TABLE service_objects;
          DROP TABLE service_spaces;
          CREATE TABLE customers_v4 (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            metadata TEXT NOT NULL,
            workspace_path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_used_at TEXT
          );
          INSERT INTO customers_v4 (id,tenant_id,name,type,metadata,workspace_path,created_at,updated_at,last_used_at)
            SELECT id,tenant_id,name,type,metadata,workspace_path,created_at,updated_at,last_used_at FROM customers;
          DROP TABLE customers;
          ALTER TABLE customers_v4 RENAME TO customers;
${CUSTOMER_SKILLS_V4}${CUSTOMER_MCP_BINDINGS_V4}
          DELETE FROM model_credentials WHERE provider_family <> 'custom';
          PRAGMA user_version = 4;
        `);
      });
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
  const afterV4 = Number(one(db, "PRAGMA user_version")?.user_version ?? 0);
  if (afterV4 === 4) {
    // v5 新增租户级共享 Skill：非破坏性变更，仅加表。
    transaction(db, () => {
      db.exec(`
${TENANT_SKILLS_V5}
        PRAGMA user_version = 5;
      `);
    });
  }
  const afterV5 = Number(one(db, "PRAGMA user_version")?.user_version ?? 0);
  if (afterV5 === 5) {
    // v6 给 MCP 绑定加稳定中继令牌：专家 runtime 共享同一份工作区配置，
    // 令牌必须跨网关重启稳定，存库而不是进程内存。
    transaction(db, () => {
      const hasToken = all(db, "PRAGMA table_info(customer_mcp_bindings)").some(
        (column) => column.name === "token",
      );
      if (!hasToken) {
        db.exec("ALTER TABLE customer_mcp_bindings ADD COLUMN token TEXT");
      }
      // 存量行在下次物化时补令牌；这里先给非 NULL 约束填占位值。
      db.exec("UPDATE customer_mcp_bindings SET token='' WHERE token IS NULL");
      db.exec("PRAGMA user_version = 6");
    });
  }
  const afterV6 = Number(one(db, "PRAGMA user_version")?.user_version ?? 0);
  if (afterV6 === 6) {
    // v7 新增租户模型供应商目录与系统连接器；legacy 单凭据在同一事务内
    // seed 成目录行。seed 失败会回滚整个迁移，operator 修正密钥后可重试。
    transaction(db, () => {
      db.exec(`${TENANT_MODEL_PROVIDERS_V7}${TENANT_MCP_CONNECTORS_V7}
        PRAGMA user_version = 7;`);
      hooks.seedTenantCatalogV7?.(db);
    });
  }
  const afterV7 = Number(one(db, "PRAGMA user_version")?.user_version ?? 0);
  if (afterV7 === 7) {
    // v8 新增连接器 OAuth 列与每用户授权表。存量连接器全部是 shared 模式，
    // DEFAULT 'shared' 语义与现状一致；列存在性检查与 v6 同款，容错部分修复的库。
    transaction(db, () => {
      const connectorColumns = new Set(
        all(db, "PRAGMA table_info(tenant_mcp_connectors)").map((column) => String(column.name)),
      );
      for (const [column, definition] of [
        ["auth_mode", "TEXT NOT NULL DEFAULT 'shared'"],
        ["authorize_url", "TEXT NOT NULL DEFAULT ''"],
        ["token_url", "TEXT NOT NULL DEFAULT ''"],
        ["client_id", "TEXT NOT NULL DEFAULT ''"],
        ["client_secret_encrypted", "TEXT NOT NULL DEFAULT ''"],
        ["scopes", "TEXT NOT NULL DEFAULT ''"],
      ] as const) {
        if (!connectorColumns.has(column)) {
          db.exec(`ALTER TABLE tenant_mcp_connectors ADD COLUMN ${column} ${definition}`);
        }
      }
      db.exec(`${USER_MCP_CONNECTOR_AUTHORIZATIONS_V8}
        PRAGMA user_version = 8;`);
    });
  }
  ensureModelCredentialMetadataColumns(db);
}
