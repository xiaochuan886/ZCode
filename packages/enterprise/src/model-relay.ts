import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { writeAsyncIterableBackpressured } from "./backpressure.js";

/** Provider families with a fixed, server-owned upstream endpoint. */
export type ModelRelayProviderFamily = "zai-api" | "bigmodel-api";

export type ModelRelayCapability = {
  /** Opaque token written into the Case runtime configuration. */
  token: string;
  /** The enterprise actor that owns the Case. */
  actorId: string;
  /** Provider selected when the token was provisioned. */
  providerFamily: ModelRelayProviderFamily;
};

export type ModelRelayCapabilityMap = ReadonlyMap<
  string,
  ReadonlyMap<ModelRelayProviderFamily, ModelRelayCapability>
>;

export type ModelRelayAuthorizationInput = {
  caseId: string;
  actorId: string;
  providerFamily: ModelRelayProviderFamily;
};

/** Re-checks the live Case membership/status before a model request is sent upstream. */
export type ModelRelayCaseAuthorizer = (
  input: ModelRelayAuthorizationInput,
) => boolean | Promise<boolean>;

/** Resolves the tenant/provider key only after the Case has been authorized. */
export type ModelRelayApiKeyResolver = (
  input: ModelRelayAuthorizationInput,
) => string | null | undefined | Promise<string | null | undefined>;

export type ModelRelayFetch = typeof fetch;

export const DEFAULT_MODEL_RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;

const maxConcurrentRelays = 16;
const upstreamHeaderTimeoutMs = 15_000;

const upstreamOrigins: Readonly<Record<ModelRelayProviderFamily, string>> = {
  "zai-api": "https://api.z.ai/api/anthropic",
  "bigmodel-api": "https://open.bigmodel.cn/api/anthropic",
};

const blockedRequestHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

const blockedResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "location",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class ModelRelayConcurrencyLimiter {
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

class ModelRelayBodyTooLargeError extends Error {
  constructor() {
    super("model relay request body exceeds the configured limit");
    this.name = "ModelRelayBodyTooLargeError";
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  if (response.headersSent || response.destroyed) {
    if (!response.destroyed) response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function presentedRelayTokens(request: IncomingMessage): string[] {
  const authorization = singleHeader(request.headers.authorization);
  const apiKey = singleHeader(request.headers["x-api-key"]);
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
  return [bearer, apiKey].filter((value): value is string => value !== null);
}

function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function providerFamilyFromPath(value: string): ModelRelayProviderFamily | null {
  switch (value) {
    case "zai-api":
    case "zai":
      return "zai-api";
    case "bigmodel-api":
    case "bigmodel":
      return "bigmodel-api";
    default:
      return null;
  }
}

function decodedSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    // A decoded slash/backslash would turn an opaque path segment into a new route.
    return decoded && !/[\\/]/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function relayRoute(path: string):
  | {
      caseId: string;
      providerFamily: ModelRelayProviderFamily;
      suffix: string;
    }
  | "unmatched"
  | null {
  const match = path.match(/^\/api\/enterprise\/model-relay\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (!match) return "unmatched";
  const caseId = decodedSegment(match[1]!);
  const rawProvider = decodedSegment(match[2]!);
  const providerFamily = rawProvider ? providerFamilyFromPath(rawProvider) : null;
  if (!caseId || !providerFamily) return null;
  return { caseId, providerFamily, suffix: match[3] ?? "" };
}

function headerValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

function copyRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const blocked = new Set(blockedRequestHeaders);
  for (const token of String(headers.connection ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) blocked.add(name);
  }
  const copied: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (!rawValue) continue;
    const name = rawName.toLowerCase();
    if (blocked.has(name) || name === "forwarded" || name.startsWith("x-forwarded-")) continue;
    copied[name] = headerValue(rawValue);
  }
  return copied;
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = singleHeader(request.headers["content-length"]);
  if (declared) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length >= 0 && length > maxBytes)
      throw new ModelRelayBodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxBytes) throw new ModelRelayBodyTooLargeError();
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

async function proxyModelRelay(
  request: IncomingMessage,
  response: ServerResponse,
  providerFamily: ModelRelayProviderFamily,
  body: Buffer,
  apiKey: string,
  fetchImpl: ModelRelayFetch,
): Promise<void> {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const headerTimeout = setTimeout(() => controller.abort(), upstreamHeaderTimeoutMs);
  try {
    const headers = copyRequestHeaders(request.headers);
    // Anthropic-compatible Z.ai/BigModel endpoints accept both forms. Supplying only
    // this server-resolved key prevents a Case token or browser credential reaching upstream.
    headers.authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
    const upstream = await fetchImpl(`${upstreamOrigins[providerFamily]}/v1/messages`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(headerTimeout);
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      sendJson(response, 502, { error: "Model provider redirects are not supported" });
      return;
    }
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) {
      if (blockedResponseHeaders.has(name.toLowerCase())) continue;
      response.setHeader(name, value);
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
    if (!response.headersSent) sendJson(response, 503, { error: "Model provider unavailable" });
    else if (!response.destroyed) response.destroy();
  } finally {
    clearTimeout(headerTimeout);
  }
}

/**
 * Handles only the fixed enterprise model relay routes. Returning false leaves unrelated paths
 * to the generic gateway. All mutable Case and credential state stays in injected callbacks/maps.
 */
export async function handleModelRelayRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  capabilities: ModelRelayCapabilityMap,
  authorizeCase: ModelRelayCaseAuthorizer,
  resolveApiKey: ModelRelayApiKeyResolver,
  fetchImpl?: ModelRelayFetch,
  limiter?: ModelRelayConcurrencyLimiter,
  maxBodyBytes?: number,
): Promise<boolean>;
export async function handleModelRelayRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  capabilities: ModelRelayCapabilityMap,
  authorizeCase: ModelRelayCaseAuthorizer,
  resolveApiKey: ModelRelayApiKeyResolver,
  fetchImpl: ModelRelayFetch = fetch,
  limiter: ModelRelayConcurrencyLimiter = new ModelRelayConcurrencyLimiter(),
  maxBodyBytes = DEFAULT_MODEL_RELAY_MAX_BODY_BYTES,
): Promise<boolean> {
  const route = relayRoute(path);
  if (route === "unmatched") return false;
  if (!route) {
    sendJson(response, 404, { error: "Not found" });
    return true;
  }
  const method = request.method ?? "GET";
  if (method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  if (route.suffix !== "/v1/messages") {
    sendJson(response, 404, { error: "Not found" });
    return true;
  }
  const capability = capabilities.get(route.caseId)?.get(route.providerFamily);
  const presented = presentedRelayTokens(request);
  if (
    !capability ||
    capability.providerFamily !== route.providerFamily ||
    !presented.some((value) => constantTimeTokenMatch(capability.token, value))
  ) {
    sendJson(response, 401, { error: "Unauthorized" });
    return true;
  }
  const authorizationInput = {
    caseId: route.caseId,
    actorId: capability.actorId,
    providerFamily: route.providerFamily,
  } satisfies ModelRelayAuthorizationInput;
  let authorized = false;
  try {
    authorized = (await authorizeCase(authorizationInput)) === true;
  } catch {
    authorized = false;
  }
  if (!authorized) {
    sendJson(response, 404, { error: "Not found" });
    return true;
  }
  let apiKey: string | null | undefined;
  try {
    apiKey = await resolveApiKey(authorizationInput);
  } catch {
    apiKey = null;
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    sendJson(response, 503, { error: "Model credential unavailable" });
    return true;
  }
  const release = limiter.acquire();
  if (!release) {
    sendJson(response, 503, { error: "Model relay capacity reached" });
    return true;
  }
  try {
    let body: Buffer;
    try {
      body = await readRequestBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof ModelRelayBodyTooLargeError) {
        request.resume();
        sendJson(response, 413, { error: "Request body too large" });
        return true;
      }
      throw error;
    }
    await proxyModelRelay(request, response, route.providerFamily, body, apiKey.trim(), fetchImpl);
  } catch {
    if (!response.headersSent) sendJson(response, 503, { error: "Model provider unavailable" });
    else if (!response.destroyed) response.destroy();
  } finally {
    release();
  }
  return true;
}
