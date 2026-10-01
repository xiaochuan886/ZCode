import type {
  ConnectorOauthTokenSet,
  TenantMcpConnectorOauthConfig,
  UserConnectorAuthorizationForRelay,
} from "./types.js";
import type { EnterpriseStore } from "./store.js";

const tokenEndpointTimeoutMs = 10_000;

/** 标准 OAuth2 令牌响应:access_token 必填,refresh_token/expires_in 可选。 */
function parseTokenResponse(payload: unknown): ConnectorOauthTokenSet | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.access_token !== "string" || !record.access_token) return null;
  const refreshToken =
    typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : null;
  const expiresIn = record.expires_in;
  const expiresAt =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : "";
  return { accessToken: record.access_token, refreshToken, expiresAt };
}

/** 表单 POST 到令牌端点;任何失败都吞掉细节只返回 null,绝不记录 code/token。 */
async function postTokenRequest(
  tokenUrl: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<ConnectorOauthTokenSet | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tokenEndpointTimeoutMs);
  try {
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    return parseTokenResponse(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 浏览器重定向目标:与 authorize 步骤使用同一 origin 推导,保证两次构造一致。 */
export function connectorOauthRedirectUri(
  requestOrigin: string,
  tenantId: string,
  connectorId: string,
): string {
  return `${requestOrigin}/api/enterprise/tenants/${encodeURIComponent(tenantId)}/mcp-connectors/${encodeURIComponent(connectorId)}/callback`;
}

export function buildConnectorAuthorizeUrl(
  config: TenantMcpConnectorOauthConfig,
  redirectUri: string,
  state: string,
): string {
  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  if (config.scopes) authorizeUrl.searchParams.set("scope", config.scopes);
  authorizeUrl.searchParams.set("state", state);
  return authorizeUrl.toString();
}

export async function exchangeConnectorAuthorizationCode(
  config: TenantMcpConnectorOauthConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<ConnectorOauthTokenSet | null> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
  });
  if (config.clientSecret) params.set("client_secret", config.clientSecret);
  return postTokenRequest(config.tokenUrl, params, fetchImpl);
}

/** 刷新按授权行串行:并发请求共享同一次刷新,避免轮换型 refresh token 互相踩踏。 */
const refreshTokenInFlight = new Map<string, Promise<ConnectorOauthTokenSet | null>>();

function performTokenRefresh(
  store: EnterpriseStore,
  authorization: UserConnectorAuthorizationForRelay,
  fetchImpl: typeof fetch,
): Promise<ConnectorOauthTokenSet | null> {
  return (async () => {
    try {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: authorization.refreshToken,
        client_id: authorization.clientId,
      });
      if (authorization.clientSecret) {
        params.set("client_secret", authorization.clientSecret);
      }
      const tokens = await postTokenRequest(authorization.tokenUrl, params, fetchImpl);
      if (!tokens) return null;
      // 未返回新 refresh token 的供应商沿用旧值;relay_token 不在刷新范围内。
      store.refreshUserConnectorTokens(authorization.authorizationId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? authorization.refreshToken,
        expiresAt: tokens.expiresAt,
      });
      return tokens;
    } catch {
      return null;
    }
  })();
}

function refreshUserConnectorTokensSerialized(
  store: EnterpriseStore,
  authorization: UserConnectorAuthorizationForRelay,
  fetchImpl: typeof fetch,
): Promise<ConnectorOauthTokenSet | null> {
  const existing = refreshTokenInFlight.get(authorization.authorizationId);
  if (existing) return existing;
  const task = performTokenRefresh(store, authorization, fetchImpl).finally(() => {
    refreshTokenInFlight.delete(authorization.authorizationId);
  });
  refreshTokenInFlight.set(authorization.authorizationId, task);
  return task;
}

export type UserConnectorRelayAccess =
  | { kind: "absent" }
  | { kind: "refresh-failed" }
  | { kind: "ready"; authorization: UserConnectorAuthorizationForRelay; accessToken: string };

/**
 * 中继的用户授权解析:令牌常数时间匹配后,过期且持有 refresh token 时先刷新再放行;
 * 刷新失败按 refresh-failed 报告(调用方回 503 诊断),条目保留等待重新授权。
 */
export async function resolveUserConnectorRelayAccess(
  store: EnterpriseStore,
  connectorId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<UserConnectorRelayAccess> {
  const authorization = store.findUserConnectorAuthorizationForRelay(connectorId, token);
  if (!authorization) return { kind: "absent" };
  const expiresAt = authorization.expiresAt ? Date.parse(authorization.expiresAt) : Number.NaN;
  if (!(Date.now() >= expiresAt) || !authorization.refreshToken) {
    return { kind: "ready", authorization, accessToken: authorization.accessToken };
  }
  const refreshed = await refreshUserConnectorTokensSerialized(store, authorization, fetchImpl);
  if (!refreshed) return { kind: "refresh-failed" };
  return { kind: "ready", authorization, accessToken: refreshed.accessToken };
}
