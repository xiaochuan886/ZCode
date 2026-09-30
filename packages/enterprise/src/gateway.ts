import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { EnterpriseStore } from "./store.js";
import { EnterpriseAuth } from "./auth.js";
import { EnterpriseError, type EnterpriseCase, type EnterpriseSession } from "./types.js";
import { nativePathAllowed, proxyHttp } from "./proxy.js";
import { handleEnterpriseApiRequest } from "./enterprise-api.js";
import type { GatewayOptions } from "./gateway-types.js";
import { attachEnterpriseWebSocketHandler } from "./gateway-websocket.js";
import {
  handleMcpRelayRequest,
  McpRelayConcurrencyLimiter,
  type RelayCredential,
} from "./mcp-relay.js";
import { cookies } from "./gateway-cookies.js";
import { prepare } from "./gateway-prepare.js";
import { type EnterpriseModelProvider, type ModelRelayCapability } from "./model-provision.js";
import { handleModelRelayRequest, ModelRelayConcurrencyLimiter } from "./model-relay.js";

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

function relayOrigin(request: IncomingMessage, options: GatewayOptions): string {
  const value =
    options.relayOrigin ?? options.expectedOrigin ?? origin(request, options.expectedOrigin);
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

function sessionFor(request: IncomingMessage, auth: EnterpriseAuth): EnterpriseSession | null {
  const token = cookies(request).get("enterprise_session");
  return token ? auth.resolveSession(token) : null;
}

function publicCase(value: EnterpriseCase) {
  return {
    id: value.id,
    title: value.title,
    category: value.category,
    status: value.status,
    serviceSpaceId: value.serviceSpaceId,
    workspacePath: value.workspacePath,
    sessionId: value.nativeSessionId ?? undefined,
    serviceObject: {
      id: value.serviceObjectId,
      name: value.objectSnapshot.name,
      type: value.objectSnapshot.type,
    },
  };
}

function runtimeCasesInSpaces(
  store: EnterpriseStore,
  actorId: string,
  serviceSpaceIds: string[],
): EnterpriseCase[] {
  return serviceSpaceIds.flatMap((serviceSpaceId) => store.listCases(actorId, serviceSpaceId));
}

export function createEnterpriseGateway(options: GatewayOptions) {
  const sockets = new Map<string, Set<Duplex>>();
  const socketUsers = new Map<string, string>();
  const relayCredentials = new Map<string, Map<string, RelayCredential>>();
  const modelRelayCapabilities = new Map<
    string,
    Map<EnterpriseModelProvider, ModelRelayCapability>
  >();
  const relayLimiter = new McpRelayConcurrencyLimiter();
  const modelRelayLimiter = new ModelRelayConcurrencyLimiter();
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
  const stopRuntime = (value: EnterpriseCase) =>
    options.runtimes.stop(value, () => {
      relayCredentials.delete(value.id);
      modelRelayCapabilities.delete(value.id);
    });
  const ensureRuntime = async (value: EnterpriseCase, userId: string, requestOrigin: string) => {
    try {
      return await options.runtimes.ensure(value, {
        beforeStop: () => {
          relayCredentials.delete(value.id);
          modelRelayCapabilities.delete(value.id);
        },
        beforeStart: async () => {
          relayCredentials.delete(value.id);
          modelRelayCapabilities.delete(value.id);
          await prepare(
            value,
            options.store,
            userId,
            requestOrigin,
            relayCredentials,
            options.modelRuntimeDataRoot,
            modelRelayCapabilities,
          );
        },
      });
    } catch (error) {
      relayCredentials.delete(value.id);
      modelRelayCapabilities.delete(value.id);
      throw error;
    }
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
            activeCase: null,
            csrfToken: "",
          });
          return;
        }
        const user = options.store.getUser(session.userId);
        const tenants = options.store.listTenantsForUser(session.userId).map((tenant) => ({
          ...tenant,
          role: options.store.getMembership(session.userId, tenant.id).role,
        }));
        const activeCase = options.store.getActiveCase(session.id);
        send(response, 200, {
          enabled: true,
          user: user ? { id: user.id, email: user.email, displayName: user.displayName } : null,
          tenants,
          activeCase: activeCase ? publicCase(activeCase) : null,
          csrfToken: cookies(request).get("enterprise_csrf") ?? null,
        });
        return;
      }
      if (
        await handleModelRelayRequest(
          path,
          request,
          response,
          modelRelayCapabilities,
          ({ caseId, actorId }) => {
            try {
              const value = options.store.getCase(actorId, caseId);
              return value.status !== "closed";
            } catch {
              return false;
            }
          },
          ({ caseId, actorId, providerFamily }) => {
            try {
              const value = options.store.getCase(actorId, caseId);
              return options.store.getModelCredentialForGateway(value.tenantId, providerFamily)
                .apiKey;
            } catch {
              return null;
            }
          },
          options.fetchImpl ?? fetch,
          modelRelayLimiter,
        )
      )
        return;
      if (
        await handleMcpRelayRequest(
          path,
          request,
          response,
          options.store,
          relayCredentials,
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
            publicCase,
            runtimeCasesInSpaces,
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
        const value = options.store.getActiveCase(session.id);
        if (!value || value.status === "closed") {
          send(response, 403, { error: "Active Case required" });
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
        const binding = await ensureRuntime(value, session.userId, relayOrigin(request, options));
        if (!options.auth.resolveSession(cookies(request).get("enterprise_session") ?? "")) {
          send(response, 401, { error: "Unauthorized" });
          return;
        }
        const activeCase = options.store.getActiveCase(session.id);
        if (activeCase?.id !== value.id || activeCase.status === "closed") {
          send(response, 403, { error: "Active Case changed" });
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
    helpers: { cookies, origin, relayOrigin, sessionFor },
  });

  return {
    server,
    listen: () =>
      new Promise<void>((done) =>
        server.listen(options.port ?? 3031, options.host ?? "127.0.0.1", done),
      ),
    close: async () => {
      for (const id of sockets.keys()) closeSockets(id);
      relayCredentials.clear();
      modelRelayCapabilities.clear();
      try {
        await options.runtimes.stopAll();
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  };
}
