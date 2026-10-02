import { rm } from "node:fs/promises";
import type { EnterpriseApiRequest } from "./gateway-types.js";
import type { EnterpriseSession } from "./types.js";
import { EnterpriseError } from "./types.js";
import { requireTenantAdmin } from "./admin-guard.js";
import { isTenantMcpEndpointAllowed, isTenantMcpSecretRef } from "./mcp-policy.js";
import { materializeCustomer } from "./gateway-prepare.js";

function optionalText(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new EnterpriseError("validation");
  return value.trim();
}

export async function handleCustomerApiRequest(
  dependencies: EnterpriseApiRequest,
  session: EnterpriseSession,
): Promise<boolean> {
  const { options, request, response, url, path, method, stopRuntime } = dependencies;
  const { send, jsonBody, str, relayOrigin, publicCustomer, runtimeTargetsForTenant } =
    dependencies.helpers;

  if (path === "/api/enterprise/customers" && method === "GET") {
    // 可见性(allowlist):成员只看到授权客户;管理员恒为全部(授权对其无效)。
    const tenantId = str(url.searchParams.get("tenantId"));
    const visible = new Set(options.store.visibleCustomerIdsFor(session.userId, tenantId));
    send(
      response,
      200,
      options.store
        .listCustomers(session.userId, tenantId)
        .filter((customer) => visible.has(customer.id))
        .map(publicCustomer),
    );
    return true;
  }
  if (path === "/api/enterprise/customers" && method === "POST") {
    // 客户目录是管理员资产:创建/更新/删除仅租户管理员可操作。
    const body = await jsonBody(request);
    const tenantId = str(body.tenantId);
    requireTenantAdmin(options, session, tenantId);
    const metadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    const customer = await options.store.createCustomer(session.userId, tenantId, {
      name: str(body.name),
      type: optionalText(body.type),
      metadata,
    });
    // 挂载在容器启动时固定:新客户要进专家 runtime 必须先停再由下次连接重建。
    const affected = runtimeTargetsForTenant(options.store, session.userId, tenantId);
    await Promise.all(affected.map((target) => stopRuntime(target)));
    await materializeCustomer(
      customer,
      options.store,
      session.userId,
      relayOrigin(request, options),
    );
    send(response, 201, publicCustomer(customer));
    return true;
  }
  const customerMatch = path.match(/^\/api\/enterprise\/customers\/([^/]+)$/);
  if (customerMatch && method === "PATCH") {
    const current = options.store.getCustomer(session.userId, customerMatch[1]!);
    requireTenantAdmin(options, session, current.tenantId);
    const body = await jsonBody(request);
    const metadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : current.metadata;
    const updated = options.store.updateCustomer(session.userId, customerMatch[1]!, {
      name: str(body.name),
      type: optionalText(body.type),
      metadata,
    });
    const affected = runtimeTargetsForTenant(options.store, session.userId, current.tenantId);
    await Promise.all(affected.map((target) => stopRuntime(target)));
    await materializeCustomer(
      updated,
      options.store,
      session.userId,
      relayOrigin(request, options),
    );
    send(response, 200, publicCustomer(updated));
    return true;
  }
  if (customerMatch && method === "DELETE") {
    const current = options.store.getCustomer(session.userId, customerMatch[1]!);
    requireTenantAdmin(options, session, current.tenantId);
    const affected = runtimeTargetsForTenant(options.store, session.userId, current.tenantId);
    await Promise.all(affected.map((target) => stopRuntime(target)));
    const { workspacePath } = options.store.deleteCustomer(session.userId, current.id);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    send(response, 200, { ok: true });
    return true;
  }
  const customerActivate = path.match(/^\/api\/enterprise\/customers\/([^/]+)\/activate$/);
  if (customerActivate && method === "POST") {
    const customer = options.store.getCustomer(session.userId, customerActivate[1]!);
    // 成员激活不可见客户与"不存在"同响应(404),不泄露租户客户目录。
    if (
      !options.store.visibleCustomerIdsFor(session.userId, customer.tenantId).includes(customer.id)
    )
      throw new EnterpriseError("not_found");
    // 激活只记账(下次 bootstrap 打开哪个客户的工作区);专家 runtime 与 socket
    // 都不重建——切换客户是原生工作区 tab 切换。
    options.store.activateCustomer(session.id, customer.id);
    send(response, 200, publicCustomer(customer));
    return true;
  }
  const customerSkills = path.match(/^\/api\/enterprise\/customers\/([^/]+)\/skills$/);
  if (customerSkills && method === "GET") {
    // 设置面只读接口:企业设置为管理员专属(列表仅供设置页使用)。
    const customer = options.store.getCustomer(session.userId, customerSkills[1]!);
    requireTenantAdmin(options, session, customer.tenantId);
    send(response, 200, options.store.listSkillsForCustomer(session.userId, customer.id));
    return true;
  }
  if (customerSkills && method === "POST") {
    const customer = options.store.getCustomer(session.userId, customerSkills[1]!);
    requireTenantAdmin(options, session, customer.tenantId);
    const body = await jsonBody(request);
    options.store.createCustomerSkill(session.userId, customer.id, {
      name: str(body.name),
      content: str(body.content),
    });
    const affected = runtimeTargetsForTenant(options.store, session.userId, customer.tenantId);
    await Promise.all(affected.map((target) => stopRuntime(target)));
    await materializeCustomer(
      customer,
      options.store,
      session.userId,
      relayOrigin(request, options),
    );
    send(response, 201, { ok: true });
    return true;
  }
  const customerMcp = path.match(/^\/api\/enterprise\/customers\/([^/]+)\/mcp-bindings$/);
  if (customerMcp && method === "GET") {
    // 设置面只读接口:管理员专属;令牌只留在服务端,浏览器拿到的是脱敏投影。
    const customer = options.store.getCustomer(session.userId, customerMcp[1]!);
    requireTenantAdmin(options, session, customer.tenantId);
    send(response, 200, {
      items: options.store
        .listMcpBindingsForCustomer(session.userId, customer.id)
        .map(({ token: _token, ...binding }) => binding),
    });
    return true;
  }
  if (customerMcp && method === "POST") {
    const customer = options.store.getCustomer(session.userId, customerMcp[1]!);
    requireTenantAdmin(options, session, customer.tenantId);
    const body = await jsonBody(request);
    const secretRef = body.secretRef == null ? null : str(body.secretRef);
    if (secretRef && !isTenantMcpSecretRef(secretRef, customer.tenantId))
      throw new EnterpriseError("validation");
    const endpoint = str(body.endpoint);
    if (!isTenantMcpEndpointAllowed(customer.tenantId, endpoint))
      throw new EnterpriseError("validation");
    options.store.createCustomerMcpBinding(session.userId, customer.id, {
      name: str(body.name),
      endpoint,
      secretRef,
    });
    const affected = runtimeTargetsForTenant(options.store, session.userId, customer.tenantId);
    await Promise.all(affected.map((target) => stopRuntime(target)));
    await materializeCustomer(
      customer,
      options.store,
      session.userId,
      relayOrigin(request, options),
    );
    send(response, 201, { ok: true });
    return true;
  }
  return false;
}
