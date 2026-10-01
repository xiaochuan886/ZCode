import { endpointHost, type McpConnectorForRelay } from "./connector-format.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type TenantMcpConnector,
  type TenantMcpConnectorAuthMode,
  type TenantMcpConnectorDistribution,
  type TenantMcpConnectorOauthConfig,
} from "./types.js";
import { EnterpriseStoreBase, id, now, type Row } from "./store-base.js";
import { ModelCredentialCipher, type ModelCredentialEncryptionKey } from "./model-credential-format.js";
import { decodeEnvelope } from "./provider-format.js";
import {
  hasOauthField,
  invalid,
  normalizeAuthMode,
  validateConnectorKey,
  validateDisplayName,
  validateHeaderName,
  validateOauthClientId,
  validateOauthUrl,
  validateScopes,
  validateSecretEnv,
  validateUrl,
  type TenantMcpConnectorInput,
  type TenantMcpConnectorPatch,
} from "./connector-format.js";

export { CONNECTOR_KEY_PATTERN, endpointHost, type McpConnectorForRelay } from "./connector-format.js";
export type {
  TenantMcpConnectorInput,
  TenantMcpConnectorPatch,
} from "./connector-format.js";

const DEFAULT_HEADER_NAME = "Authorization";



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
  authMode: TenantMcpConnectorAuthMode;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
  scopes: string;
  createdAt: string;
}

/** user-oauth 模式下 OAuth 客户端配置的合并校验结果;clientSecretEnvelope 为空串表示无 secret。 */
interface OauthState {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecretEnvelope: string;
  scopes: string;
}

const EMPTY_OAUTH: OauthState = {
  authorizeUrl: "",
  tokenUrl: "",
  clientId: "",
  clientSecretEnvelope: "",
  scopes: "",
};

/** SQLite adapter for tenant system connectors (系统连接器); EnterpriseStore owns its instance. */
export class ConnectorStoreSupport extends EnterpriseStoreBase {
  private cipherInstance: ModelCredentialCipher | null;

  constructor(db: DatabaseSync, encryptionKey?: ModelCredentialEncryptionKey) {
    super(db, "");
    this.cipherInstance =
      encryptionKey === undefined ? null : new ModelCredentialCipher(encryptionKey);
  }

  private cipher(): ModelCredentialCipher {
    if (!this.cipherInstance) this.cipherInstance = new ModelCredentialCipher();
    return this.cipherInstance;
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
      authMode: String(row.auth_mode ?? "shared") === "user-oauth" ? "user-oauth" : "shared",
      authorizeUrl: String(row.authorize_url ?? ""),
      tokenUrl: String(row.token_url ?? ""),
      clientId: String(row.client_id ?? ""),
      clientSecretEncrypted: String(row.client_secret_encrypted ?? ""),
      scopes: String(row.scopes ?? ""),
      createdAt: String(row.created_at),
    };
  }

  /** Browser-safe projection: only the endpoint host; token/secret/客户端配置 never leave. */
  private projection(row: ConnectorRow, actorId: string): TenantMcpConnector {
    return {
      id: row.id,
      tenantId: row.tenantId,
      connectorKey: row.connectorKey,
      displayName: row.displayName,
      endpointHost: endpointHost(row.url),
      headerName: row.headerName,
      secretConfigured: Boolean(row.secretEnv && process.env[row.secretEnv]),
      enabled: row.enabled,
      authMode: row.authMode,
      // 授权状态按"当前访问用户"计算:同一连接器对不同专家可以一个已连接、一个未连接。
      authorized:
        row.authMode === "shared" ||
        Boolean(
          this.one(
            "SELECT 1 FROM user_mcp_connector_authorizations WHERE connector_id=? AND user_id=? LIMIT 1",
            row.id,
            actorId,
          ),
        ),
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
    ).map((row) => this.projection(this.row(row), actorId));
  }

  getTenantMcpConnector(actorId: string, connectorId: string): TenantMcpConnector {
    const row = this.byId(connectorId);
    this.membership(actorId, row.tenantId);
    return this.projection(row, actorId);
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
    const enabled = input.enabled === undefined ? true : input.enabled === true;
    const authMode = normalizeAuthMode(input.authMode);
    let secretEnv = "";
    let oauth = EMPTY_OAUTH;
    if (authMode === "shared") {
      if (hasOauthField(input)) invalid();
      secretEnv = validateSecretEnv(input.secretEnv ?? "");
    } else if (typeof input.secretEnv === "string" && input.secretEnv.trim()) {
      invalid();
    } else {
      oauth = {
        authorizeUrl: validateOauthUrl(input.authorizeUrl ?? ""),
        tokenUrl: validateOauthUrl(input.tokenUrl ?? ""),
        clientId: validateOauthClientId(input.clientId ?? ""),
        clientSecretEnvelope: "",
        scopes: validateScopes(input.scopes),
      };
    }
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
      // client secret 的密文绑定 AAD tenantId\0connectorId,须在 id 生成后加密。
      if (authMode === "user-oauth" && input.clientSecret?.trim()) {
        oauth = {
          ...oauth,
          clientSecretEnvelope: JSON.stringify(
            this.cipher().encrypt(input.clientSecret.trim(), tenantId, connectorId),
          ),
        };
      }
      this.run(
        `INSERT INTO tenant_mcp_connectors
           (id,tenant_id,connector_key,display_name,url,header_name,secret_env,token,enabled,
            auth_mode,authorize_url,token_url,client_id,client_secret_encrypted,scopes,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        connectorId,
        tenantId,
        connectorKey,
        displayName,
        url,
        headerName,
        secretEnv,
        // 令牌与 v6 客户绑定同款:稳定随机值存库,跨网关重启一致。
        randomBytes(32).toString("base64url"),
        enabled ? 1 : 0,
        authMode,
        oauth.authorizeUrl,
        oauth.tokenUrl,
        oauth.clientId,
        oauth.clientSecretEnvelope,
        oauth.scopes,
        now(),
      );
      return this.projection(this.byId(connectorId), actorId);
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
      const enabled = patch.enabled === undefined ? current.enabled : patch.enabled === true;
      const authMode =
        patch.authMode === undefined ? current.authMode : normalizeAuthMode(patch.authMode);
      let secretEnv: string;
      let oauth: OauthState;
      if (authMode === "shared") {
        // shared 模式禁止携带 OAuth 字段;secretEnv 合并后必须有效。
        if (hasOauthField(patch)) invalid();
        secretEnv = validateSecretEnv(patch.secretEnv ?? current.secretEnv);
        oauth = EMPTY_OAUTH;
        if (current.authMode === "user-oauth") {
          // 离开 user-oauth 模式后,既有每用户授权不再有效,同事务内清除。
          this.run("DELETE FROM user_mcp_connector_authorizations WHERE connector_id=?", connectorId);
        }
      } else {
        if (typeof patch.secretEnv === "string" && patch.secretEnv.trim()) invalid();
        secretEnv = "";
        oauth = {
          authorizeUrl: validateOauthUrl(
            patch.authorizeUrl !== undefined && patch.authorizeUrl.trim() !== ""
              ? validateOauthUrl(patch.authorizeUrl)
              : current.authorizeUrl,
          ),
          tokenUrl: validateOauthUrl(
            patch.tokenUrl !== undefined && patch.tokenUrl.trim() !== ""
              ? patch.tokenUrl
              : current.tokenUrl,
          ),
          clientId: validateOauthClientId(
            patch.clientId !== undefined && patch.clientId.trim() !== ""
              ? patch.clientId
              : current.clientId,
          ),
          // 空 secret = 保留现有密文(或维持公共客户端的无 secret 状态)。
          clientSecretEnvelope: patch.clientSecret?.trim()
            ? JSON.stringify(
                this.cipher().encrypt(patch.clientSecret.trim(), current.tenantId, connectorId),
              )
            : current.clientSecretEncrypted,
          scopes: patch.scopes === undefined ? current.scopes : validateScopes(patch.scopes),
        };
      }
      this.run(
        `UPDATE tenant_mcp_connectors
           SET display_name=?,url=?,header_name=?,secret_env=?,enabled=?,
               auth_mode=?,authorize_url=?,token_url=?,client_id=?,client_secret_encrypted=?,scopes=?
         WHERE id=?`,
        displayName,
        url,
        headerName,
        secretEnv,
        enabled ? 1 : 0,
        authMode,
        oauth.authorizeUrl,
        oauth.tokenUrl,
        oauth.clientId,
        oauth.clientSecretEnvelope,
        oauth.scopes,
        connectorId,
      );
      return this.projection(this.byId(connectorId), actorId);
    });
  }

  deleteTenantMcpConnector(actorId: string, connectorId: string): void {
    this.transaction(() => {
      const current = this.byId(connectorId);
      this.membership(actorId, current.tenantId, "admin");
      // 每用户授权行由外键级联删除(ON DELETE CASCADE)。
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
        authMode: connector.authMode,
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

  /** OAuth 客户端配置的网关内部解密读取;成员即可调用(authorize 流程面向全部专家)。 */
  tenantMcpConnectorOauthConfig(
    actorId: string,
    connectorId: string,
  ): TenantMcpConnectorOauthConfig {
    const row = this.byId(connectorId);
    this.membership(actorId, row.tenantId);
    if (row.authMode !== "user-oauth") throw new EnterpriseError("validation");
    return {
      tenantId: row.tenantId,
      connectorId: row.id,
      authorizeUrl: row.authorizeUrl,
      tokenUrl: row.tokenUrl,
      clientId: row.clientId,
      clientSecret: row.clientSecretEncrypted
        ? this.cipher().decrypt(
            decodeEnvelope(row.clientSecretEncrypted),
            row.tenantId,
            row.id,
          )
        : null,
      scopes: row.scopes,
    };
  }
}

