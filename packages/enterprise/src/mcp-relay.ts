import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, buildConnector } from "undici";
import { writeAsyncIterableBackpressured } from "./backpressure.js";
import {
  isTenantMcpEndpointAllowed,
  isTenantMcpSecretRef,
  resolvePublicMcpAddress,
  type McpDnsLookup,
  systemMcpDnsLookup,
} from "./mcp-policy.js";
import type { EnterpriseStore } from "./store.js";

export type RelayCredential = { token: string; actorId: string };
const maxConcurrentRelays = 32;
const upstreamHeaderTimeoutMs = 15_000;
const dnsResolveTimeoutMs = 5_000;

export class McpRelayConcurrencyLimiter {
  private active = 0;

  acquire(): (() => void) | null {
    if (this.active >= maxConcurrentRelays) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  const match = typeof value === "string" ? value.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/) : null;
  return match?.[1] ?? null;
}

function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function proxyMcpRelay(
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: string,
  secret: string | undefined,
  fetchImpl: typeof fetch,
  agent: Agent,
): Promise<void> {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "cookie",
    "authorization",
    "content-length",
  ]);
  for (const token of (request.headers.connection ?? "").toString().split(",")) {
    if (token.trim()) blocked.add(token.trim().toLowerCase());
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!value || blocked.has(key) || key === "forwarded" || key.startsWith("x-forwarded-"))
      continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (secret) headers.authorization = `Bearer ${secret}`;

  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : request;
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const headerTimeout = setTimeout(() => controller.abort(), upstreamHeaderTimeoutMs);
  try {
    const upstream = await fetchImpl(endpoint, {
      method,
      headers,
      body,
      duplex: body ? "half" : undefined,
      redirect: "manual",
      signal: controller.signal,
      dispatcher: agent,
    } as RequestInit & { dispatcher: Agent });
    clearTimeout(headerTimeout);
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      send(response, 502, { error: "MCP redirects are not supported" });
      return;
    }
    response.statusCode = upstream.status;
    for (const [key, value] of upstream.headers) {
      if (
        [
          "connection",
          "keep-alive",
          "proxy-authenticate",
          "proxy-authorization",
          "proxy-connection",
          "te",
          "trailer",
          "transfer-encoding",
          "upgrade",
          "set-cookie",
          "location",
          "content-encoding",
        ].includes(key)
      )
        continue;
      response.setHeader(key, value);
    }
    if (upstream.body) {
      const completed = await writeAsyncIterableBackpressured(
        upstream.body,
        response,
        controller.signal,
      );
      if (!completed) {
        if (!response.destroyed) response.destroy();
        return;
      }
    }
    if (!response.destroyed) response.end();
  } catch {
    if (!response.headersSent) send(response, 503, { error: "MCP service unavailable" });
    else response.destroy();
  } finally {
    clearTimeout(headerTimeout);
  }
}

function pinnedAgent(endpoint: URL, address: { address: string; family: number }): Agent {
  const connector = buildConnector({ timeout: upstreamHeaderTimeoutMs });
  const pinnedConnector: buildConnector.connector = (options, callback) =>
    connector(
      {
        ...options,
        hostname: address.address,
        host: address.address,
        servername: endpoint.hostname,
      },
      callback,
    );
  return new Agent({
    connect: pinnedConnector,
    connections: 1,
    pipelining: 0,
    headersTimeout: upstreamHeaderTimeoutMs,
    bodyTimeout: 0,
  });
}

async function resolveWithTimeout(
  hostname: string,
  dnsLookup: McpDnsLookup,
): Promise<{ address: string; family: number }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolvePublicMcpAddress(hostname, dnsLookup),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MCP DNS lookup timed out")),
          dnsResolveTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function handleMcpRelayRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: EnterpriseStore,
  relayCredentials: Map<string, Map<string, RelayCredential>>,
  fetchImpl: typeof fetch = fetch,
  dnsLookup: McpDnsLookup = systemMcpDnsLookup,
  limiter = new McpRelayConcurrencyLimiter(),
): Promise<boolean> {
  const match = path.match(/^\/api\/enterprise\/mcp-relay\/([^/]+)\/([^/]+)$/);
  if (!match) return false;
  const method = request.method ?? "GET";
  if (!["GET", "POST", "DELETE"].includes(method)) {
    send(response, 405, { error: "Method not allowed" });
    return true;
  }
  let caseId: string;
  let bindingId: string;
  try {
    caseId = decodeURIComponent(match[1]!);
    bindingId = decodeURIComponent(match[2]!);
  } catch {
    send(response, 404, { error: "Not found" });
    return true;
  }
  const credential = relayCredentials.get(caseId)?.get(bindingId);
  const provided = bearerToken(request);
  if (!credential || !provided || !constantTimeTokenMatch(credential.token, provided)) {
    send(response, 401, { error: "Unauthorized" });
    return true;
  }
  let target: ReturnType<EnterpriseStore["getCustomerRuntimeTarget"]>;
  try {
    target = store.getCustomerRuntimeTarget(credential.actorId, caseId);
  } catch {
    send(response, 404, { error: "Not found" });
    return true;
  }
  const binding = store
    .listMcpBindingsForCustomer(credential.actorId, target.id)
    .find((candidate) => candidate.id === bindingId);
  if (!binding) {
    send(response, 404, { error: "Not found" });
    return true;
  }
  if (binding.tenantId !== target.tenantId) {
    send(response, 404, { error: "Not found" });
    return true;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(binding.endpoint);
  } catch {
    send(response, 503, { error: "MCP service unavailable" });
    return true;
  }
  if (
    !isTenantMcpEndpointAllowed(target.tenantId, endpoint.toString()) ||
    endpoint.username ||
    endpoint.password
  ) {
    send(response, 503, { error: "MCP service unavailable" });
    return true;
  }
  let secret: string | undefined;
  if (binding.secretRef) {
    if (!isTenantMcpSecretRef(binding.secretRef, target.tenantId)) {
      process.emitWarning(`MCP binding ${binding.id} unavailable: secret reference is invalid.`, {
        code: "ZCODE_ENTERPRISE_MCP_SECRET_INVALID",
      });
      send(response, 503, { error: "MCP credential unavailable" });
      return true;
    }
    secret = process.env[binding.secretRef];
    if (!secret) {
      process.emitWarning(`MCP binding ${binding.id} unavailable: configured secret is missing.`, {
        code: "ZCODE_ENTERPRISE_MCP_SECRET_MISSING",
      });
      send(response, 503, { error: "MCP credential unavailable" });
      return true;
    }
  }
  const release = limiter.acquire();
  if (!release) {
    send(response, 503, { error: "MCP relay capacity reached" });
    return true;
  }
  let agent: Agent | null = null;
  try {
    const address = await resolveWithTimeout(endpoint.hostname, dnsLookup);
    agent = pinnedAgent(endpoint, address);
    await proxyMcpRelay(request, response, endpoint.toString(), secret, fetchImpl, agent);
  } catch {
    if (!response.headersSent) send(response, 503, { error: "MCP service unavailable" });
    else response.destroy();
  } finally {
    release();
    await agent?.destroy();
  }
  return true;
}
