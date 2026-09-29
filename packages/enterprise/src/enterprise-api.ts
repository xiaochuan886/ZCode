import type { EnterpriseCase } from "./types.js";
import { EnterpriseAuth } from "./auth.js";
import { EnterpriseError } from "./types.js";
import type { EnterpriseApiRequest } from "./gateway-types.js";
import { readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export async function handleEnterpriseApiRequest(
  dependencies: EnterpriseApiRequest,
): Promise<void> {
  const {
    options,
    request,
    response,
    url,
    path,
    method,
    closeSockets,
    closeUserSockets,
    stopRuntime,
    ensureRuntime,
  } = dependencies;
  const { cookies, send, jsonBody, str, origin, relayOrigin, publicCase, runtimeCasesInSpaces } =
    dependencies.helpers;
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
        "enterprise_csrf=; Path=/; Max-Age=0; SameSite=Strict",
      ]);
      send(response, 200, { ok: true });
      return;
    }
    if (path === "/api/enterprise/spaces" && method === "GET") {
      send(
        response,
        200,
        options.store.listServiceSpaces(session.userId, str(url.searchParams.get("tenantId"))),
      );
      return;
    }
    if (path === "/api/enterprise/spaces" && method === "POST") {
      const body = await jsonBody(request);
      send(
        response,
        201,
        options.store.createServiceSpace(session.userId, str(body.tenantId), {
          name: str(body.name),
        }),
      );
      return;
    }
    const spaceMatch = path.match(/^\/api\/enterprise\/spaces\/([^/]+)$/);
    if (spaceMatch && method === "PATCH") {
      const body = await jsonBody(request);
      send(
        response,
        200,
        options.store.updateServiceSpace(session.userId, spaceMatch[1]!, {
          name: str(body.name),
        }),
      );
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
      const affectedSpaces = options.store
        .listServiceSpaces(session.userId, tenantId)
        .map((space) => space.id);
      const affectedCases = runtimeCasesInSpaces(options.store, session.userId, affectedSpaces);
      options.store.removeMembership(session.userId, tenantId, memberUserId);
      closeUserSockets(memberUserId);
      await Promise.all(affectedCases.map((affected) => stopRuntime(affected)));
      send(response, 200, { ok: true });
      return;
    }
    if (path === "/api/enterprise/objects" && method === "GET") {
      send(
        response,
        200,
        options.store.listServiceObjects(
          session.userId,
          str(url.searchParams.get("serviceSpaceId")),
        ),
      );
      return;
    }
    if (path === "/api/enterprise/objects" && method === "POST") {
      const body = await jsonBody(request);
      send(
        response,
        201,
        options.store.createServiceObject(session.userId, str(body.serviceSpaceId), {
          name: str(body.name),
          type: str(body.type),
          metadata:
            body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
              ? (body.metadata as Record<string, unknown>)
              : {},
        }),
      );
      return;
    }
    if (path === "/api/enterprise/cases" && method === "GET") {
      send(
        response,
        200,
        options.store.listCases(session.userId, str(url.searchParams.get("serviceSpaceId"))),
      );
      return;
    }
    if (path === "/api/enterprise/cases" && method === "POST") {
      const body = await jsonBody(request);
      const created = options.store.createCase(session.userId, str(body.serviceObjectId), {
        title: str(body.title),
        category: str(body.category),
        contextSnapshot:
          body.contextSnapshot &&
          typeof body.contextSnapshot === "object" &&
          !Array.isArray(body.contextSnapshot)
            ? (body.contextSnapshot as Record<string, unknown>)
            : {},
      });
      send(response, 201, created);
      return;
    }
    const match = path.match(/^\/api\/enterprise\/cases\/([^/]+)\/(activate|status)$/);
    if (match && match[2] === "activate" && method === "POST") {
      const value = options.store.getCase(session.userId, match[1]!);
      if (value.status === "closed") throw new EnterpriseError("invalid_transition");
      closeSockets(session.id);
      await stopRuntime(value);
      await ensureRuntime(value, session.userId, relayOrigin(request, options));
      options.store.activateCase(session.id, value.id);
      send(response, 200, publicCase(value));
      return;
    }
    if (match && match[2] === "status" && method === "PATCH") {
      const body = await jsonBody(request);
      const value = options.store.transitionCase(
        session.userId,
        match[1]!,
        str(body.status) as EnterpriseCase["status"],
      );
      if (value.status === "closed") await stopRuntime(value);
      send(response, 200, value);
      return;
    }
    const caseAction = path.match(/^\/api\/enterprise\/cases\/([^/]+)\/(skills|session)$/);
    if (caseAction?.[2] === "skills" && method === "GET") {
      send(response, 200, options.store.listSkillsForCase(session.userId, caseAction[1]!));
      return;
    }
    if (caseAction?.[2] === "skills" && method === "POST") {
      const value = options.store.getCase(session.userId, caseAction[1]!);
      const body = await jsonBody(request);
      const serviceSpaceId = body.serviceSpaceId == null ? null : str(body.serviceSpaceId);
      const affectedSpaces = serviceSpaceId
        ? [serviceSpaceId]
        : options.store.listServiceSpaces(session.userId, value.tenantId).map((space) => space.id);
      const affectedCases = runtimeCasesInSpaces(options.store, session.userId, affectedSpaces);
      // Skill 文件属于工作区输入；解析或读取路径前先停止所有可能共享该 Skill 的运行时。
      await Promise.all(affectedCases.map((affected) => stopRuntime(affected)));
      const skillsRoot = await realpath(resolve(value.workspacePath, ".zcode/skills"));
      const source = await realpath(resolve(skillsRoot, str(body.path)));
      const diff = relative(skillsRoot, source);
      if (
        !diff ||
        diff.startsWith("..") ||
        diff.includes(`..${sep}`) ||
        basename(source) !== "SKILL.md"
      )
        throw new EnterpriseError("validation");
      const content = await readFile(source, "utf8");
      if (content.length > 256 * 1024) throw new EnterpriseError("validation");
      send(
        response,
        201,
        options.store.createSkill(session.userId, value.id, {
          name: str(body.name),
          content,
          serviceSpaceId,
        }),
      );
      return;
    }
    if (caseAction?.[2] === "session" && method === "POST") {
      const value = options.store.getCase(session.userId, caseAction[1]!);
      if (options.store.getActiveCase(session.id)?.id !== value.id)
        throw new EnterpriseError("forbidden");
      const body = await jsonBody(request);
      const nativeSessionId = str(body.sessionId);
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(nativeSessionId)) throw new EnterpriseError("validation");
      await ensureRuntime(value, session.userId, relayOrigin(request, options));
      if (!(await options.runtimes.ownsSession(value, nativeSessionId)))
        throw new EnterpriseError("not_found");
      const activeCase = options.store.getActiveCase(session.id);
      if (activeCase?.id !== value.id || activeCase.status === "closed")
        throw new EnterpriseError("forbidden");
      if (value.nativeSessionId === nativeSessionId) {
        send(response, 200, publicCase(value));
        return;
      }
      send(
        response,
        200,
        publicCase(options.store.bindNativeSession(session.userId, value.id, nativeSessionId)),
      );
      return;
    }
    if (path === "/api/enterprise/mcp-bindings" && method === "POST") {
      const body = await jsonBody(request);
      const tenantId = str(body.tenantId);
      if (options.store.getMembership(session.userId, tenantId).role !== "admin")
        throw new EnterpriseError("forbidden");
      const availableSpaces = options.store.listServiceSpaces(session.userId, tenantId);
      const serviceSpaceId = body.serviceSpaceId == null ? null : str(body.serviceSpaceId);
      if (serviceSpaceId && !availableSpaces.some((space) => space.id === serviceSpaceId))
        throw new EnterpriseError("not_found");
      const affectedSpaces = serviceSpaceId
        ? [serviceSpaceId]
        : availableSpaces.map((space) => space.id);
      const affectedCases = runtimeCasesInSpaces(options.store, session.userId, affectedSpaces);
      const secretRef = body.secretRef == null ? null : str(body.secretRef);
      if (secretRef && !/^ZCODE_ENTERPRISE_MCP_SECRET_[A-Z0-9_]{1,100}$/.test(secretRef))
        throw new EnterpriseError("validation");
      const endpoint = str(body.endpoint);
      if (!endpoint.startsWith("https://")) throw new EnterpriseError("validation");
      // 已运行的 Case 容器可能仍持有旧 MCP 凭据；修改绑定前先停止受影响的运行时。
      await Promise.all(affectedCases.map((affected) => stopRuntime(affected)));
      send(
        response,
        201,
        options.store.createMcpBinding(session.userId, tenantId, {
          name: str(body.name),
          endpoint,
          secretRef,
          serviceSpaceId,
        }),
      );
      return;
    }
    if (path === "/api/enterprise/mcp-bindings" && method === "GET") {
      const tenantId = str(url.searchParams.get("tenantId"));
      options.store.getMembership(session.userId, tenantId);
      send(
        response,
        200,
        options.store.listMcpBindings(
          session.userId,
          tenantId,
          url.searchParams.get("serviceSpaceId") ?? undefined,
        ),
      );
      return;
    }
    send(response, 404, { error: "Not found" });
    return;
  }
}
