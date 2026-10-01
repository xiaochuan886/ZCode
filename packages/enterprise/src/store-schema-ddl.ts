/** 各版本迁移的表 DDL:自 store-schema 拆出以满足文件行数上限。 */

export const TENANT_MODEL_PROVIDERS_V7 = `
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

export const TENANT_MCP_CONNECTORS_V7 = `
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
export const USER_MCP_CONNECTOR_AUTHORIZATIONS_V8 = `
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

/** v9:客户可见性授权(allowlist);无授权行 = 可见全部(向后兼容的信任默认)。 */
export const CUSTOMER_ACCESS_GRANTS_V9 = `
  CREATE TABLE IF NOT EXISTS customer_access_grants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, customer_id)
  );
  CREATE INDEX IF NOT EXISTS customer_access_grants_user_idx ON customer_access_grants(tenant_id, user_id);
`;
