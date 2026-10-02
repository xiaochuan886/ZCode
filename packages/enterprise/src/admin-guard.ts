import type { EnterpriseApiRequest } from "./gateway-types.js";
import { EnterpriseError, type EnterpriseSession } from "./types.js";

/**
 * 设置面路由的统一管理员守卫:企业设置为管理员专属页面,
 * 成员对设置面的读写(含只读列表)一律 403。
 */
export function requireTenantAdmin(
  options: Pick<EnterpriseApiRequest["options"], "store">,
  session: EnterpriseSession,
  tenantId: string,
): void {
  if (options.store.getMembership(session.userId, tenantId).role !== "admin")
    throw new EnterpriseError("forbidden");
}
