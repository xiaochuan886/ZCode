import type { EnterpriseApiRequest } from "./gateway-types.js";
import type { EnterpriseSession } from "./types.js";
import { EnterpriseError } from "./types.js";
import { isTenantMcpEndpointAllowed, isTenantMcpSecretRef } from "./mcp-policy.js";

function optionalText(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new EnterpriseError("validation");
  return value.trim();
}

export async function handleCustomerApiRequest(
  dependencies: EnterpriseApiRequest,
  session: EnterpriseSession,
): Promise<boolean> {
  const {
    options,
    request,
    response,
    url,
    path,
    method,
    closeSockets,
    stopRuntime,
    ensureRuntime,
  } = dependencies;
  const { send, jsonBody, str, relayOrigin, publicCustomer } = dependencies.helpers;

  if (path === "/api/enterprise/customers" && method === "GET") {
    send(
      response,
      200,
      options.store
        .listCustomers(session.userId, str(url.searchParams.get("tenantId")))
        .map(publicCustomer),
    );
    return true;
  }
  if (path === "/api/enterprise/customers" && method === "POST") {
    const body = await jsonBody(request);
    const metadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    const customer = await options.store.createCustomer(session.userId, str(body.tenantId), {
      name: str(body.name),
      type: optionalText(body.type),
      metadata,
    });
    send(response, 201, publicCustomer(customer));
    return true;
  }
  const customerMatch = path.match(/^\/api\/enterprise\/customers\/([^/]+)$/);
  if (customerMatch && method === "PATCH") {
    const body = await jsonBody(request);
    const current = options.store.getCustomer(session.userId, customerMatch[1]!);
    const metadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : current.metadata;
    send(
      response,
      200,
      publicCustomer(
        options.store.updateCustomer(session.userId, customerMatch[1]!, {
          name: str(body.name),
          type: optionalText(body.type),
          metadata,
        }),
      ),
    );
    return true;
  }
  const customerActivate = path.match(/^\/api\/enterprise\/customers\/([^/]+)\/activate$/);
  if (customerActivate && method === "POST") {
    const customer = options.store.getCustomer(session.userId, customerActivate[1]!);
    const target = options.store.getCustomerRuntimeTarget(session.userId, customer.id);
    const activeTarget = options.store.getActiveRuntimeTarget(session.id);
    const sameTarget = activeTarget?.runtimeId === target.runtimeId;
    if (!sameTarget) {
      closeSockets(session.id);
      // 目标切换时先清理目标的旧运行时，确保权限、Skill 和 MCP 物化从可信存储重新开始。
      await stopRuntime(target);
    }
    await ensureRuntime(target, session.userId, relayOrigin(request, options));
    options.store.activateCustomer(session.id, customer.id);
    if (!sameTarget) {
      // 启动等待期间旧 Customer 的并行握手仍可能通过检查；提交新绑定后再次关闭。
      closeSockets(session.id);
    }
    send(response, 200, publicCustomer(customer));
    return true;
  }
  const customerSkills = path.match(/^\/api\/enterprise\/customers\/([^/]+)\/skills$/);
  if (customerSkills && method === "GET") {
    send(response, 200, options.store.listSkillsForCustomer(session.userId, customerSkills[1]!));
    return true;
  }
  if (customerSkills && method === "POST") {
    const customer = options.store.getCustomer(session.userId, customerSkills[1]!);
    const body = await jsonBody(request);
    await stopRuntime(options.store.getCustomerRuntimeTarget(session.userId, customer.id));
    send(
      response,
      201,
      options.store.createCustomerSkill(session.userId, customer.id, {
        name: str(body.name),
        content: str(body.content),
      }),
    );
    return true;
  }
  const customerMcp = path.match(/^\/api\/enterprise\/customers\/([^/]+)\/mcp-bindings$/);
  if (customerMcp && method === "GET") {
    send(response, 200, options.store.listMcpBindingsForCustomer(session.userId, customerMcp[1]!));
    return true;
  }
  if (customerMcp && method === "POST") {
    const customer = options.store.getCustomer(session.userId, customerMcp[1]!);
    if (options.store.getMembership(session.userId, customer.tenantId).role !== "admin")
      throw new EnterpriseError("forbidden");
    const body = await jsonBody(request);
    const secretRef = body.secretRef == null ? null : str(body.secretRef);
    if (secretRef && !isTenantMcpSecretRef(secretRef, customer.tenantId))
      throw new EnterpriseError("validation");
    const endpoint = str(body.endpoint);
    if (!isTenantMcpEndpointAllowed(customer.tenantId, endpoint))
      throw new EnterpriseError("validation");
    await stopRuntime(options.store.getCustomerRuntimeTarget(session.userId, customer.id));
    send(
      response,
      201,
      options.store.createCustomerMcpBinding(session.userId, customer.id, {
        name: str(body.name),
        endpoint,
        secretRef,
      }),
    );
    return true;
  }
  return false;
}
