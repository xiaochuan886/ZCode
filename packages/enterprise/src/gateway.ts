import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { EnterpriseAuth } from "./auth.js";
import { EnterpriseError, type EnterpriseRuntimeTarget, type EnterpriseSession } from "./types.js";
import { nativePathAllowed, proxyHttp } from "./proxy.js";
import { handleEnterpriseApiRequest } from "./enterprise-api.js";
import type { GatewayOptions } from "./gateway-types.js";
import { attachEnterpriseWebSocketHandler } from "./gateway-websocket.js";
import { handleMcpRelayRequest, McpRelayConcurrencyLimiter } from "./mcp-relay.js";
import { cookies } from "./gateway-cookies.js";
import { prepareExpertRuntime } from "./gateway-prepare.js";
import { publicCustomer, runtimeTargetsForTenant } from "./gateway-runtime.js";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1024 * 1024) throw new EnterpriseError("validation");
  }
  const parsed: unknown = JSON.parse(body || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new EnterpriseError("validation");
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new EnterpriseError("validation");
  return value.trim();
}

function origin(request: IncomingMessage, configured?: string): string {
  return configured ?? `http://${request.headers.host ?? "localhost"}`;
}

function validatedOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new EnterpriseError("validation");
  return parsed.origin;
}

function relayOrigin(request: IncomingMessage, options: GatewayOptions): string {
  return validatedOrigin(
    options.relayOrigin ?? options.expectedOrigin ?? origin(request, options.expectedOrigin),
  );
}

function sessionFor(request: IncomingMessage, auth: EnterpriseAuth): EnterpriseSession | null {
  const token = cookies(request).get("enterprise_session");
  return token ? auth.resolveSession(token) : null;
}

export function createEnterpriseGateway(options: GatewayOptions) {
  const sockets = new Map<string, Set<Duplex>>();
  const socketUsers = new Map<string, string>();
  const relayLimiter = new McpRelayConcurrencyLimiter();
  const closeSockets = (sessionId: string) => {
    for (const socket of sockets.get(sessionId) ?? []) socket.destroy();
    sockets.delete(sessionId);
    socketUsers.delete(sessionId);
  };
  const closeUserSockets = (userId: string) => {
    for (const [sessionId, socketUserId] of socketUsers) {
      if (socketUserId === userId) closeSockets(sessionId);
    }
  };
  const stopRuntime = (value: EnterpriseRuntimeTarget) =>
    options.runtimes.stop(value, () => {
      // 停掉专家 runtime 前同步销毁指向它的会话 socket:半开 socket 上的 RPC 永远没有
      // 响应,浏览器侧表现为技能面板停在"搜索中"、命令/子智能体为空。销毁后壳层的
      // onClose 重连会拉起新 runtime 并重新分发,而不是挂在死连接上。
      for (const [sessionId] of sockets) {
        const active = options.store.getActiveRuntimeTarget(sessionId);
        if (active?.runtimeId === value.runtimeId) closeSockets(sessionId);
      }
    });
  /** 兜底中继地址:无 operator 配置且无触发请求 origin 时按监听地址推导。 */
  const fallbackOrigin = (): string => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : (options.port ?? 3031);
    return `http://${options.host ?? "127.0.0.1"}:${port}`;
  };
  /** 补齐专家目标的挂载清单:该租户全部客户工作区都会挂进这个 runtime。 */
  const expertTargetWithWorkspaces = (value: EnterpriseRuntimeTarget): EnterpriseRuntimeTarget => {
    const customers = options.store.listCustomers(value.userId, value.tenantId);
    return {
      ...value,
      workspacePath: value.workspacePath || customers[0]?.workspacePath || "",
      workspacePaths: customers.map((customer) => customer.workspacePath),
    };
  };
  const ensureRuntime = async (
    rawValue: EnterpriseRuntimeTarget,
    userId?: string,
    requestOrigin?: string,
  ) => {
    const value = expertTargetWithWorkspaces(rawValue);
    // 专家 runtime 准备:供应商目录 + 租户共享 Skill + 系统连接器下发到专家数据卷。
    // workspacePaths 同时提供挂载清单,让容器把租户全部客户工作区挂进来。
    return await options.runtimes.ensure(value, {
      beforeStart: async () => {
        await prepareExpertRuntime({
          target: value,
          store: options.store,
          runtimeDataRoot: options.modelRuntimeDataRoot,
          // 中继地址优先用 operator 配置;否则取触发请求的 origin(两个调用方都有请求)。
          relayOrigin: validatedOrigin(
            options.relayOrigin ?? options.expectedOrigin ?? requestOrigin ?? fallbackOrigin(),
          ),
        });
      },
    });
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin(request, options.expectedOrigin));
      const path = url.pathname;
      const method = request.method ?? "GET";
      if (path === "/api/enterprise/login" && method === "POST") {
        if (request.headers.origin !== origin(request, options.expectedOrigin)) {
          send(response, 403, { error: "Forbidden" });
          return;
        }
        const body = await jsonBody(request);
        const result = await options.auth.login(str(body.email), str(body.password));
        const secure = origin(request, options.expectedOrigin).startsWith("https:")
          ? "; Secure"
          : "";
        response.setHeader("set-cookie", [
          `enterprise_session=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Strict${secure}`,
          `enterprise_csrf=${encodeURIComponent(result.csrfToken)}; Path=/; SameSite=Strict${secure}`,
        ]);
        send(response, 200, { ok: true });
        return;
      }
      if (path === "/api/enterprise/bootstrap" && method === "GET") {
        const session = sessionFor(request, options.auth);
        if (!session) {
          send(response, 200, {
            enabled: true,
            user: null,
            tenants: [],
            activeCustomer: null,
            csrfToken: "",
          });
          return;
        }
        const user = options.store.getUser(session.userId);
        const tenants = options.store.listTenantsForUser(session.userId).map((tenant) => ({
          ...tenant,
          role: options.store.getMembership(session.userId, tenant.id).role,
        }));
        const activeCustomer = options.store.getActiveCustomer(session.id);
        send(response, 200, {
          enabled: true,
          user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null,
          tenants,
          activeCustomer: activeCustomer ? publicCustomer(activeCustomer) : null,
          csrfToken: cookies(request).get("enterprise_csrf") ?? null,
        });
        return;
      }
      if (
        await handleMcpRelayRequest(
          path,
          request,
          response,
          options.store,
          options.fetchImpl ?? fetch,
          options.mcpDnsLookup,
          relayLimiter,
        )
      )
        return;
      if (path.startsWith("/api/enterprise/")) {
        await handleEnterpriseApiRequest({
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
          helpers: {
            cookies,
            send,
            jsonBody,
            str,
            origin,
            relayOrigin,
            publicCustomer,
            runtimeTargetsForTenant,
          },
        });
        return;
      }
      if (!nativePathAllowed(path)) {
        send(response, 403, { error: "Forbidden" });
        return;
      }
      if (path.startsWith("/api/")) {
        const session = sessionFor(request, options.auth);
        if (!session) {
          send(response, 401, { error: "Unauthorized" });
          return;
        }
        const value = options.store.getActiveRuntimeTarget(session.id);
        if (!value) {
          send(response, 403, { error: "Active customer required" });
          return;
        }
        if (method !== "GET" && method !== "HEAD") {
          const token = cookies(request).get("enterprise_session")!;
          options.auth.validateSessionMutation(
            token,
            request.headers.origin ?? null,
            origin(request, options.expectedOrigin),
            request.headers["x-csrf-token"]?.toString() ?? null,
          );
        }
        const binding = await ensureRuntime(
          value,
          session.userId,
          origin(request, options.expectedOrigin),
        );
        if (!options.auth.resolveSession(cookies(request).get("enterprise_session") ?? "")) {
          send(response, 401, { error: "Unauthorized" });
          return;
        }
        await proxyHttp(request, response, binding);
        return;
      }
      const file = resolve(options.staticRoot, path === "/" ? "index.html" : `.${path}`);
      const diff = relative(resolve(options.staticRoot), file);
      if (diff.startsWith("..") || diff.includes(`..${sep}`)) {
        send(response, 404, { error: "Not found" });
        return;
      }
      const candidate = await stat(file)
        .then((info) => (info.isFile() ? file : resolve(options.staticRoot, "index.html")))
        .catch(() => resolve(options.staticRoot, "index.html"));
      response.writeHead(200, {
        "content-type": mime[extname(candidate)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(await readFile(candidate));
    } catch (error) {
      const status =
        error instanceof EnterpriseError
          ? error.code === "not_found"
            ? 404
            : error.code === "forbidden"
              ? 403
              : error.code === "invalid_credentials"
                ? 401
                : error.code === "conflict"
                  ? 409
                  : 400
          : 503;
      send(response, status, {
        error:
          status === 503
            ? "Service unavailable"
            : error instanceof Error
              ? error.message
              : "Invalid request",
      });
    }
  });

  attachEnterpriseWebSocketHandler({
    server,
    options,
    sockets,
    socketUsers,
    ensureRuntime,
    helpers: { cookies, origin, sessionFor },
  });

  return {
    server,
    listen: () =>
      new Promise<void>((done) =>
        server.listen(options.port ?? 3031, options.host ?? "127.0.0.1", done),
      ),
    close: async () => {
      for (const id of sockets.keys()) closeSockets(id);
      try {
        await options.runtimes.stopAll();
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  };
}
