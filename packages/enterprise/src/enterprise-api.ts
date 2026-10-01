import { EnterpriseAuth } from "./auth.js";
import { EnterpriseError } from "./types.js";
import type { EnterpriseApiRequest } from "./gateway-types.js";
import { handleCustomerApiRequest } from "./customer-api.js";
import { handleTenantCatalogApiRequest } from "./tenant-catalog-api.js";

export async function handleEnterpriseApiRequest(
  dependencies: EnterpriseApiRequest,
): Promise<void> {
  const { options, request, response, path, method, closeSockets, closeUserSockets, stopRuntime } =
    dependencies;
  const { cookies, send, jsonBody, str, origin, runtimeTargetsForTenant } = dependencies.helpers;
  if (path.startsWith("/api/enterprise/")) {
    const token = cookies(request).get("enterprise_session");
    const session = token ? options.auth.resolveSession(token) : null;
    if (!session) {
      send(response, 401, { error: "Unauthorized" });
      return;
    }
    if (method !== "GET" && method !== "HEAD")
      options.auth.validateSessionMutation(
        token!,
        request.headers.origin ?? null,
        origin(request, options.expectedOrigin),
        request.headers["x-csrf-token"]?.toString() ?? null,
      );
    if (path === "/api/enterprise/logout" && method === "POST") {
      closeSockets(session.id);
      options.auth.revokeSession(token!);
      response.setHeader("set-cookie", [
        "enterprise_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
        "enterprise_csrf=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
      ]);
      send(response, 200, { ok: true });
      return;
    }
    if (await handleCustomerApiRequest(dependencies, session)) return;
    if (await handleTenantCatalogApiRequest(dependencies, session)) return;
    const tenantSkills = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/skills$/);
    if (tenantSkills && method === "GET") {
      send(response, 200, {
        items: options.store.listTenantSkills(session.userId, tenantSkills[1]!),
      });
      return;
    }
    if (tenantSkills && method === "POST") {
      const tenantId = tenantSkills[1]!;
      if (options.store.getMembership(session.userId, tenantId).role !== "admin")
        throw new EnterpriseError("forbidden");
      const body = await jsonBody(request);
      // 租户 Skill 分发进每个专家 HOME;先停该租户专家 runtime,下次打开时重新物化。
      const affectedTargets = runtimeTargetsForTenant(options.store, session.userId, tenantId);
      await Promise.all(affectedTargets.map((affected) => stopRuntime(affected)));
      send(
        response,
        201,
        options.store.createTenantSkill(session.userId, tenantId, {
          name: str(body.name),
          content: str(body.content),
        }),
      );
      return;
    }
    const tenantSkillItem = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/skills\/([^/]+)$/);
    if (tenantSkillItem && method === "DELETE") {
      const tenantId = tenantSkillItem[1]!;
      if (options.store.getMembership(session.userId, tenantId).role !== "admin")
        throw new EnterpriseError("forbidden");
      const affectedTargets = runtimeTargetsForTenant(options.store, session.userId, tenantId);
      await Promise.all(affectedTargets.map((affected) => stopRuntime(affected)));
      options.store.deleteTenantSkill(session.userId, tenantId, tenantSkillItem[2]!);
      send(response, 200, { ok: true });
      return;
    }
    if (path === "/api/enterprise/users" && method === "POST") {
      const body = await jsonBody(request);
      const role = str(body.role);
      if (role !== "admin" && role !== "member") throw new EnterpriseError("validation");
      const tenantId = str(body.tenantId);
      if (options.store.getMembership(session.userId, tenantId).role !== "admin")
        throw new EnterpriseError("forbidden");
      const passwordHash = await EnterpriseAuth.hashPassword(str(body.password));
      send(
        response,
        201,
        options.store.provisionUser(session.userId, tenantId, {
          email: str(body.email),
          passwordHash,
          role,
          ...(body.displayName == null ? {} : { displayName: str(body.displayName) }),
        }),
      );
      return;
    }
    const memberMatch = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/members\/([^/]+)$/);
    if (memberMatch && method === "DELETE") {
      const tenantId = memberMatch[1]!;
      const memberUserId = memberMatch[2]!;
      if (options.store.getMembership(session.userId, tenantId).role !== "admin")
        throw new EnterpriseError("forbidden");
      const affectedTargets = runtimeTargetsForTenant(options.store, session.userId, tenantId);
      options.store.removeMembership(session.userId, tenantId, memberUserId);
      closeUserSockets(memberUserId);
      await Promise.all(affectedTargets.map((affected) => stopRuntime(affected)));
      send(response, 200, { ok: true });
      return;
    }
    send(response, 404, { error: "Not found" });
    return;
  }
}
