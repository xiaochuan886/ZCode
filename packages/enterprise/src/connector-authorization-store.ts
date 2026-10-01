import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type UserConnectorAuthorization,
  type UserConnectorAuthorizationForRelay,
} from "./types.js";
import { EnterpriseStoreBase, id, now, type Row } from "./store-base.js";
import {
  ModelCredentialCipher,
  resolveModelCredentialKey,
  type ModelCredentialEncryptionKey,
} from "./model-credential-format.js";
import { decodeEnvelope } from "./provider-format.js";

const STATE_VALIDITY_MS = 10 * 60 * 1000;

/** 每用户 OAuth 授权行(解密前);列名与 v8 表一致。 */
interface AuthorizationRow {
  id: string;
  tenantId: string;
  connectorId: string;
  userId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  relayToken: string;
  expiresAt: string;
}

export interface UpsertUserConnectorAuthorizationInput {
  connectorId: string;
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface RefreshUserConnectorTokensInput {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/**
 * user-oauth 连接器的每用户授权存储。access/refresh token 以 AES-256-GCM 密文落库
 * (AAD = tenantId\0connectorId,与供应商 key 信封同一把钥匙);relay_token 首次授予
 * 生成后跨重新授权保持稳定——专家 HOME 里的中继配置不必因为重新授权而失效。
 */
export class ConnectorAuthorizationStoreSupport extends EnterpriseStoreBase {
  private readonly providedKey: Buffer | null;
  private cipherInstance: ModelCredentialCipher | null;
  private stateKeyInstance: Buffer | null = null;

  constructor(db: DatabaseSync, encryptionKey?: ModelCredentialEncryptionKey) {
    super(db, "");
    this.providedKey = encryptionKey === undefined ? null : resolveModelCredentialKey(encryptionKey);
    this.cipherInstance =
      this.providedKey === null ? null : new ModelCredentialCipher(this.providedKey);
  }

  private cipher(): ModelCredentialCipher {
    if (!this.cipherInstance) this.cipherInstance = new ModelCredentialCipher();
    return this.cipherInstance;
  }

  /** state 签名密钥 = sha256(模型凭据加密 key 字节 || 'connector-oauth-state')。 */
  private stateKey(): Buffer {
    if (!this.stateKeyInstance) {
      const keyBytes = this.providedKey ?? resolveModelCredentialKey();
      this.stateKeyInstance = createHash("sha256")
        .update(keyBytes)
        .update("connector-oauth-state", "utf8")
        .digest();
    }
    return this.stateKeyInstance;
  }

  private row(row: Row): AuthorizationRow {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      connectorId: String(row.connector_id),
      userId: String(row.user_id),
      accessTokenEncrypted: String(row.access_token_encrypted ?? ""),
      refreshTokenEncrypted: String(row.refresh_token_encrypted ?? ""),
      relayToken: String(row.relay_token ?? ""),
      expiresAt: String(row.expires_at ?? ""),
    };
  }

  private decrypt(row: AuthorizationRow): UserConnectorAuthorization {
    return {
      accessToken: this.cipher().decrypt(
        decodeEnvelope(row.accessTokenEncrypted),
        row.tenantId,
        row.connectorId,
      ),
      refreshToken: row.refreshTokenEncrypted
        ? this.cipher().decrypt(
            decodeEnvelope(row.refreshTokenEncrypted),
            row.tenantId,
            row.connectorId,
          )
        : "",
      expiresAt: row.expiresAt,
      relayToken: row.relayToken,
    };
  }

  /** 网关内部解密读取:分发与中继用,不做出席检查(调用方持有专家目标身份)。 */
  userConnectorAuthorization(connectorId: string, userId: string): UserConnectorAuthorization | null {
    const row = this.one(
      "SELECT * FROM user_mcp_connector_authorizations WHERE connector_id=? AND user_id=?",
      connectorId,
      userId,
    );
    return row ? this.decrypt(this.row(row)) : null;
  }

  /**
   * 授权回调后的写入:重新授权覆盖令牌与到期时间,relay_token 保持首次授予值。
   * 成员资格按连接器租户校验(成员即可连接自己的账号)。
   */
  upsertUserConnectorAuthorization(input: UpsertUserConnectorAuthorizationInput): void {
    if (!input.accessToken) throw new EnterpriseError("validation");
    const connector = this.one(
      "SELECT id,tenant_id FROM tenant_mcp_connectors WHERE id=?",
      input.connectorId,
    );
    if (!connector) throw new EnterpriseError("not_found");
    const tenantId = String(connector.tenant_id);
    this.transaction(() => {
      this.membership(input.userId, tenantId);
      const accessTokenEncrypted = JSON.stringify(
        this.cipher().encrypt(input.accessToken, tenantId, input.connectorId),
      );
      const refreshTokenEncrypted = input.refreshToken
        ? JSON.stringify(this.cipher().encrypt(input.refreshToken, tenantId, input.connectorId))
        : "";
      const expiresAt = input.expiresAt ?? "";
      const existing = this.one(
        "SELECT id,relay_token FROM user_mcp_connector_authorizations WHERE connector_id=? AND user_id=?",
        input.connectorId,
        input.userId,
      );
      if (existing) {
        this.run(
          `UPDATE user_mcp_connector_authorizations
              SET access_token_encrypted=?,refresh_token_encrypted=?,expires_at=?,granted_at=?
            WHERE id=?`,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          expiresAt,
          now(),
          String(existing.id),
        );
        return;
      }
      this.run(
        `INSERT INTO user_mcp_connector_authorizations
           (id,tenant_id,connector_id,user_id,access_token_encrypted,refresh_token_encrypted,relay_token,expires_at,granted_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        id(),
        tenantId,
        input.connectorId,
        input.userId,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        // 首次授予生成;专家 HOME 配置持有该令牌,重新授权不得更换。
        randomBytes(32).toString("base64url"),
        expiresAt,
        now(),
      );
    });
  }

  /** 成员只能撤销自己的授权行;actorId 就是行归属。 */
  deleteUserConnectorAuthorization(actorId: string, connectorId: string): void {
    this.transaction(() => {
      const connector = this.one(
        "SELECT tenant_id FROM tenant_mcp_connectors WHERE id=?",
        connectorId,
      );
      if (!connector) throw new EnterpriseError("not_found");
      this.membership(actorId, String(connector.tenant_id));
      const result = this.db
        .prepare("DELETE FROM user_mcp_connector_authorizations WHERE connector_id=? AND user_id=?")
        .run(connectorId, actorId);
      // node:sqlite 的 changes 可能返回 bigint,统一按 number 比较。
      if (Number(result.changes) === 0) throw new EnterpriseError("not_found");
    });
  }

  /**
   * 中继请求鉴权(用户授权路径):仅匹配 auth_mode='user-oauth' 且启用的连接器;
   * 每行做常数时间令牌比较,解密失败按未授权处理(fail closed,不外泄原因)。
   */
  findUserConnectorAuthorizationForRelay(
    connectorId: string,
    token: string,
  ): UserConnectorAuthorizationForRelay | null {
    const rows = this.all(
      `SELECT a.id AS authorization_id,a.tenant_id,a.connector_id,a.user_id,
              a.access_token_encrypted,a.refresh_token_encrypted,a.relay_token,a.expires_at,
              c.url,c.header_name,c.token_url,c.client_id,c.client_secret_encrypted
         FROM user_mcp_connector_authorizations a
         JOIN tenant_mcp_connectors c ON c.id=a.connector_id
        WHERE a.connector_id=? AND c.enabled=1 AND c.auth_mode='user-oauth'`,
      connectorId,
    );
    const presented = Buffer.from(token);
    for (const raw of rows) {
      const authorization = this.row(raw);
      const expected = Buffer.from(authorization.relayToken);
      if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) continue;
      try {
        return {
          authorizationId: String(raw.authorization_id),
          connectorId: authorization.connectorId,
          tenantId: authorization.tenantId,
          url: String(raw.url),
          headerName: String(raw.header_name),
          tokenUrl: String(raw.token_url),
          clientId: String(raw.client_id),
          clientSecret: raw.client_secret_encrypted
            ? this.cipher().decrypt(
                decodeEnvelope(String(raw.client_secret_encrypted)),
                authorization.tenantId,
                authorization.connectorId,
              )
            : null,
          ...this.decrypt(authorization),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 中继按需刷新后的持久化:只更新令牌与到期,relay_token 不变。 */
  refreshUserConnectorTokens(authorizationId: string, tokens: RefreshUserConnectorTokensInput): void {
    this.transaction(() => {
      const row = this.one(
        "SELECT tenant_id,connector_id FROM user_mcp_connector_authorizations WHERE id=?",
        authorizationId,
      );
      if (!row) throw new EnterpriseError("not_found");
      const accessTokenEncrypted = JSON.stringify(
        this.cipher().encrypt(tokens.accessToken, String(row.tenant_id), String(row.connector_id)),
      );
      const refreshTokenEncrypted = tokens.refreshToken
        ? JSON.stringify(
            this.cipher().encrypt(tokens.refreshToken, String(row.tenant_id), String(row.connector_id)),
          )
        : "";
      this.run(
        "UPDATE user_mcp_connector_authorizations SET access_token_encrypted=?,refresh_token_encrypted=?,expires_at=? WHERE id=?",
        accessTokenEncrypted,
        refreshTokenEncrypted,
        tokens.expiresAt,
        authorizationId,
      );
    });
  }

  /**
   * OAuth state = sessionId.connectorId.expiresMs.nonce.HMAC,其中 HMAC-SHA256 覆盖
   * `${sessionId}|${connectorId}|${expiresMs}|${nonce}`;10 分钟有效。回调同时校验
   * 会话与连接器绑定,防止跨会话/跨连接器重放。
   */
  signConnectorOauthState(sessionId: string, connectorId: string): string {
    const expiresMs = Date.now() + STATE_VALIDITY_MS;
    const nonce = randomBytes(16).toString("base64url");
    const payload = `${sessionId}|${connectorId}|${expiresMs}|${nonce}`;
    const mac = createHmac("sha256", this.stateKey()).update(payload).digest("base64url");
    return `${sessionId}.${connectorId}.${expiresMs}.${nonce}.${mac}`;
  }

  verifyConnectorOauthState(state: string, sessionId: string, connectorId: string): boolean {
    const parts = state.split(".");
    if (parts.length !== 5) return false;
    const [stateSessionId, stateConnectorId, expiresText, nonce, mac] = parts as [string, string, string, string, string];
    if (stateSessionId !== sessionId || stateConnectorId !== connectorId) return false;
    if (!/^\d+$/.test(expiresText)) return false;
    if (Date.now() >= Number(expiresText)) return false;
    const payload = `${stateSessionId}|${stateConnectorId}|${expiresText}|${nonce}`;
    const expected = createHmac("sha256", this.stateKey()).update(payload).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(mac, "base64url");
    } catch {
      return false;
    }
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }
}
