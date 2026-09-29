import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnterpriseStore } from "./store.js";

export type RelayCredential = { token: string; actorId: string };

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
  try {
    const upstream = await fetchImpl(endpoint, {
      method,
      headers,
      body,
      duplex: body ? "half" : undefined,
      redirect: "manual",
      signal: controller.signal,
    } as RequestInit);
    if (upstream.status >= 300 && upstream.status < 400) {
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
      for await (const chunk of upstream.body) response.write(chunk);
    }
    response.end();
  } catch {
    if (!response.headersSent) send(response, 503, { error: "MCP service unavailable" });
    else response.destroy();
  }
}

export async function handleMcpRelayRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: EnterpriseStore,
  relayCredentials: Map<string, Map<string, RelayCredential>>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const match = path.match(/^\/api\/enterprise\/mcp-relay\/([^/]+)\/([^/]+)$/);
  if (!match) return false;
  const method = request.method ?? "GET";
  if (!["GET", "POST", "DELETE"].includes(method)) {
    send(response, 405, { error: "Method not allowed" });
    return true;
  }
  const caseId = decodeURIComponent(match[1]!);
  const bindingId = decodeURIComponent(match[2]!);
  const credential = relayCredentials.get(caseId)?.get(bindingId);
  const provided = bearerToken(request);
  if (!credential || !provided || !constantTimeTokenMatch(credential.token, provided)) {
    send(response, 401, { error: "Unauthorized" });
    return true;
  }
  const caseValue = store.getCase(credential.actorId, caseId);
  if (caseValue.status === "closed") {
    send(response, 404, { error: "Not found" });
    return true;
  }
  const binding = store
    .listMcpBindingsForCase(credential.actorId, caseId)
    .find((candidate) => candidate.id === bindingId);
  if (!binding) {
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
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    send(response, 503, { error: "MCP service unavailable" });
    return true;
  }
  let secret: string | undefined;
  if (binding.secretRef) {
    if (!/^ZCODE_ENTERPRISE_MCP_SECRET_[A-Z0-9_]{1,100}$/.test(binding.secretRef)) {
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
  await proxyMcpRelay(request, response, endpoint.toString(), secret, fetchImpl);
  return true;
}
