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

async function proxyMcpRelay(
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: string,
  upstreamAuth: { headerName: string; value: string } | null,
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
  // 客户端自带的同名上游凭据头一律剥离;只有网关注入的值能到达上游。
  if (upstreamAuth) blocked.add(upstreamAuth.headerName.toLowerCase());
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!value || blocked.has(key) || key === "forwarded" || key.startsWith("x-forwarded-"))
      continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (upstreamAuth) headers[upstreamAuth.headerName.toLowerCase()] = upstreamAuth.value;

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
  fetchImpl: typeof fetch = fetch,
  dnsLookup: McpDnsLookup = systemMcpDnsLookup,
  limiter = new McpRelayConcurrencyLimiter(),
): Promise<boolean> {
  const match = path.match(/^\/api\/enterprise\/mcp-relay\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return false;
  const method = request.method ?? "GET";
  if (!["GET", "POST", "DELETE"].includes(method)) {
    send(response, 405, { error: "Method not allowed" });
    return true;
  }
  let firstSegment: string;
  let secondSegment: string | undefined;
  try {
    firstSegment = decodeURIComponent(match[1]!);
    secondSegment = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
  } catch {
    send(response, 404, { error: "Not found" });
    return true;
  }
  // `t` 段保留给租户系统连接器;客户 id 是生成的 UUID,不会与 't' 冲突。
  if (firstSegment === "t") {
    if (!secondSegment) {
      send(response, 404, { error: "Not found" });
      return true;
    }
    return await relayTenantConnector(
      secondSegment,
      request,
      response,
      store,
      fetchImpl,
      dnsLookup,
      limiter,
    );
  }
  if (!secondSegment) {
    send(response, 404, { error: "Not found" });
    return true;
  }
  // 令牌直接对照 SQLite 中的绑定行:专家 runtime 共享同一份工作区配置,
  // 稳定令牌让中继鉴权不依赖任何进程内存状态。
  const provided = bearerToken(request);
  const binding = provided
    ? store.findMcpBindingForRelay(firstSegment, secondSegment, provided)
    : null;
  if (!binding) {
    send(response, 401, { error: "Unauthorized" });
    return true;
  }
  const tenantId = binding.tenantId;
  let endpoint: URL;
  try {
    endpoint = new URL(binding.endpoint);
  } catch {
    send(response, 503, { error: "MCP service unavailable" });
    return true;
  }
  if (
    !isTenantMcpEndpointAllowed(tenantId, endpoint.toString()) ||
    endpoint.username ||
    endpoint.password
  ) {
    send(response, 503, { error: "MCP service unavailable" });
    return true;
  }
  let secret: string | undefined;
  if (binding.secretRef) {
    if (!isTenantMcpSecretRef(binding.secretRef, tenantId)) {
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
  await relayUpstream(
    request,
    response,
    endpoint,
    secret === undefined ? null : { headerName: "authorization", value: `Bearer ${secret}` },
    fetchImpl,
    dnsLookup,
    limiter,
  );
  return true;
}

/**
 * 租户系统连接器中继:令牌对照 SQLite 中的连接器行做常数时间比较,之后与客户
 * 绑定共用同一套 allowlist / DNS pinning / 重定向拒绝 / 并发上限路径;上游
 * secret 从连接器的 secret_env 网关环境变量注入,注入头名可配置。
 */
async function relayTenantConnector(
  connectorId: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: EnterpriseStore,
  fetchImpl: typeof fetch,
  dnsLookup: McpDnsLookup,
  limiter: McpRelayConcurrencyLimiter,
): Promise<boolean> {
  const provided = bearerToken(request);
  const connector = provided ? store.findMcpConnectorForRelay(connectorId, provided) : null;
  if (!connector) {
    send(response, 401, { error: "Unauthorized" });
    return true;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(connector.url);
  } catch {
    send(response, 503, { error: "MCP service unavailable" });
    return true;
  }
  if (
    !isTenantMcpEndpointAllowed(connector.tenantId, endpoint.toString()) ||
    endpoint.username ||
    endpoint.password
  ) {
    send(response, 503, { error: "MCP service unavailable" });
    return true;
  }
  if (!isTenantMcpSecretRef(connector.secretEnv, connector.tenantId)) {
    process.emitWarning(`MCP connector ${connector.id} unavailable: secret reference is invalid.`, {
      code: "ZCODE_ENTERPRISE_MCP_SECRET_INVALID",
    });
    send(response, 503, { error: "MCP credential unavailable" });
    return true;
  }
  const secret = process.env[connector.secretEnv];
  if (!secret) {
    process.emitWarning(
      `MCP connector ${connector.id} unavailable: configured secret is missing.`,
      {
        code: "ZCODE_ENTERPRISE_MCP_SECRET_MISSING",
      },
    );
    send(response, 503, { error: "MCP credential unavailable" });
    return true;
  }
  await relayUpstream(
    request,
    response,
    endpoint,
    { headerName: connector.headerName, value: `Bearer ${secret}` },
    fetchImpl,
    dnsLookup,
    limiter,
  );
  return true;
}

async function relayUpstream(
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: URL,
  upstreamAuth: { headerName: string; value: string } | null,
  fetchImpl: typeof fetch,
  dnsLookup: McpDnsLookup,
  limiter: McpRelayConcurrencyLimiter,
): Promise<void> {
  const release = limiter.acquire();
  if (!release) {
    send(response, 503, { error: "MCP relay capacity reached" });
    return;
  }
  let agent: Agent | null = null;
  try {
    const address = await resolveWithTimeout(endpoint.hostname, dnsLookup);
    agent = pinnedAgent(endpoint, address);
    await proxyMcpRelay(request, response, endpoint.toString(), upstreamAuth, fetchImpl, agent);
  } catch {
    if (!response.headersSent) send(response, 503, { error: "MCP service unavailable" });
    else response.destroy();
  } finally {
    release();
    await agent?.destroy();
  }
}
