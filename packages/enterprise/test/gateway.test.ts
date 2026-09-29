import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativePathAllowed, nativeTarget } from "../src/proxy.js";
import { EnterpriseStore } from "../src/store.js";
import { EnterpriseAuth } from "../src/auth.js";
import { RuntimeManager } from "../src/runtime.js";
import { createEnterpriseGateway } from "../src/gateway.js";

const password = "correct horse battery staple";
type BrowserSession = { cookie: string; csrf: string };

async function login(
  base: string,
  email: string,
  loginPassword = password,
): Promise<BrowserSession> {
  const response = await fetch(`${base}/api/enterprise/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ email, password: loginPassword }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { cookie, csrf: cookie.match(/enterprise_csrf=([^;]+)/)?.[1] ?? "" };
}

async function api(
  base: string,
  session: BrowserSession,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      origin: base,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function listen(server: ReturnType<typeof createHttpServer>): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server.address() as AddressInfo;
}

async function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function managerFor(url: string, onStart?: (token: string) => void): RuntimeManager {
  return new RuntimeManager({
    async start(input) {
      onStart?.(input.token);
      return {
        id: `fake-${input.id}`,
        url,
        workspacePath: input.workspacePath,
        stop: async () => undefined,
      };
    },
    async healthy() {
      return true;
    },
  });
}

async function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    request.once("error", reject);
    request.end();
  });
}

function waitForSocketText(socket: Socket, predicate: (value: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for WebSocket handshake")),
      5000,
    );
    const onData = (chunk: Buffer) => {
      value += chunk.toString();
      if (predicate(value)) finish();
    };
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function waitForSocketClose(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onClose = () => finish();
    const timeout = setTimeout(() => finish(new Error("Revoked WebSocket stayed open")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    socket.once("close", onClose);
  });
}

test("browser cannot reach privileged native routes or ambiguous encoded paths", () => {
  for (const path of [
    "/api/rpc-host-capability",
    "/api/connect-remote",
    "/api/bots/webhook",
    "/ws/host",
    "/ws/remote/123",
    "/api/%252frpc-host-capability",
    "/api/%2572pc-host-capability",
    "/api/other/%2e%2e/rpc-host-capability",
    "/api/%5cbots",
  ])
    assert.equal(nativePathAllowed(path), false, path);
  assert.equal(nativePathAllowed("/ws"), true);
  assert.equal(nativePathAllowed("/api/server-info"), true);
  assert.equal(nativePathAllowed("/api/%72pc-host-capability"), false);
  const binding = {
    caseId: "a",
    workspacePath: "/tmp/a",
    url: "http://127.0.0.1:3030",
    token: "secret",
  };
  assert.throws(() => nativeTarget("//evil.example/collect", binding));
  assert.throws(() => nativeTarget("/api/%72pc-host-capability", binding));
  assert.equal(nativeTarget("/api/server-info?x=1", binding).origin, binding.url);
});

test("admins provision users atomically and rename only their tenant's ServiceSpaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-admin-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "cases"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user: admin } = store.bootstrapAdmin("Tenant A", "admin@example.test", hash);
  store.provisionUser(admin.id, tenant.id, {
    email: "member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const { tenant: foreignTenant, user: foreignAdmin } = store.bootstrapAdmin(
    "Tenant B",
    "other-admin@example.test",
    hash,
  );
  const foreignSpace = store.createServiceSpace(foreignAdmin.id, foreignTenant.id, {
    name: "Foreign space",
  });
  let starts = 0;
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9", () => {
      starts += 1;
    }),
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    let response = await fetch(`${base}/api/server-info`);
    assert.equal(response.status, 401);
    const adminSession = await login(base, "admin@example.test");
    const memberSession = await login(base, "member@example.test");
    const foreignSession = await login(base, "other-admin@example.test");
    response = await fetch(`${base}/api/server-info`, { headers: { cookie: adminSession.cookie } });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/rpc-host-capability`, {
      headers: { cookie: adminSession.cookie },
    });
    assert.equal(response.status, 403);

    response = await api(base, adminSession, "/api/enterprise/users", "POST", {
      tenantId: foreignTenant.id,
      email: "cross-tenant@example.test",
      password: "password-long",
      role: "member",
    });
    assert.equal(response.status, 404);
    response = await api(base, memberSession, "/api/enterprise/users", "POST", {
      tenantId: tenant.id,
      email: "unauthorized@example.test",
      password: "password-long",
      role: "member",
    });
    assert.equal(response.status, 403);

    response = await api(base, adminSession, "/api/enterprise/users", "POST", {
      tenantId: tenant.id,
      email: "provisioned@example.test",
      password: "provisioned password",
      role: "member",
      displayName: "Provisioned",
    });
    assert.equal(response.status, 201);
    const provisioned = (await response.json()) as {
      user: { id: string; email: string };
      membership: { tenantId: string; role: string };
    };
    assert.equal(provisioned.user.email, "provisioned@example.test");
    assert.equal(provisioned.membership.tenantId, tenant.id);
    assert.equal(provisioned.membership.role, "member");
    response = await api(base, adminSession, "/api/enterprise/users", "POST", {
      tenantId: tenant.id,
      email: "provisioned@example.test",
      password: "another password",
      role: "admin",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(
      store.listTenantsForUser(provisioned.user.id).map((item) => item.id),
      [tenant.id],
    );

    response = await api(base, adminSession, "/api/enterprise/spaces", "POST", {
      tenantId: tenant.id,
      name: "Support",
    });
    assert.equal(response.status, 201);
    const space = (await response.json()) as { id: string; tenantId: string; name: string };
    const object = store.createServiceObject(admin.id, space.id, {
      name: "Widget",
      type: "product",
    });
    const value = store.createCase(admin.id, object.id, { title: "Inspect widget" });
    response = await api(base, adminSession, `/api/enterprise/spaces/${space.id}`, "PATCH", {
      name: "Customer Support",
    });
    assert.equal(response.status, 200);
    const renamed = (await response.json()) as { id: string; tenantId: string; name: string };
    assert.equal(renamed.id, space.id);
    assert.equal(renamed.tenantId, tenant.id);
    assert.equal(renamed.name, "Customer Support");
    assert.equal(store.getCase(admin.id, value.id).serviceSpaceId, space.id);

    response = await api(base, memberSession, `/api/enterprise/spaces/${space.id}`, "PATCH", {
      name: "Member rename",
    });
    assert.equal(response.status, 403);
    response = await api(base, foreignSession, `/api/enterprise/spaces/${space.id}`, "PATCH", {
      name: "Cross tenant",
    });
    assert.equal(response.status, 404);
    response = await api(
      base,
      foreignSession,
      `/api/enterprise/spaces/${foreignSpace.id}`,
      "PATCH",
      { name: "Foreign renamed" },
    );
    assert.equal(response.status, 200);

    const provisionedSession = await login(
      base,
      "provisioned@example.test",
      "provisioned password",
    );
    assert.ok(provisionedSession.cookie.includes("enterprise_session="));
    assert.equal(starts, 0);
  } finally {
    await gateway.close();
    store.close();
  }
});

test("native proxy injects only its runtime credential and hides runtime cookies and redirect origins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-proxy-"));
  await writeFile(join(dir, "index.html"), "ready");
  let received: IncomingHttpHeaders | undefined;
  const native = createHttpServer((request, response) => {
    received = request.headers;
    response.statusCode = 302;
    response.setHeader("set-cookie", "native_session=do-not-leak");
    response.setHeader("location", `${nativeOrigin}/api/server-info?next=1`);
    response.end("redirect");
  });
  const nativeAddress = await listen(native);
  const nativeOrigin = `http://127.0.0.1:${nativeAddress.port}`;
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "cases"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "admin@example.test", hash);
  const space = store.createServiceSpace(user.id, tenant.id, { name: "Support" });
  const object = store.createServiceObject(user.id, space.id, { name: "Widget", type: "product" });
  const value = store.createCase(user.id, object.id, { title: "Inspect widget" });
  let runtimeToken = "";
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor(nativeOrigin, (token) => {
      runtimeToken = token;
    }),
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await login(base, "admin@example.test");
    let response = await api(
      base,
      browser,
      `/api/enterprise/cases/${value.id}/activate`,
      "POST",
      {},
    );
    assert.equal(response.status, 200);
    const caseContextPath = join(value.workspacePath, "CASE_CONTEXT.md");
    const before = await stat(caseContextPath, { bigint: true });
    const proxied = await rawGet(`${base}/api/test`, {
      cookie: `${browser.cookie}; zcode_lite_token=attacker`,
      authorization: "Bearer attacker",
      connection: "X-Private",
      "x-private": "must-not-reach-runtime",
      "x-forwarded-host": "attacker.example.test",
    });
    const after = await stat(caseContextPath, { bigint: true });
    assert.equal(proxied.status, 302);
    assert.equal(proxied.body, "redirect");
    assert.equal(proxied.headers["set-cookie"], undefined);
    assert.equal(proxied.headers.location, "/api/server-info?next=1");
    assert.equal(received?.cookie, `zcode_lite_token=${encodeURIComponent(runtimeToken)}`);
    assert.equal(received?.authorization, undefined);
    assert.equal(received?.["x-private"], undefined);
    assert.equal(received?.["x-forwarded-host"], undefined);
    assert.equal(
      before.ino,
      after.ino,
      "healthy native requests must not rewrite workspace context",
    );
  } finally {
    await gateway.close();
    await closeServer(native);
    store.close();
  }
});

test("membership revocation immediately closes an active user's WebSocket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-ws-"));
  await writeFile(join(dir, "index.html"), "ready");
  const nativeSockets = new Set<Duplex>();
  const native = createHttpServer();
  native.on("upgrade", (request, socket) => {
    nativeSockets.add(socket);
    socket.once("close", () => nativeSockets.delete(socket));
    const key = String(request.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: native=secret\r\n\r\n`,
    );
  });
  const nativeAddress = await listen(native);
  const nativeOrigin = `http://127.0.0.1:${nativeAddress.port}`;
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "cases"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user: admin } = store.bootstrapAdmin("Tenant", "admin@example.test", hash);
  const { user: member } = store.provisionUser(admin.id, tenant.id, {
    email: "member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const space = store.createServiceSpace(admin.id, tenant.id, { name: "Support" });
  const object = store.createServiceObject(admin.id, space.id, { name: "Widget", type: "product" });
  const value = store.createCase(admin.id, object.id, { title: "Inspect widget" });
  const auth = new EnterpriseAuth(store);
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: managerFor(nativeOrigin),
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const memberAuth = await auth.login("member@example.test", password);
  const adminSession = await login(base, "admin@example.test");
  store.activateCase(memberAuth.session.id, value.id);
  const client = createConnection({ host: "127.0.0.1", port: address.port });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    const handshake = waitForSocketText(client, (text) => text.includes("\r\n\r\n"));
    client.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nOrigin: ${base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: enterprise_session=${memberAuth.token}\r\n\r\n`,
    );
    assert.match(await handshake, /^HTTP\/1\.1 101 Switching Protocols/);
    const clientClosed = waitForSocketClose(client, 2000);
    const response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/members/${member.id}`,
      "DELETE",
    );
    assert.equal(response.status, 200);
    await clientClosed;
    assert.equal(store.getActiveCase(memberAuth.session.id), null);
  } finally {
    client.destroy();
    await gateway.close();
    for (const socket of nativeSockets) socket.destroy();
    await closeServer(native);
    store.close();
  }
});

test("session binding accepts only task IDs owned by the active Case runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-session-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "cases"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "admin@example.test", hash);
  const space = store.createServiceSpace(user.id, tenant.id, { name: "Support" });
  const object = store.createServiceObject(user.id, space.id, { name: "Widget", type: "product" });
  const value = store.createCase(user.id, object.id, { title: "Inspect widget" });
  const runtimes = new RuntimeManager({
    async start(input) {
      return {
        id: `fake-${input.id}`,
        url: "http://127.0.0.1:9",
        workspacePath: input.workspacePath,
        stop: async () => undefined,
      };
    },
    async healthy() {
      return true;
    },
    async ownsSession(caseInfo, nativeSessionId) {
      return caseInfo.id === value.id && nativeSessionId === "case-owned-session";
    },
  });
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes,
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await login(base, "admin@example.test");
    const activated = await api(
      base,
      browser,
      `/api/enterprise/cases/${value.id}/activate`,
      "POST",
      {},
    );
    assert.equal(activated.status, 200);
    let response = await api(base, browser, `/api/enterprise/cases/${value.id}/session`, "POST", {
      sessionId: "foreign-session-id",
    });
    assert.equal(response.status, 404);
    assert.equal(store.getCase(user.id, value.id).nativeSessionId, null);
    response = await api(base, browser, `/api/enterprise/cases/${value.id}/session`, "POST", {
      sessionId: "case-owned-session",
    });
    assert.equal(response.status, 200);
    assert.equal(store.getCase(user.id, value.id).nativeSessionId, "case-owned-session");
  } finally {
    await gateway.close();
    store.close();
  }
});

test("MCP relay streams through one Case binding without writing the upstream secret into the workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-mcp-"));
  await writeFile(join(dir, "index.html"), "ready");
  const secretRef = "ZCODE_ENTERPRISE_MCP_SECRET_GATEWAY_TEST";
  const missingSecretRef = "ZCODE_ENTERPRISE_MCP_SECRET_EXPECTED_MISSING";
  const priorSecret = process.env[secretRef];
  const priorMissingSecret = process.env[missingSecretRef];
  const secret = "never-write-this-real-secret";
  process.env[secretRef] = secret;
  delete process.env[missingSecretRef];
  let runtimeToken = "";
  let fetchCount = 0;
  let upstreamAuthorization: string | undefined;
  let upstreamSession: string | undefined;
  let upstreamCookie: string | undefined;
  let missingBindingId = "";
  let emittedMissingSecretWarning = false;
  const onWarning = (warning: Error & { code?: string }) => {
    if (
      warning.code === "ZCODE_ENTERPRISE_MCP_SECRET_MISSING" &&
      warning.message.includes(missingBindingId)
    ) {
      emittedMissingSecretWarning = true;
    }
  };
  process.on("warning", onWarning);
  const fetchImpl: typeof fetch = async (_input, init) => {
    fetchCount += 1;
    const headers = init?.headers as Record<string, string>;
    upstreamAuthorization = headers.authorization;
    upstreamSession = headers["mcp-session-id"];
    upstreamCookie = headers.cookie;
    return new Response('event: message\ndata: {"ok":true}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream", "set-cookie": "upstream=do-not-leak" },
    });
  };
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "cases"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "admin@example.test", hash);
  const space = store.createServiceSpace(user.id, tenant.id, { name: "Support" });
  const object = store.createServiceObject(user.id, space.id, { name: "Widget", type: "product" });
  const value = store.createCase(user.id, object.id, { title: "Inspect widget" });
  const binding = store.createMcpBinding(user.id, tenant.id, {
    name: "support-mcp",
    endpoint: "https://mcp.example.test/stream",
    secretRef,
    serviceSpaceId: space.id,
  });
  const missingBinding = store.createMcpBinding(user.id, tenant.id, {
    name: "optional-mcp",
    endpoint: "https://optional.example.test/stream",
    secretRef: missingSecretRef,
    serviceSpaceId: space.id,
  });
  missingBindingId = missingBinding.id;
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9", (token) => {
      runtimeToken = token;
    }),
    staticRoot: dir,
    port: 0,
    fetchImpl,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await login(base, "admin@example.test");
    const activated = await api(
      base,
      browser,
      `/api/enterprise/cases/${value.id}/activate`,
      "POST",
      {},
    );
    assert.equal(activated.status, 200);
    assert.ok(runtimeToken);

    const configPath = join(value.workspacePath, ".zcode", "config.json");
    const config = await readFile(configPath, "utf8");
    const parsed = JSON.parse(config) as {
      mcp: { servers: Record<string, { url: string; headers: { Authorization: string } }> };
    };
    const serverConfig = parsed.mcp.servers["enterprise-support-mcp"]!;
    assert.ok(
      serverConfig.url.startsWith(`${base}/api/enterprise/mcp-relay/${value.id}/${binding.id}`),
    );
    assert.ok(serverConfig.headers.Authorization.startsWith("Bearer "));
    assert.equal(Object.keys(parsed.mcp.servers).includes("enterprise-optional-mcp"), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      emittedMissingSecretWarning,
      true,
      "a missing binding secret must produce an operator diagnostic",
    );
    const files = await Promise.all([
      readFile(configPath, "utf8"),
      readFile(join(value.workspacePath, "CASE_CONTEXT.md"), "utf8"),
      readFile(join(value.workspacePath, "AGENTS.md"), "utf8"),
      readFile(join(value.workspacePath, ".zcode", "enterprise-managed.json"), "utf8"),
    ]);
    assert.equal(files.join("\n").includes(secret), false);
    const relayPath = `/api/enterprise/mcp-relay/${value.id}/${binding.id}`;
    let response = await fetch(`${base}${relayPath}`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(fetchCount, 0);
    response = await fetch(`${base}/api/enterprise/mcp-relay/${value.id}/${missingBinding.id}`, {
      method: "POST",
      headers: { authorization: serverConfig.headers.Authorization },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(fetchCount, 0);

    response = await fetch(`${base}${relayPath}`, {
      method: "POST",
      headers: {
        authorization: serverConfig.headers.Authorization,
        "content-type": "application/json",
        "mcp-session-id": "session-1",
        cookie: "enterprise_session=browser-cookie",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: message/);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(upstreamAuthorization, `Bearer ${secret}`);
    assert.equal(upstreamSession, "session-1");
    assert.equal(upstreamCookie, undefined);
    assert.equal(fetchCount, 1);
  } finally {
    process.off("warning", onWarning);
    if (priorSecret === undefined) delete process.env[secretRef];
    else process.env[secretRef] = priorSecret;
    if (priorMissingSecret === undefined) delete process.env[missingSecretRef];
    else process.env[missingSecretRef] = priorMissingSecret;
    await gateway.close();
    store.close();
  }
});
