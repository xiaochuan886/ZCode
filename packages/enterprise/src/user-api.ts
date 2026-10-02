import { EnterpriseAuth } from "./auth.js";
import type { EnterpriseApiRequest } from "./gateway-types.js";
import type { EnterpriseSession, Role, UserStatus } from "./types.js";
import { EnterpriseError } from "./types.js";
import { requireTenantAdmin } from "./admin-guard.js";

function text(value: unknown): string {
  if (typeof value !== "string") throw new EnterpriseError("validation");
  return value;
}

function parseRole(value: unknown): Role {
  const role = text(value);
  if (role !== "admin" && role !== "member") throw new EnterpriseError("validation");
  return role;
}

function parseStatus(value: unknown): UserStatus {
  const status = text(value);
  if (status !== "active" && status !== "disabled") throw new EnterpriseError("validation");
  return status;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new EnterpriseError("validation");
  return value as string[];
}

/** 租户成员管理 API:成员 CRUD、客户可见性授权(替代旧的裸 POST /users 与 members DELETE)。 */
export async function handleUserApiRequest(
  dependencies: EnterpriseApiRequest,
  session: EnterpriseSession,
): Promise<boolean> {
  const { options, request, response, path, method, closeUserSockets, stopRuntime } = dependencies;
  const { send, jsonBody, str, runtimeTargetsForTenant } = dependencies.helpers;
  /** 挂载集合在容器启动时固定:只停受影响成员自己的 runtime,其他专家不受牵连。 */
  const stopMemberRuntimes = async (tenantId: string, memberUserId: string): Promise<void> => {
    const affected = runtimeTargetsForTenant(options.store, session.userId, tenantId).filter(
      (target) => target.userId === memberUserId,
    );
    await Promise.all(affected.map((target) => stopRuntime(target)));
  };

  const userList = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/users$/);
  if (userList && method === "GET") {
    const tenantId = userList[1]!;
    requireTenantAdmin(options, session, tenantId);
    send(response, 200, options.store.listTenantUsers(session.userId, tenantId));
    return true;
  }
  if (userList && method === "POST") {
    const tenantId = userList[1]!;
    requireTenantAdmin(options, session, tenantId);
    const body = await jsonBody(request);
    const email = str(body.email);
    // 密码只在创建全新全局身份时必需;join 语义下已存在的身份沿用自有凭据。
    const passwordHash =
      body.password === undefined
        ? undefined
        : await EnterpriseAuth.hashPassword(text(body.password));
    const created = options.store.createOrJoinTenantUser(session.userId, tenantId, {
      email,
      role: parseRole(body.role),
      ...(passwordHash === undefined ? {} : { passwordHash }),
      ...(body.displayName === undefined ? {} : { displayName: text(body.displayName) }),
    });
    send(response, 201, created);
    return true;
  }
  const userAccess = path.match(
    /^\/api\/enterprise\/tenants\/([^/]+)\/users\/([^/]+)\/customer-access$/,
  );
  if (userAccess && method === "PUT") {
    const tenantId = userAccess[1]!;
    const memberUserId = userAccess[2]!;
    requireTenantAdmin(options, session, tenantId);
    const body = await jsonBody(request);
    const mode = text(body.mode);
    const customerIds = optionalStringArray(body.customerIds);
    const customerAccess = options.store.setUserCustomerAccess(
      session.userId,
      tenantId,
      memberUserId,
      {
        mode: mode as "all" | "selected",
        ...(customerIds === undefined ? {} : { customerIds }),
      },
    );
    // 可见性变化改写挂载集合:停该成员自己的 runtime 即可,stopRuntime 会先销毁
    // 指向它的会话 socket(浏览器自愈重连),无需再显式关 socket。
    await stopMemberRuntimes(tenantId, memberUserId);
    send(response, 200, { ok: true, customerAccess });
    return true;
  }
  const userItem = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/users\/([^/]+)$/);
  if (userItem && method === "PATCH") {
    const tenantId = userItem[1]!;
    const memberUserId = userItem[2]!;
    requireTenantAdmin(options, session, tenantId);
    const body = await jsonBody(request);
    const before = options.store.getTenantUser(session.userId, tenantId, memberUserId);
    const passwordHash =
      body.password === undefined
        ? undefined
        : await EnterpriseAuth.hashPassword(text(body.password));
    const updated = options.store.updateTenantUser(session.userId, tenantId, memberUserId, {
      ...(body.displayName === undefined ? {} : { displayName: text(body.displayName) }),
      ...(body.role === undefined ? {} : { role: parseRole(body.role) }),
      ...(passwordHash === undefined ? {} : { passwordHash }),
      ...(body.status === undefined ? {} : { status: parseStatus(body.status) }),
    });
    const roleChanged = updated.role !== before.role;
    const statusChanged = updated.status !== before.status;
    if (roleChanged || statusChanged) {
      // 角色影响权限、禁用立即吊销访问:先改库(下一次校验即按新状态拒绝),
      // 再销毁该用户全部会话 socket(含未附着 runtime 的),最后停其本租户
      // runtime。仅改名/重置密码不触发任何停机。
      if (updated.status === "disabled" || roleChanged) closeUserSockets(memberUserId);
      await stopMemberRuntimes(tenantId, memberUserId);
    }
    send(response, 200, updated);
    return true;
  }
  if (userItem && method === "DELETE") {
    const tenantId = userItem[1]!;
    const memberUserId = userItem[2]!;
    requireTenantAdmin(options, session, tenantId);
    options.store.removeTenantUser(session.userId, tenantId, memberUserId);
    closeUserSockets(memberUserId);
    await stopMemberRuntimes(tenantId, memberUserId);
    send(response, 200, { ok: true });
    return true;
  }
  return false;
}
