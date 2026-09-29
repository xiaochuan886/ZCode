import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { RuntimeBinding } from "./runtime.js";

const deniedPaths = [
  /^\/api\/rpc-host-capability(?:\/|$)/i,
  /^\/api\/connect-remote(?:\/|$)/i,
  /^\/api\/bots(?:\/|$)/i,
  /^\/ws\/host(?:\/|$)/i,
  /^\/ws\/remote(?:\/|$)/i,
];

const requestHopByHop = new Set([
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
  "x-csrf-token",
]);

const responseHopByHop = new Set([
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
  "access-control-allow-origin",
]);

function connectionTokens(value: string | string[] | undefined): Set<string> {
  return new Set(
    (Array.isArray(value) ? value.join(",") : (value ?? ""))
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function nativePathAllowed(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  // 下游若再次解码，表面普通的路径可能变成特权路由，因此拒绝仍含编码字节的路径。
  if (/%[0-9a-f]{2}/i.test(decoded)) return false;
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.includes("//")) return false;
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return !deniedPaths.some((pattern) => pattern.test(decoded));
}

export function nativeTarget(rawUrl: string, binding: RuntimeBinding): URL {
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) throw new Error("Invalid native target");
  const browserUrl = new URL(rawUrl, "http://gateway.invalid");
  if (browserUrl.origin !== "http://gateway.invalid" || !nativePathAllowed(browserUrl.pathname)) {
    throw new Error("Forbidden native target");
  }
  return new URL(`${browserUrl.pathname}${browserUrl.search}`, binding.url);
}

export function validWebSocketHandshake(request: IncomingMessage): boolean {
  const key = request.headers["sec-websocket-key"];
  const upgrade = request.headers.upgrade?.toLowerCase();
  const connection = connectionTokens(request.headers.connection);
  return (
    typeof key === "string" &&
    Buffer.from(key, "base64").length === 16 &&
    Buffer.from(key, "base64").toString("base64") === key &&
    request.headers["sec-websocket-version"] === "13" &&
    upgrade === "websocket" &&
    connection.has("upgrade")
  );
}

function upstreamHeaders(input: IncomingMessage, binding: RuntimeBinding): Record<string, string> {
  const blocked = new Set([...requestHopByHop, ...connectionTokens(input.headers.connection)]);
  const headers: Record<string, string> = {
    cookie: `zcode_lite_token=${encodeURIComponent(binding.token)}`,
  };
  for (const [key, value] of Object.entries(input.headers)) {
    if (
      !value ||
      blocked.has(key) ||
      key.startsWith("sec-websocket-") ||
      key === "forwarded" ||
      key.startsWith("x-forwarded-")
    )
      continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function gatewayLocation(value: string, binding: RuntimeBinding): string | null {
  try {
    const target = new URL(value, binding.url);
    if (target.origin !== new URL(binding.url).origin || !nativePathAllowed(target.pathname))
      return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

export async function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  binding: RuntimeBinding,
): Promise<void> {
  let target: URL;
  try {
    target = nativeTarget(request.url ?? "/", binding);
  } catch {
    response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    response.end('{"error":"Forbidden"}');
    return;
  }

  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : request;
  try {
    const upstream = await fetch(target, {
      method,
      headers: upstreamHeaders(request, binding),
      body,
      duplex: body ? "half" : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    } as RequestInit);
    response.statusCode = upstream.status;
    for (const [key, value] of upstream.headers) {
      if (responseHopByHop.has(key)) continue;
      if (key === "location") {
        const location = gatewayLocation(value, binding);
        if (location) response.setHeader(key, location);
        continue;
      }
      if (key === "content-encoding") continue;
      response.setHeader(key, value);
    }
    if (upstream.body) {
      for await (const chunk of upstream.body) response.write(chunk);
    }
    response.end();
  } catch {
    if (!response.headersSent) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end('{"error":"Runtime unavailable"}');
    } else {
      response.destroy();
    }
  }
}

export function proxyWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  binding: RuntimeBinding,
): void {
  const target = nativeTarget(request.url ?? "/ws", binding);
  const headers = {
    ...upstreamHeaders(request, binding),
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": String(request.headers["sec-websocket-key"] ?? ""),
    "sec-websocket-version": "13",
  };
  const upstream = httpRequest(target, { method: "GET", headers });
  const timeout = setTimeout(
    () => upstream.destroy(new Error("WebSocket handshake timeout")),
    10_000,
  );
  timeout.unref();
  socket.on("close", () => {
    clearTimeout(timeout);
    upstream.destroy();
  });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    clearTimeout(timeout);
    const accept = response.headers["sec-websocket-accept"];
    if (
      response.statusCode !== 101 ||
      typeof accept !== "string" ||
      !/^[A-Za-z0-9+/]{27}=$/.test(accept)
    ) {
      socket.destroy();
      upstreamSocket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
    socket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => socket.destroy());
    upstreamSocket.on("error", () => socket.destroy());
  });
  upstream.on("response", (response) => {
    clearTimeout(timeout);
    socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Denied\r\nConnection: close\r\n\r\n`);
  });
  upstream.on("error", () => {
    clearTimeout(timeout);
    socket.destroy();
  });
  upstream.end();
}
