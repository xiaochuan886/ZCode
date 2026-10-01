import type { EnterpriseApiRequest } from "./gateway-types.js";
import { EnterpriseError, type EnterpriseSession } from "./types.js";
import {
  buildConnectorAuthorizeUrl,
  connectorOauthRedirectUri,
  exchangeConnectorAuthorizationCode,
} from "./connector-oauth.js";

/**
 * user-oauth 连接器的授权流程路由(成员即可调用,只作用于自己的授权行):
 * authorize 返回带签名 state 的供应商授权地址;callback 是浏览器导航端点,
 * 服务端换码并落库后 302 回应用;DELETE 撤销当前用户自己的授权。
 */
export async function handleConnectorOauthApiRequest(
  dependencies: EnterpriseApiRequest,
  session: EnterpriseSession,
): Promise<boolean> {
  const { options, request, response, url, path, method, stopRuntime } = dependencies;
  const { send, relayOrigin, runtimeTargetsForTenant } = dependencies.helpers;
  const stopTenantRuntimes = async (tenantId: string): Promise<void> => {
    // 授权变更影响该租户全部专家 runtime 的分发内容:先停,下次打开时重新物化。
    const affected = runtimeTargetsForTenant(options.store, session.userId, tenantId);
    await Promise.all(affected.map((target) => stopRuntime(target)));
  };

  const authorize = path.match(
    /^\/api\/enterprise\/tenants\/([^/]+)\/mcp-connectors\/([^/]+)\/authorize$/,
  );
  if (authorize && method === "GET") {
    const tenantId = authorize[1]!;
    const connectorId = authorize[2]!;
    const connector = options.store.getTenantMcpConnector(session.userId, connectorId);
    if (connector.tenantId !== tenantId) throw new EnterpriseError("not_found");
    if (connector.authMode !== "user-oauth") throw new EnterpriseError("validation");
    const config = options.store.tenantMcpConnectorOauthConfig(session.userId, connectorId);
    const state = options.store.signConnectorOauthState(session.id, connectorId);
    const redirectUri = connectorOauthRedirectUri(
      relayOrigin(request, options),
      tenantId,
      connectorId,
    );
    send(response, 200, { authorizeUrl: buildConnectorAuthorizeUrl(config, redirectUri, state) });
    return true;
  }

  const callback = path.match(
    /^\/api\/enterprise\/tenants\/([^/]+)\/mcp-connectors\/([^/]+)\/callback$/,
  );
  if (callback && method === "GET") {
    const tenantId = callback[1]!;
    const connectorId = callback[2]!;
    const redirect = (target: string) => {
      response.writeHead(302, { location: target, "cache-control": "no-store" });
      response.end();
    };
    // 浏览器导航端点:所有失败统一 302 到失败标记,错误细节与 code/token 一律不回显。
    try {
      const connector = options.store.getTenantMcpConnector(session.userId, connectorId);
      if (connector.tenantId !== tenantId || connector.authMode !== "user-oauth") {
        redirect("/?enterpriseOauth=failed");
        return true;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || url.searchParams.get("error")) {
        redirect("/?enterpriseOauth=failed");
        return true;
      }
      if (!options.store.verifyConnectorOauthState(state, session.id, connectorId)) {
        redirect("/?enterpriseOauth=failed");
        return true;
      }
      const config = options.store.tenantMcpConnectorOauthConfig(session.userId, connectorId);
      const redirectUri = connectorOauthRedirectUri(
        relayOrigin(request, options),
        tenantId,
        connectorId,
      );
      const tokens = await exchangeConnectorAuthorizationCode(
        config,
        code,
        redirectUri,
        options.fetchImpl ?? fetch,
      );
      if (!tokens) {
        redirect("/?enterpriseOauth=failed");
        return true;
      }
      options.store.upsertUserConnectorAuthorization({
        connectorId,
        userId: session.userId,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      });
      await stopTenantRuntimes(tenantId);
      redirect("/");
    } catch {
      redirect("/?enterpriseOauth=failed");
    }
    return true;
  }

  const authorizationDelete = path.match(
    /^\/api\/enterprise\/tenants\/([^/]+)\/mcp-connectors\/([^/]+)\/authorization$/,
  );
  if (authorizationDelete && method === "DELETE") {
    const tenantId = authorizationDelete[1]!;
    const connectorId = authorizationDelete[2]!;
    // 成员可撤销;store 侧只删 actor 自己的行,管理员也无法替他人撤销。
    const connector = options.store.getTenantMcpConnector(session.userId, connectorId);
    if (connector.tenantId !== tenantId) throw new EnterpriseError("not_found");
    await stopTenantRuntimes(tenantId);
    options.store.deleteUserConnectorAuthorization(session.userId, connectorId);
    send(response, 200, { ok: true });
    return true;
  }
  return false;
}
