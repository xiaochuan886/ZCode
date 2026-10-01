import { randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type TenantMcpConnector,
  type TenantMcpConnectorDistribution,
} from "./types.js";
import { EnterpriseStoreBase, id, now, type Row } from "./store-base.js";

/** Stable slug identifying a system connector inside its tenant; also the managed MCP name suffix. */
export const CONNECTOR_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_HEADER_NAME = "Authorization";
/** RFC 7230 token characters; header names must be safe to inject verbatim upstream. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;

export interface TenantMcpConnectorInput {
  connectorKey: string;
  displayName: string;
  url: string;
  headerName?: string;
  secretEnv: string;
  enabled?: boolean;
}

export interface TenantMcpConnectorPatch {
  connectorKey?: string;
  displayName?: string;
  url?: string;
  headerName?: string;
  secretEnv?: string;
  enabled?: boolean;
}

export interface McpConnectorForRelay {
  id: string;
  tenantId: string;
  url: string;
  headerName: string;
  secretEnv: string;
}

interface ConnectorRow {
  id: string;
  tenantId: string;
  connectorKey: string;
  displayName: string;
  url: string;
  headerName: string;
  secretEnv: string;
  token: string;
  enabled: boolean;
  createdAt: string;
}

const invalid = (): never => {
  // Never include supplied values in errors; they may contain live secret references.
  throw new EnterpriseError("validation");
};

function validateConnectorKey(value: string): string {
  if (typeof value !== "string" || !CONNECTOR_KEY_PATTERN.test(value)) invalid();
  return value;
}

function validateDisplayName(value: string): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || normalized.includes("\0")) invalid();
  return normalized;
}

function validateUrl(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) invalid();
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalid();
  }
  if (parsed.username || parsed.password || parsed.hash) invalid();
  return trimmed;
}

function validateHeaderName(value: string | undefined): string {
  if (value === undefined || value === "") return DEFAULT_HEADER_NAME;
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (!HEADER_NAME_PATTERN.test(normalized)) invalid();
  return normalized;
}

function validateSecretEnv(value: string): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /\s/.test(normalized) || normalized.includes("\0"))
    invalid();
  return normalized;
}

function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** SQLite adapter for tenant system connectors (系统连接器); EnterpriseStore owns its instance. */
export class ConnectorStoreSupport extends EnterpriseStoreBase {
  constructor(db: DatabaseSync) {
    super(db, "");
  }

  private row(row: Row): ConnectorRow {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      connectorKey: String(row.connector_key),
      displayName: String(row.display_name),
      url: String(row.url),
      headerName: String(row.header_name ?? DEFAULT_HEADER_NAME) || DEFAULT_HEADER_NAME,
      secretEnv: String(row.secret_env ?? ""),
      token: String(row.token ?? ""),
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
    };
  }

  /** Browser-safe projection: only the endpoint host; token and secret value never leave. */
  private projection(row: ConnectorRow): TenantMcpConnector {
    return {
      id: row.id,
      tenantId: row.tenantId,
      connectorKey: row.connectorKey,
      displayName: row.displayName,
      endpointHost: endpointHost(row.url),
      headerName: row.headerName,
      secretConfigured: Boolean(row.secretEnv && process.env[row.secretEnv]),
      enabled: row.enabled,
    };
  }

  private byId(connectorId: string): ConnectorRow {
    const row = this.one("SELECT * FROM tenant_mcp_connectors WHERE id=?", connectorId);
    if (!row) throw new EnterpriseError("not_found");
    return this.row(row);
  }

  listTenantMcpConnectors(actorId: string, tenantId: string): TenantMcpConnector[] {
    this.membership(actorId, tenantId);
    return this.all(
      "SELECT * FROM tenant_mcp_connectors WHERE tenant_id=? ORDER BY created_at,id",
      tenantId,
    ).map((row) => this.projection(this.row(row)));
  }

  getTenantMcpConnector(actorId: string, connectorId: string): TenantMcpConnector {
    const row = this.byId(connectorId);
    this.membership(actorId, row.tenantId);
    return this.projection(row);
  }

  createTenantMcpConnector(
    actorId: string,
    tenantId: string,
    input: TenantMcpConnectorInput,
  ): TenantMcpConnector {
    const connectorKey = validateConnectorKey(input.connectorKey);
    const displayName = validateDisplayName(input.displayName);
    const url = validateUrl(input.url);
    const headerName = validateHeaderName(input.headerName);
    const secretEnv = validateSecretEnv(input.secretEnv);
    return this.transaction(() => {
      this.membership(actorId, tenantId, "admin");
      if (
        this.one(
          "SELECT id FROM tenant_mcp_connectors WHERE tenant_id=? AND connector_key=?",
          tenantId,
          connectorKey,
        )
      )
        throw new EnterpriseError("conflict");
      const connectorId = id();
      this.run(
        `INSERT INTO tenant_mcp_connectors
           (id,tenant_id,connector_key,display_name,url,header_name,secret_env,token,enabled,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        connectorId,
        tenantId,
        connectorKey,
        displayName,
        url,
        headerName,
        secretEnv,
        // 令牌与 v6 客户绑定同款:稳定随机值存库,跨网关重启一致。
        randomBytes(32).toString("base64url"),
        input.enabled === false ? 0 : 1,
        now(),
      );
      return this.projection(this.byId(connectorId));
    });
  }

  updateTenantMcpConnector(
    actorId: string,
    connectorId: string,
    patch: TenantMcpConnectorPatch,
  ): TenantMcpConnector {
    if (patch.connectorKey !== undefined) invalid();
    return this.transaction(() => {
      const current = this.byId(connectorId);
      this.membership(actorId, current.tenantId, "admin");
      const displayName =
        patch.displayName === undefined
          ? current.displayName
          : validateDisplayName(patch.displayName);
      const url = patch.url === undefined ? current.url : validateUrl(patch.url);
      const headerName =
        patch.headerName === undefined ? current.headerName : validateHeaderName(patch.headerName);
      const secretEnv =
        patch.secretEnv === undefined ? current.secretEnv : validateSecretEnv(patch.secretEnv);
      const enabled = patch.enabled === undefined ? current.enabled : patch.enabled === true;
      this.run(
        `UPDATE tenant_mcp_connectors
           SET display_name=?,url=?,header_name=?,secret_env=?,enabled=?
         WHERE id=?`,
        displayName,
        url,
        headerName,
        secretEnv,
        enabled ? 1 : 0,
        connectorId,
      );
      return this.projection(this.byId(connectorId));
    });
  }

  deleteTenantMcpConnector(actorId: string, connectorId: string): void {
    this.transaction(() => {
      const current = this.byId(connectorId);
      this.membership(actorId, current.tenantId, "admin");
      this.run("DELETE FROM tenant_mcp_connectors WHERE id=?", connectorId);
    });
  }

  /** 分发集合:仅启用行;endpoint/secret 的策略校验由 gateway 准备层完成。 */
  tenantMcpConnectorsForDistribution(tenantId: string): TenantMcpConnectorDistribution[] {
    return this.all(
      "SELECT * FROM tenant_mcp_connectors WHERE tenant_id=? AND enabled=1 ORDER BY created_at,id",
      tenantId,
    ).map((row) => {
      const connector = this.row(row);
      return {
        id: connector.id,
        tenantId: connector.tenantId,
        connectorKey: connector.connectorKey,
        url: connector.url,
        headerName: connector.headerName,
        secretEnv: connector.secretEnv,
      };
    });
  }

  /** 确保连接器持有稳定令牌(空串=异常旧数据),返回可用于分发的令牌。 */
  ensureMcpConnectorToken(connectorId: string): string {
    const row = this.one("SELECT id,token FROM tenant_mcp_connectors WHERE id=?", connectorId);
    if (!row) throw new EnterpriseError("not_found");
    const current = row.token == null ? "" : String(row.token);
    if (current) return current;
    const token = randomBytes(32).toString("base64url");
    this.run("UPDATE tenant_mcp_connectors SET token=? WHERE id=?", token, connectorId);
    return token;
  }

  /** 中继请求鉴权:按连接器取行并做常数时间令牌比较;停用的连接器一律拒绝。 */
  findMcpConnectorForRelay(connectorId: string, token: string): McpConnectorForRelay | null {
    const row = this.one(
      "SELECT * FROM tenant_mcp_connectors WHERE id=? AND enabled=1",
      connectorId,
    );
    if (!row) return null;
    const connector = this.row(row);
    if (!connector.token) return null;
    const expected = Buffer.from(connector.token);
    const presented = Buffer.from(token);
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
    return {
      id: connector.id,
      tenantId: connector.tenantId,
      url: connector.url,
      headerName: connector.headerName,
      secretEnv: connector.secretEnv,
    };
  }
}
