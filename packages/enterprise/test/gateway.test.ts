import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { expertRuntimeId, type EnterpriseRuntimeTarget } from "../src/types.js";
import { nativePathAllowed, nativeTarget } from "../src/proxy.js";
import { EnterpriseStore } from "../src/store.js";
import { EnterpriseAuth } from "../src/auth.js";
import { RuntimeManager, type RuntimeCase } from "../src/runtime.js";
import { createEnterpriseGateway } from "../src/gateway.js";
import { materializeCustomer } from "../src/gateway-prepare.js";

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

test("admins provision users atomically and customer updates stay tenant-scoped", async () => {
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
  const foreignCustomer = await store.createCustomer(foreignAdmin.id, foreignTenant.id, {
    name: "Foreign customer",
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

    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${foreignTenant.id}/users`,
      "POST",
      {
        email: "cross-tenant@example.test",
        password: "password-long",
        role: "member",
      },
    );
    assert.equal(response.status, 404);
    response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/users`,
      "POST",
      {
        email: "unauthorized@example.test",
        password: "password-long",
        role: "member",
      },
    );
    assert.equal(response.status, 403);

    response = await api(base, adminSession, `/api/enterprise/tenants/${tenant.id}/users`, "POST", {
      email: "provisioned@example.test",
      password: "provisioned password",
      role: "member",
      displayName: "Provisioned",
    });
    assert.equal(response.status, 201);
    const provisioned = (await response.json()) as {
      id: string;
      email: string;
      role: string;
      status: string;
      customerAccess: unknown;
      joined: boolean;
    };
    assert.equal(provisioned.email, "provisioned@example.test");
    assert.equal(provisioned.role, "member");
    assert.equal(provisioned.status, "active");
    assert.equal(provisioned.joined, false);
    response = await api(base, adminSession, `/api/enterprise/tenants/${tenant.id}/users`, "POST", {
      email: "provisioned@example.test",
      password: "another password",
      role: "admin",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(
      store.listTenantsForUser(provisioned.id).map((item) => item.id),
      [tenant.id],
    );

    const customer = await store.createCustomer(admin.id, tenant.id, { name: "Support" });
    response = await api(base, memberSession, `/api/enterprise/customers/${customer.id}`, "PATCH", {
      name: "Member rename",
    });
    assert.equal(response.status, 403);
    response = await api(
      base,
      foreignSession,
      `/api/enterprise/customers/${customer.id}`,
      "PATCH",
      {
        name: "Cross tenant",
      },
    );
    assert.equal(response.status, 404);
    response = await api(
      base,
      foreignSession,
      `/api/enterprise/customers/${foreignCustomer.id}`,
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

test("tenant model provider catalog API is admin-gated and never returns keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-providers-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: Buffer.alloc(32, 0x42),
  });
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "model-admin@example.test", hash);
  const member = store.provisionUser(user.id, tenant.id, {
    email: "model-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  let testedUrl = "";
  let testedHeaders: Record<string, string> = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    testedUrl = String(input);
    testedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ data: [{ id: "listed-model" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9"),
    staticRoot: dir,
    port: 0,
    fetchImpl,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const adminSession = await login(base, user.email);
    const memberSession = await login(base, member.user.email);
    let response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "GET",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    // 成员创建被拒。
    response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "POST",
      {
        providerKey: "denied",
        displayName: "Denied",
        apiType: "anthropic-messages",
        baseUrl: "https://denied.example.com",
        apiKey: "member-secret-9999",
      },
    );
    assert.equal(response.status, 403);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "POST",
      {
        providerKey: "acme",
        displayName: "Acme AI",
        apiType: "openai-chat-completions",
        baseUrl: "https://acme.example.com/v1",
        apiKey: "server-secret-1234",
        models: ["acme-a", "acme-b"],
      },
    );
    assert.equal(response.status, 201);
    const first = (await response.json()) as Record<string, unknown>;
    assert.equal(first.providerKey, "acme");
    assert.equal(first.isDefault, true);
    assert.equal(first.apiKeyLast4, "1234");
    assert.equal("apiKey" in first, false);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "POST",
      {
        providerKey: "beta",
        displayName: "Beta AI",
        apiType: "anthropic-messages",
        baseUrl: "https://beta.example.com",
        apiKey: "beta-key-8888",
        models: ["beta-a"],
        isDefault: true,
      },
    );
    assert.equal(response.status, 201);
    const second = (await response.json()) as Record<string, unknown>;
    // 企业设置为管理员专属:成员读目录 403,就绪信号成员可读且不含目录细节。
    response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "GET",
    );
    assert.equal(response.status, 403);
    response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/model-status`,
      "GET",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ready: true });
    // 管理员读投影,无 key。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "GET",
    );
    assert.equal(response.status, 200);
    const adminView = (await response.json()) as Array<Record<string, unknown>>;
    assert.equal(adminView.length, 2);
    assert.deepEqual(
      adminView.map((provider) => [provider.providerKey, provider.isDefault]),
      [
        ["acme", false],
        ["beta", true],
      ],
    );
    assert.ok(adminView.every((provider) => !("apiKey" in provider)));
    // PATCH 切默认。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/model-providers/${first.id}`,
      "PATCH",
      {
        isDefault: true,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { isDefault: boolean }).isDefault, true);
    response = await api(
      base,
      memberSession,
      `/api/enterprise/model-providers/${first.id}`,
      "PATCH",
      {
        displayName: "Denied",
      },
    );
    assert.equal(response.status, 403);
    // 连接测试走服务端 fetch:openai 类型带 Bearer 头,key 不出现在响应中。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/model-providers/${first.id}/test`,
      "POST",
      {},
    );
    assert.equal(response.status, 200);
    const testResult = (await response.json()) as { ok: boolean; models?: string[] };
    assert.equal(testResult.ok, true);
    assert.deepEqual(testResult.models, ["listed-model"]);
    assert.equal(testedUrl, "https://acme.example.com/v1/models");
    assert.equal(testedHeaders.authorization, "Bearer server-secret-1234");
    assert.equal(JSON.stringify(testResult).includes("server-secret-1234"), false);
    response = await api(
      base,
      memberSession,
      `/api/enterprise/model-providers/${first.id}/test`,
      "POST",
      {},
    );
    assert.equal(response.status, 403);
    // DELETE。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/model-providers/${second.id}`,
      "DELETE",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "GET",
    );
    const afterDelete = (await response.json()) as Array<Record<string, unknown>>;
    assert.deepEqual(
      afterDelete.map((provider) => provider.providerKey),
      ["acme"],
    );
    assert.equal(afterDelete[0]!.isDefault, true);

    // 第三协议 openai-responses:可创建(富条目元数据随目录往返),连接测试与
    // OpenAI 路径完全一致——Bearer 头请求 {baseUrl}/models 并解析 data[].id。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "POST",
      {
        providerKey: "gamma",
        displayName: "Gamma AI",
        apiType: "openai-responses",
        baseUrl: "https://gamma.example.com/v1",
        apiKey: "gamma-secret-7777",
        models: [{ id: "gamma-a", contextWindow: 200000 }],
      },
    );
    assert.equal(response.status, 201);
    const gamma = (await response.json()) as Record<string, unknown>;
    assert.equal(gamma.apiType, "openai-responses");
    assert.deepEqual(gamma.models, [{ id: "gamma-a", contextWindow: 200000 }]);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/model-providers/${gamma.id as string}/test`,
      "POST",
      {},
    );
    assert.equal(response.status, 200);
    const gammaResult = (await response.json()) as { ok: boolean; models?: string[] };
    assert.equal(gammaResult.ok, true);
    assert.deepEqual(gammaResult.models, ["listed-model"]);
    assert.equal(testedUrl, "https://gamma.example.com/v1/models");
    assert.equal(testedHeaders.authorization, "Bearer gamma-secret-7777");
    assert.equal(JSON.stringify(gammaResult).includes("gamma-secret-7777"), false);
    // 富条目元数据严格校验:未知键/坏类型 → 400;纯字符串输入仍可混用。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "POST",
      {
        providerKey: "malformed",
        displayName: "Malformed",
        apiType: "openai-responses",
        baseUrl: "https://malformed.example.com",
        apiKey: "key",
        models: [{ id: "m", mystery: true }],
      },
    );
    assert.equal(response.status, 400);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      "POST",
      {
        providerKey: "malformed",
        displayName: "Malformed",
        apiType: "openai-responses",
        baseUrl: "https://malformed.example.com",
        apiKey: "key",
        models: ["plain-a", { id: "m", contextWindow: "huge" }],
      },
    );
    assert.equal(response.status, 400);
  } finally {
    await gateway.close();
    store.close();
  }
});

test("customer routes activate one stable workspace per customer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-customer-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "customer-admin@example.test", hash);
  const customer = await store.createCustomer(user.id, tenant.id, {
    name: "Acme",
    type: "account",
  });
  let starts = 0;
  let stops = 0;
  const runtimes = new RuntimeManager({
    async start(input) {
      starts += 1;
      return {
        id: `fake-${input.id}`,
        url: "http://127.0.0.1:9",
        workspacePath: input.workspacePath,
        stop: async () => {
          stops += 1;
        },
      };
    },
    async healthy() {
      return true;
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
    const browser = await login(base, user.email);
    let response = await api(
      base,
      browser,
      `/api/enterprise/customers?tenantId=${tenant.id}`,
      "GET",
    );
    assert.equal(response.status, 200);
    const listed = (await response.json()) as Array<{ id: string }>;
    assert.deepEqual(
      listed.map((item) => item.id),
      [customer.id],
    );
    response = await api(base, browser, "/api/enterprise/customers", "POST", {
      tenantId: tenant.id,
      name: "Beta",
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { id: string; type: string };
    assert.equal(created.type, "");
    response = await api(base, browser, `/api/enterprise/customers/${created.id}`, "PATCH", {
      name: "Beta",
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { type: string }).type, "");
    // 专家模型:激活只是记账,任何激活都不触发 runtime 启停;切换客户
    // 由原生工作区 tab 完成,runtime 在首个原生请求时才 ensure。
    for (const target of [created.id, created.id, customer.id, created.id]) {
      response = await api(
        base,
        browser,
        `/api/enterprise/customers/${target}/activate`,
        "POST",
        {},
      );
      assert.equal(response.status, 200);
    }
    assert.equal(starts, 0);
    assert.equal(stops, 0);
    response = await fetch(`${base}/api/enterprise/bootstrap`, {
      headers: { cookie: browser.cookie },
    });
    assert.equal(response.status, 200);
    const bootstrap = (await response.json()) as {
      activeCustomer: { id: string; workspacePath: string } | null;
    };
    assert.equal(bootstrap.activeCustomer?.id, created.id);
    assert.equal(
      bootstrap.activeCustomer?.workspacePath,
      join(dir, "workspaces", "customers", created.id),
    );
  } finally {
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
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
  const value = await store.createCustomer(user.id, tenant.id, { name: "Widget works" });
  const markerPath = join(value.workspacePath, "marker.txt");
  await writeFile(markerPath, "stable workspace file");
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
      `/api/enterprise/customers/${value.id}/activate`,
      "POST",
      {},
    );
    assert.equal(response.status, 200);
    const before = await stat(markerPath, { bigint: true });
    const proxied = await rawGet(`${base}/api/test`, {
      cookie: `${browser.cookie}; zcode_lite_token=attacker`,
      authorization: "Bearer attacker",
      connection: "X-Private",
      "x-private": "must-not-reach-runtime",
      "x-forwarded-host": "attacker.example.test",
    });
    const after = await stat(markerPath, { bigint: true });
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
  const value = await store.createCustomer(admin.id, tenant.id, { name: "Widget works" });
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
  store.activateCustomer(memberAuth.session.id, value.id);
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
      `/api/enterprise/tenants/${tenant.id}/users/${member.id}`,
      "DELETE",
    );
    assert.equal(response.status, 200);
    await clientClosed;
    assert.equal(store.getActiveCustomer(memberAuth.session.id), null);
  } finally {
    client.destroy();
    await gateway.close();
    for (const socket of nativeSockets) socket.destroy();
    await closeServer(native);
    store.close();
  }
});

test("MCP relay streams through one Customer binding without writing the upstream secret into the workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-mcp-"));
  await writeFile(join(dir, "index.html"), "ready");
  const secret = "never-write-this-real-secret";
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
  const prefix = `ZCODE_ENTERPRISE_MCP_SECRET_${tenant.id.replaceAll("-", "").toUpperCase()}_`;
  const secretRef = `${prefix}GATEWAY_TEST`;
  const missingSecretRef = `${prefix}EXPECTED_MISSING`;
  const priorSecret = process.env[secretRef];
  const priorMissingSecret = process.env[missingSecretRef];
  const priorAllowlist = process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
  process.env[secretRef] = secret;
  delete process.env[missingSecretRef];
  process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = JSON.stringify({
    [tenant.id]: ["https://mcp.example.test", "https://optional.example.test"],
  });
  const value = await store.createCustomer(user.id, tenant.id, { name: "Widget works" });
  const binding = await store.createCustomerMcpBinding(user.id, value.id, {
    name: "support-mcp",
    endpoint: "https://mcp.example.test/stream",
    secretRef,
  });
  const missingBinding = await store.createCustomerMcpBinding(user.id, value.id, {
    name: "optional-mcp",
    endpoint: "https://optional.example.test/stream",
    secretRef: missingSecretRef,
  });
  missingBindingId = missingBinding.id;
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9"),
    staticRoot: dir,
    port: 0,
    fetchImpl,
    mcpDnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await login(base, "admin@example.test");
    // 专家模型:工作区物化发生在 CRUD(这里直接调用与路由等价的实现),
    // 激活不再触发任何 runtime/物化动作。
    await materializeCustomer(value, store, user.id, base);

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
      readFile(
        join(
          dirname(value.workspacePath),
          ".enterprise-managed",
          `${basename(value.workspacePath)}.json`,
        ),
        "utf8",
      ),
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
    if (priorAllowlist === undefined) delete process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
    else process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = priorAllowlist;
    await gateway.close();
    store.close();
  }
});

test("the enterprise settings read routes reject members across the whole surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-settings-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: Buffer.alloc(32, 0x42),
  });
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "settings-admin@example.test", hash);
  const member = store.provisionUser(user.id, tenant.id, {
    email: "settings-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const customer = await store.createCustomer(user.id, tenant.id, { name: "Acme" });
  store.createTenantSkill(user.id, tenant.id, { name: "handbook", content: "# Handbook\n" });
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9"),
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const adminSession = await login(base, user.email);
    const memberSession = await login(base, member.user.email);
    // 设置面全部只读路由:成员 403,管理员 200。
    const readPaths = [
      `/api/enterprise/tenants/${tenant.id}/model-providers`,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      `/api/enterprise/tenants/${tenant.id}/skills`,
      `/api/enterprise/tenants/${tenant.id}/importable-skills`,
      `/api/enterprise/customers/${customer.id}/skills`,
      `/api/enterprise/customers/${customer.id}/mcp-bindings`,
    ];
    for (const readPath of readPaths) {
      const denied = await api(base, memberSession, readPath, "GET");
      assert.equal(denied.status, 403, readPath);
      const allowed = await api(base, adminSession, readPath, "GET");
      assert.equal(allowed.status, 200, readPath);
    }
    // 工作台就绪信号是成员唯一可读的设置邻接端点:无供应商时 ready=false。
    let response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/model-status`,
      "GET",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ready: false });
    store.createTenantModelProvider(user.id, tenant.id, {
      providerKey: "acme",
      displayName: "Acme",
      apiType: "openai-chat-completions",
      baseUrl: "https://acme.example.com/v1",
      apiKey: "key-1234",
      models: ["acme-a"],
    });
    response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/model-status`,
      "GET",
    );
    assert.deepEqual(await response.json(), { ready: true });
  } finally {
    await gateway.close();
    store.close();
  }
});

test("tenant connector API is admin-gated and relays with a stable token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-connectors-"));
  await writeFile(join(dir, "index.html"), "ready");
  const secret = "connector-upstream-secret";
  let fetchCount = 0;
  let upstreamAuthorization: string | undefined;
  let upstreamApiKeyHeader: string | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    fetchCount += 1;
    const headers = init?.headers as Record<string, string>;
    upstreamAuthorization = headers.authorization;
    upstreamApiKeyHeader = headers["x-api-key"];
    return new Response('event: message\ndata: {"ok":true}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "connector-admin@example.test", hash);
  const member = store.provisionUser(user.id, tenant.id, {
    email: "connector-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const secretEnv = `ZCODE_ENTERPRISE_MCP_SECRET_${tenant.id.replaceAll("-", "").toUpperCase()}_GATEWAY`;
  const priorSecret = process.env[secretEnv];
  const priorAllowlist = process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
  process.env[secretEnv] = secret;
  process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = JSON.stringify({
    [tenant.id]: ["https://system-mcp.example.test"],
  });
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9"),
    staticRoot: dir,
    port: 0,
    fetchImpl,
    mcpDnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const adminSession = await login(base, user.email);
    const memberSession = await login(base, member.user.email);
    let response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "POST",
      {
        connectorKey: "denied",
        displayName: "Denied",
        url: "https://system-mcp.example.test/mcp",
        secretEnv,
      },
    );
    assert.equal(response.status, 403);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "POST",
      {
        connectorKey: "search",
        displayName: "Search connector",
        url: "https://system-mcp.example.test/mcp",
        secretEnv,
      },
    );
    assert.equal(response.status, 201);
    const connector = (await response.json()) as {
      id: string;
      endpointHost: string;
      secretConfigured: boolean;
    };
    assert.equal(connector.endpointHost, "system-mcp.example.test");
    assert.equal(connector.secretConfigured, true);
    // 非 allowlist endpoint 与非租户前缀 secret 引用被拒。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "POST",
      {
        connectorKey: "outside",
        displayName: "Outside",
        url: "https://outside.example.test/mcp",
        secretEnv,
      },
    );
    assert.equal(response.status, 400);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "POST",
      {
        connectorKey: "badsecret",
        displayName: "Bad secret",
        url: "https://system-mcp.example.test/mcp",
        secretEnv: "ZCODE_ENTERPRISE_MCP_SECRET_OTHER_NAME",
      },
    );
    assert.equal(response.status, 400);
    // 企业设置为管理员专属:成员读连接器列表 403;脱敏投影改由管理员视角断言。
    response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "GET",
    );
    assert.equal(response.status, 403);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "GET",
    );
    assert.equal(response.status, 200);
    const adminView = (await response.json()) as Array<Record<string, unknown>>;
    assert.equal(adminView.length, 1);
    assert.equal(JSON.stringify(adminView).includes(secret), false);
    assert.equal("token" in (adminView[0] ?? {}), false);

    const token = store.ensureMcpConnectorToken(connector.id);
    const relayPath = `/api/enterprise/mcp-relay/t/${connector.id}`;
    let relayResponse = await fetch(`${base}${relayPath}`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-value-aaaaaaaaaaaaaaaaaaaa" },
      body: "{}",
    });
    assert.equal(relayResponse.status, 401);
    assert.equal(fetchCount, 0);
    relayResponse = await fetch(`${base}${relayPath}`, {
      method: "POST",
      headers: { authorization: "Bearer totally-wrong-token-aaaaaaaaaaaaaaaaa" },
      body: "{}",
    });
    assert.equal(relayResponse.status, 401);
    relayResponse = await fetch(`${base}${relayPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(relayResponse.status, 200);
    assert.match(await relayResponse.text(), /event: message/);
    assert.equal(fetchCount, 1);
    assert.equal(upstreamAuthorization, `Bearer ${secret}`);

    // 自定义上游头名:注入到指定头而不是 Authorization。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/mcp-connectors/${connector.id}`,
      "PATCH",
      {
        headerName: "x-api-key",
      },
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { headerName: string }).headerName, "x-api-key");
    relayResponse = await fetch(`${base}${relayPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(relayResponse.status, 200);
    assert.equal(upstreamApiKeyHeader, `Bearer ${secret}`);
    assert.equal(upstreamAuthorization, undefined);

    // 停用后中继立即拒绝。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/mcp-connectors/${connector.id}`,
      "PATCH",
      {
        enabled: false,
      },
    );
    assert.equal(response.status, 200);
    relayResponse = await fetch(`${base}${relayPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    assert.equal(relayResponse.status, 401);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/mcp-connectors/${connector.id}`,
      "DELETE",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    if (priorSecret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = priorSecret;
    if (priorAllowlist === undefined) delete process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
    else process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = priorAllowlist;
    await gateway.close();
    store.close();
  }
});

test("admins import a personal skill from their expert runtime home", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-skill-import-"));
  await writeFile(join(dir, "index.html"), "ready");
  const runtimeDataRoot = join(dir, "runtime-data");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "skill-admin@example.test", hash);
  const member = store.provisionUser(user.id, tenant.id, {
    email: "skill-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const skillHome = join(runtimeDataRoot, expertRuntimeId(user.id, tenant.id), ".zcode", "skills");
  await mkdir(join(skillHome, "my-playbook"), { recursive: true });
  await writeFile(join(skillHome, "my-playbook", "SKILL.md"), "# My playbook\n");
  await mkdir(join(skillHome, "nested", "deep-skill"), { recursive: true });
  await writeFile(join(skillHome, "nested", "deep-skill", "SKILL.md"), "# Nested\n");
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9"),
    staticRoot: dir,
    port: 0,
    modelRuntimeDataRoot: runtimeDataRoot,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const adminSession = await login(base, user.email);
    const memberSession = await login(base, member.user.email);
    let response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "my-playbook", origin: "home" },
    );
    assert.equal(response.status, 403);
    // 目录穿越与非法名一律 400;缺失的 Skill 404;非法 origin 400。
    for (const name of ["../acme", "/etc/passwd", "My Playbook", "a//b", "."]) {
      response = await api(
        base,
        adminSession,
        `/api/enterprise/tenants/${tenant.id}/skills/import`,
        "POST",
        { name, origin: "home" },
      );
      assert.equal(response.status, 400, name);
    }
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "my-playbook", origin: "bogus" },
    );
    assert.equal(response.status, 400);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "missing-skill", origin: "home" },
    );
    assert.equal(response.status, 404);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "my-playbook", origin: "home" },
    );
    assert.equal(response.status, 201);
    const imported = (await response.json()) as {
      ok: boolean;
      skill: { id: string; name: string };
    };
    assert.equal(imported.ok, true);
    assert.equal(imported.skill.name, "my-playbook");
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "nested/deep-skill", origin: "home" },
    );
    assert.equal(response.status, 201);
    response = await api(base, adminSession, `/api/enterprise/tenants/${tenant.id}/skills`, "GET");
    const skills = (
      (await response.json()) as { items: Array<{ id: string; name: string; content: string }> }
    ).items;
    assert.deepEqual(skills.map((skill) => skill.name).sort(), [
      "my-playbook",
      "nested/deep-skill",
    ]);
    assert.equal(skills.find((skill) => skill.name === "my-playbook")!.content, "# My playbook\n");
    // 成员不可导入,导入产生的内容成员可读。
    response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "nested/deep-skill", origin: "home" },
    );
    assert.equal(response.status, 403);
  } finally {
    await gateway.close();
    store.close();
  }
});

test("importable skill listing covers expert home and customer workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-skill-listing-"));
  await writeFile(join(dir, "index.html"), "ready");
  const runtimeDataRoot = join(dir, "runtime-data");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "skill-list@example.test", hash);
  const member = store.provisionUser(user.id, tenant.id, {
    email: "skill-list-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const customer = await store.createCustomer(user.id, tenant.id, { name: "Acme" });
  // 原生 skill-creator 默认把新 Skill 建在项目级(客户 workspace)。
  const workspaceAgents = join(customer.workspacePath, ".agents", "skills");
  await mkdir(join(workspaceAgents, "deploy-helper"), { recursive: true });
  await writeFile(
    join(workspaceAgents, "deploy-helper", "SKILL.md"),
    "---\nname: deploy-helper\ndescription: Deploy runbooks for Acme clusters.\n---\n# Deploy\n",
  );
  // 托管前缀目录必须被排除;HOME 的 `.agents` 根也要被扫描。
  await mkdir(join(customer.workspacePath, ".zcode", "skills", "enterprise-managed"), {
    recursive: true,
  });
  await writeFile(
    join(customer.workspacePath, ".zcode", "skills", "enterprise-managed", "SKILL.md"),
    "# managed\n",
  );
  const homeAgents = join(
    runtimeDataRoot,
    expertRuntimeId(user.id, tenant.id),
    ".agents",
    "skills",
  );
  await mkdir(join(homeAgents, "personal-thing"), { recursive: true });
  await writeFile(
    join(homeAgents, "personal-thing", "SKILL.md"),
    "---\nname: personal-thing\ndescription: Personal helper kept in HOME.\n---\n# Helper\n",
  );
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9"),
    staticRoot: dir,
    port: 0,
    modelRuntimeDataRoot: runtimeDataRoot,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  type Importable = {
    name: string;
    description: string;
    origin: string;
    workspaceId: string | null;
    workspaceName: string | null;
    alreadyImported: boolean;
  };
  try {
    const adminSession = await login(base, user.email);
    const memberSession = await login(base, member.user.email);
    let response = await api(
      base,
      memberSession,
      `/api/enterprise/tenants/${tenant.id}/importable-skills`,
      "GET",
    );
    assert.equal(response.status, 403);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/importable-skills`,
      "GET",
    );
    assert.equal(response.status, 200);
    const listing = (await response.json()) as Importable[];
    assert.deepEqual(listing.map((item) => [item.name, item.origin, item.workspaceName]).sort(), [
      ["deploy-helper", "workspace", "Acme"],
      ["personal-thing", "home", null],
    ]);
    assert.equal(
      listing.find((item) => item.name === "deploy-helper")!.description,
      "Deploy runbooks for Acme clusters.",
    );
    // 工作区来源必须带 workspaceId 才能命中;导入后清单翻转为已导入。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "deploy-helper", origin: "workspace" },
    );
    assert.equal(response.status, 404);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/skills/import`,
      "POST",
      { name: "deploy-helper", origin: "workspace", workspaceId: customer.id },
    );
    assert.equal(response.status, 201);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/importable-skills`,
      "GET",
    );
    const refreshed = (await response.json()) as Importable[];
    assert.equal(refreshed.find((item) => item.name === "deploy-helper")!.alreadyImported, true);
    assert.equal(refreshed.find((item) => item.name === "personal-thing")!.alreadyImported, false);
  } finally {
    await gateway.close();
    store.close();
  }
});

test("tenant runtime stops destroy the session socket instead of leaving it half-open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-socket-close-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "socket-close@example.test", hash);
  const customer = await store.createCustomer(user.id, tenant.id, { name: "Acme" });
  // 代理需要一个真实 ws 目标才能完成升级握手。
  const runtimeTarget = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(runtimeTarget, "listening");
  const runtimePort = (runtimeTarget.address() as AddressInfo).port;
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor(`http://127.0.0.1:${runtimePort}`),
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await login(base, user.email);
    const activated = await api(
      base,
      browser,
      `/api/enterprise/customers/${customer.id}/activate`,
      "POST",
      {},
    );
    assert.equal(activated.status, 200);
    const socket = new NodeWebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Cookie: browser.cookie, Origin: base },
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await once(socket, "open");
    // 客户 CRUD 停掉租户 runtime:指向它的会话 socket 必须被同步销毁。
    // 半开 socket 上的 RPC 永远无响应,正是"技能面板停在搜索中"的根因。
    const created = await api(base, browser, "/api/enterprise/customers", "POST", {
      tenantId: tenant.id,
      name: "Beta",
    });
    assert.equal(created.status, 201);
    await Promise.race([
      closed,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("session socket was not closed")), 5_000),
      ),
    ]);
    socket.close();
  } finally {
    await new Promise<void>((resolve) => {
      runtimeTarget.close(() => resolve());
    });
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("user-authorized connectors run the oauth flow per user and relay private tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-user-oauth-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: Buffer.alloc(32, 0x42),
  });
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user: admin } = store.bootstrapAdmin(
    "Tenant",
    "oauth-flow-admin@example.test",
    hash,
  );
  const memberA = store.provisionUser(admin.id, tenant.id, {
    email: "oauth-a@example.test",
    passwordHash: hash,
    role: "member",
  });
  const memberB = store.provisionUser(admin.id, tenant.id, {
    email: "oauth-b@example.test",
    passwordHash: hash,
    role: "member",
  });
  const tokenUrl = "https://oauth.example.test/token";
  const endpoint = "https://user-mcp.example.test/mcp";
  const tokenRequests: Array<{ body: string }> = [];
  let upstreamAuthorization: string | undefined;
  let refreshFails = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === tokenUrl) {
      const body = String(init?.body);
      tokenRequests.push({ body });
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        if (refreshFails) return new Response("{}", { status: 400 });
        return new Response(
          JSON.stringify({
            access_token: "member-a-access-refreshed",
            refresh_token: "member-a-refresh-2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const code = params.get("code");
      return new Response(
        JSON.stringify({
          access_token: code === "code-b" ? "member-b-access-1" : "member-a-access-1",
          refresh_token: code === "code-b" ? "member-b-refresh-1" : "member-a-refresh-1",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const headers = init?.headers as Record<string, string>;
    upstreamAuthorization = headers.authorization;
    return new Response('event: message\ndata: {"ok":true}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const priorAllowlist = process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
  process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = JSON.stringify({
    [tenant.id]: ["https://user-mcp.example.test"],
  });
  const gateway = createEnterpriseGateway({
    store,
    auth: new EnterpriseAuth(store),
    runtimes: managerFor("http://127.0.0.1:9"),
    staticRoot: dir,
    port: 0,
    fetchImpl,
    mcpDnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const relayPath = (connectorId: string) => `/api/enterprise/mcp-relay/t/${connectorId}`;
  try {
    const adminSession = await login(base, admin.email);
    const sessionA = await login(base, memberA.user.email);
    const sessionB = await login(base, memberB.user.email);
    // 管理员创建 user-oauth 连接器(成员创建被拒)。
    let response = await api(
      base,
      sessionA,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "POST",
      {
        connectorKey: "drive",
        displayName: "Drive",
        url: endpoint,
        authMode: "user-oauth",
        authorizeUrl: "https://oauth.example.test/authorize",
        tokenUrl,
        clientId: "client-1",
        clientSecret: "confidential-client-secret",
        scopes: "mcp.read mcp.write",
      },
    );
    assert.equal(response.status, 403);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "POST",
      {
        connectorKey: "drive",
        displayName: "Drive",
        url: endpoint,
        authMode: "user-oauth",
        authorizeUrl: "https://oauth.example.test/authorize",
        tokenUrl,
        clientId: "client-1",
        clientSecret: "confidential-client-secret",
        scopes: "mcp.read mcp.write",
      },
    );
    assert.equal(response.status, 201);
    const connector = (await response.json()) as {
      id: string;
      authMode: string;
      authorized: boolean;
    };
    assert.equal(connector.authMode, "user-oauth");
    assert.equal(connector.authorized, false);

    // authorize 返回带签名 state 的供应商地址;共享模式连接器不允许 authorize。
    response = await api(
      base,
      sessionA,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors/${connector.id}/authorize`,
      "GET",
    );
    assert.equal(response.status, 200);
    const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
    const parsedAuthorize = new URL(authorizeUrl);
    assert.equal(parsedAuthorize.origin, "https://oauth.example.test");
    assert.equal(parsedAuthorize.pathname, "/authorize");
    assert.equal(parsedAuthorize.searchParams.get("client_id"), "client-1");
    assert.equal(parsedAuthorize.searchParams.get("response_type"), "code");
    assert.equal(parsedAuthorize.searchParams.get("scope"), "mcp.read mcp.write");
    assert.equal(
      parsedAuthorize.searchParams.get("redirect_uri"),
      `${base}/api/enterprise/tenants/${tenant.id}/mcp-connectors/${connector.id}/callback`,
    );
    const state = parsedAuthorize.searchParams.get("state")!;
    assert.ok(state);

    // 坏 state / error 参数 / 他人会话的 state 一律 302 到失败标记。
    const callbackPath = `/api/enterprise/tenants/${tenant.id}/mcp-connectors/${connector.id}/callback`;
    for (const query of ["?error=access_denied", "?code=code-a&state=tampered", ""]) {
      const failed = await fetch(`${base}${callbackPath}${query}`, {
        headers: { cookie: sessionA.cookie },
        redirect: "manual",
      });
      assert.equal(failed.status, 302, query);
      assert.equal(failed.headers.get("location"), "/?enterpriseOauth=failed");
    }
    const wrongSession = await fetch(
      `${base}${callbackPath}?code=code-a&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: sessionB.cookie },
        redirect: "manual",
      },
    );
    assert.equal(wrongSession.status, 302);
    assert.equal(wrongSession.headers.get("location"), "/?enterpriseOauth=failed");

    // 成员 A 完成回调:服务端换码,302 回根路径。
    response = await fetch(
      `${base}${callbackPath}?code=code-a&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: sessionA.cookie },
        redirect: "manual",
      },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    assert.equal(tokenRequests.length, 1);
    const exchanged = new URLSearchParams(tokenRequests[0]!.body);
    assert.equal(exchanged.get("grant_type"), "authorization_code");
    assert.equal(exchanged.get("code"), "code-a");
    assert.equal(exchanged.get("client_id"), "client-1");
    assert.equal(exchanged.get("client_secret"), "confidential-client-secret");
    assert.equal(
      exchanged.get("redirect_uri"),
      `${base}/api/enterprise/tenants/${tenant.id}/mcp-connectors/${connector.id}/callback`,
    );

    // 连接器列表是管理员专属读面:成员 403;按用户的授权状态以"操作者本人"为口径,
    // 成员 A/B 的差异由下方 store 断言与中继注入行为覆盖。
    response = await api(
      base,
      sessionA,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "GET",
    );
    assert.equal(response.status, 403);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "GET",
    );
    assert.equal(((await response.json()) as Array<{ authorized: boolean }>)[0]!.authorized, false);

    // 中继:A 的 relay token 注入 A 的 access token;错误令牌 401。
    const relayTokenA = store.userConnectorAuthorization(connector.id, memberA.user.id)!.relayToken;
    assert.equal(
      store.userConnectorAuthorization(connector.id, memberB.user.id),
      null,
      "member B must not hold an authorization",
    );
    let relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-user-token-aaaaaaaaaaaaaaaaaaaa",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(relayResponse.status, 401);
    relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relayTokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(relayResponse.status, 200);
    assert.match(await relayResponse.text(), /event: message/);
    assert.equal(upstreamAuthorization, "Bearer member-a-access-1");

    // 过期 + refresh:先刷新再放行,新 token 注入上游并持久化。
    store.upsertUserConnectorAuthorization({
      connectorId: connector.id,
      userId: memberA.user.id,
      accessToken: "member-a-access-1",
      refreshToken: "member-a-refresh-1",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relayTokenA}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(relayResponse.status, 200);
    assert.equal(upstreamAuthorization, "Bearer member-a-access-refreshed");
    assert.equal(tokenRequests.length, 2);
    const refreshed = new URLSearchParams(tokenRequests[1]!.body);
    assert.equal(refreshed.get("grant_type"), "refresh_token");
    assert.equal(refreshed.get("refresh_token"), "member-a-refresh-1");
    // 未再过期时复用持久化的新 token,不重复刷新。
    relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relayTokenA}` },
      body: "{}",
    });
    assert.equal(relayResponse.status, 200);
    assert.equal(upstreamAuthorization, "Bearer member-a-access-refreshed");
    assert.equal(tokenRequests.length, 2);

    // 刷新失败:503 诊断,授权保留等待重新连接。
    refreshFails = true;
    store.upsertUserConnectorAuthorization({
      connectorId: connector.id,
      userId: memberA.user.id,
      accessToken: "member-a-access-refreshed",
      refreshToken: "member-a-refresh-2",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relayTokenA}` },
      body: "{}",
    });
    assert.equal(relayResponse.status, 503);
    refreshFails = false;

    // B 走自己的授权流程,中继注入 B 的 token。
    response = await api(
      base,
      sessionB,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors/${connector.id}/authorize`,
      "GET",
    );
    const stateB = new URL(
      ((await response.json()) as { authorizeUrl: string }).authorizeUrl,
    ).searchParams.get("state")!;
    response = await fetch(
      `${base}${callbackPath}?code=code-b&state=${encodeURIComponent(stateB)}`,
      {
        headers: { cookie: sessionB.cookie },
        redirect: "manual",
      },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    const relayTokenB = store.userConnectorAuthorization(connector.id, memberB.user.id)!.relayToken;
    assert.notEqual(relayTokenB, relayTokenA);
    relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relayTokenB}` },
      body: "{}",
    });
    assert.equal(relayResponse.status, 200);
    assert.equal(upstreamAuthorization, "Bearer member-b-access-1");

    // 撤销:成员只能撤销自己的行;撤销后中继拒绝,他人不受影响。
    response = await api(
      base,
      sessionB,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors/${connector.id}/authorization`,
      "DELETE",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relayTokenB}` },
      body: "{}",
    });
    assert.equal(relayResponse.status, 401);
    relayResponse = await fetch(`${base}${relayPath(connector.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relayTokenA}` },
      body: "{}",
    });
    assert.equal(relayResponse.status, 200);
    // 成员读列表已随设置面收紧为 403;撤销效果由上方中继 401 与 store 断言覆盖。
    response = await api(
      base,
      sessionB,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "GET",
    );
    assert.equal(response.status, 403);
    // 撤销不存在的行 → 404。
    response = await api(
      base,
      sessionB,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors/${connector.id}/authorization`,
      "DELETE",
    );
    assert.equal(response.status, 404);
    // 令牌/密文绝不进 API 响应(成员读已 403,扫描管理员视角的同一投影)。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/mcp-connectors`,
      "GET",
    );
    const listingBody = await response.text();
    for (const secret of [
      "member-a-access-1",
      "member-a-access-refreshed",
      "confidential-client-secret",
      relayTokenA,
    ]) {
      assert.equal(listingBody.includes(secret), false);
    }
  } finally {
    if (priorAllowlist === undefined) delete process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
    else process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = priorAllowlist;
    await gateway.close();
    store.close();
  }
});

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 记录 start/stop 事件的假 adapter:input.id 已被 manager 规范化为 runtimeId。 */
function recordingManagerFor(url: string): { manager: RuntimeManager; events: string[] } {
  const events: string[] = [];
  const manager = new RuntimeManager({
    async start(input) {
      events.push(`start:${input.id}`);
      return {
        id: `fake-${input.id}`,
        url,
        workspacePath: input.workspacePath,
        stop: async () => {
          events.push(`stop:${input.id}`);
        },
      };
    },
    async healthy() {
      return true;
    },
  });
  return { manager, events };
}

/** 侦查 stop 调用:回收/驱逐必须复用传入 beforeStop 的 fail-fast 停止路径。 */
class StopSpyRuntimeManager extends RuntimeManager {
  readonly stopCalls: Array<{ runtimeId: string; beforeStopRan: boolean }> = [];
  override async stop(caseInfo: RuntimeCase, beforeStop?: () => void): Promise<void> {
    let beforeStopRan = false;
    await super.stop(caseInfo, () => {
      beforeStopRan = true;
      beforeStop?.();
    });
    this.stopCalls.push({ runtimeId: caseInfo.runtimeId ?? caseInfo.id, beforeStopRan });
  }
}

/** 触发一次原生代理请求:ensureRuntime 在代理前完成,不需要目标可达。 */
async function ensureViaProxy(base: string, token: string): Promise<void> {
  await fetch(`${base}/api/server-info`, {
    headers: { cookie: `enterprise_session=${token}` },
  });
}

test("idle reaping is disabled by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-reap-off-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "reap-off@example.test", hash);
  const customer = await store.createCustomer(user.id, tenant.id, { name: "Acme" });
  const auth = new EnterpriseAuth(store);
  const { manager, events } = recordingManagerFor("http://127.0.0.1:9");
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: manager,
    staticRoot: dir,
    port: 0,
    // 未设置 runtimeIdleMs:即使间隔配置存在也绝不回收,开发行为保持不变。
    runtimeReapIntervalMs: 25,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await auth.login(user.email, password);
    store.activateCustomer(browser.session.id, customer.id);
    await ensureViaProxy(base, browser.token);
    const target = store.getActiveRuntimeTarget(browser.session.id)!;
    assert.ok(manager.getBinding(target));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      events.filter((event) => event.startsWith("stop:")),
      [],
    );
    assert.ok(manager.getBinding(target), "an idle runtime must survive when reaping is off");
  } finally {
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an idle runtime without attached sockets is reaped through the fail-fast stop path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-reap-idle-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "reap-idle@example.test", hash);
  const customer = await store.createCustomer(user.id, tenant.id, { name: "Acme" });
  const auth = new EnterpriseAuth(store);
  const manager = new StopSpyRuntimeManager({
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
  });
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: manager,
    staticRoot: dir,
    port: 0,
    runtimeIdleMs: 60,
    runtimeReapIntervalMs: 25,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await auth.login(user.email, password);
    store.activateCustomer(browser.session.id, customer.id);
    await ensureViaProxy(base, browser.token);
    const target = store.getActiveRuntimeTarget(browser.session.id)!;
    assert.ok(manager.getBinding(target));
    await waitFor("idle runtime to be reaped", () => manager.stopCalls.length > 0);
    assert.deepEqual(
      manager.stopCalls.map((call) => [call.runtimeId, call.beforeStopRan]),
      // 回收必须经过与租户变更相同的 stopRuntime:空闲定义下本无附着 socket,
      // 断言 beforeStop 已传递并执行,即等价于"销毁 socket 后停止"的共享路径。
      [[target.runtimeId, true]],
    );
    await waitFor("reaped runtime to leave the live set", () => !manager.getBinding(target));
  } finally {
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an attached session socket keeps the runtime alive until it detaches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-reap-attached-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user } = store.bootstrapAdmin("Tenant", "reap-attached@example.test", hash);
  const customer = await store.createCustomer(user.id, tenant.id, { name: "Acme" });
  const runtimeTarget = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(runtimeTarget, "listening");
  const runtimePort = (runtimeTarget.address() as AddressInfo).port;
  const { manager, events } = recordingManagerFor(`http://127.0.0.1:${runtimePort}`);
  const auth = new EnterpriseAuth(store);
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: manager,
    staticRoot: dir,
    port: 0,
    runtimeIdleMs: 60,
    runtimeReapIntervalMs: 25,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await auth.login(user.email, password);
    const activated = await fetch(`${base}/api/enterprise/customers/${customer.id}/activate`, {
      method: "POST",
      headers: {
        cookie: `enterprise_session=${browser.token}; enterprise_csrf=${browser.csrfToken}`,
        origin: base,
        "x-csrf-token": browser.csrfToken,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(activated.status, 200);
    // ws 升级本身会 ensureRuntime;打开的浏览器 tab 就是持续活跃信号。
    const socket = new NodeWebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Cookie: `enterprise_session=${browser.token}`, Origin: base },
    });
    await once(socket, "open");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(
      events.filter((event) => event.startsWith("stop:")),
      [],
    );
    const target = store.getActiveRuntimeTarget(browser.session.id);
    assert.ok(target, "attached runtime target");
    assert.ok(manager.getBinding(target), "an attached runtime must not be reaped");
    socket.close();
    await waitFor("detached runtime to be reaped", () =>
      events.some((event) => event.startsWith("stop:")),
    );
  } finally {
    await new Promise<void>((resolve) => {
      runtimeTarget.close(() => resolve());
    });
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the runtime cap evicts the least-recently-active idle runtime before admitting a new one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-cap-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user: admin } = store.bootstrapAdmin("Tenant", "cap-admin@example.test", hash);
  const { user: member } = store.provisionUser(admin.id, tenant.id, {
    email: "cap-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const customer = await store.createCustomer(admin.id, tenant.id, { name: "Acme" });
  const auth = new EnterpriseAuth(store);
  const { manager, events } = recordingManagerFor("http://127.0.0.1:9");
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: manager,
    staticRoot: dir,
    port: 0,
    maxRuntimes: 1,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const bindingFor = (userId: string): EnterpriseRuntimeTarget => ({
    id: expertRuntimeId(userId, tenant.id),
    runtimeId: expertRuntimeId(userId, tenant.id),
    tenantId: tenant.id,
    userId,
    workspacePath: customer.workspacePath,
    kind: "expert",
  });
  try {
    const adminAuth = await auth.login(admin.email, password);
    store.activateCustomer(adminAuth.session.id, customer.id);
    await ensureViaProxy(base, adminAuth.token);
    assert.ok(manager.getBinding(bindingFor(admin.id)));
    // 第二个专家的 ensure 触发上限:先驱逐空闲的第一个 runtime,再启动新的。
    const memberAuth = await auth.login(member.email, password);
    store.activateCustomer(memberAuth.session.id, customer.id);
    await ensureViaProxy(base, memberAuth.token);
    assert.deepEqual(events, [
      `start:${expertRuntimeId(admin.id, tenant.id)}`,
      `stop:${expertRuntimeId(admin.id, tenant.id)}`,
      `start:${expertRuntimeId(member.id, tenant.id)}`,
    ]);
    assert.equal(manager.getBinding(bindingFor(admin.id)), null);
    assert.ok(manager.getBinding(bindingFor(member.id)));
  } finally {
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cap eviction destroys the evicted expert's attached socket fail-fast", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-cap-socket-"));
  await writeFile(join(dir, "index.html"), "ready");
  const nativeSockets = new Set<Duplex>();
  const native = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  native.on("upgrade", (request, socket) => {
    nativeSockets.add(socket);
    socket.once("close", () => nativeSockets.delete(socket));
    const key = String(request.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  const nativeAddress = await listen(native);
  const nativeOrigin = `http://127.0.0.1:${nativeAddress.port}`;
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user: admin } = store.bootstrapAdmin("Tenant", "cap-ws-admin@example.test", hash);
  const { user: member } = store.provisionUser(admin.id, tenant.id, {
    email: "cap-ws-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const customer = await store.createCustomer(admin.id, tenant.id, { name: "Acme" });
  const auth = new EnterpriseAuth(store);
  const { manager, events } = recordingManagerFor(nativeOrigin);
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: manager,
    staticRoot: dir,
    port: 0,
    maxRuntimes: 1,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // 第一个专家保持浏览器 socket 附着;上限驱逐仍会选它(唯一候选,附着仅降低优先级)。
    const browser = await login(base, admin.email);
    const activated = await api(
      base,
      browser,
      `/api/enterprise/customers/${customer.id}/activate`,
      "POST",
      {},
    );
    assert.equal(activated.status, 200);
    const socket = new NodeWebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Cookie: browser.cookie, Origin: base },
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await once(socket, "open");
    const memberAuth = await auth.login(member.email, password);
    store.activateCustomer(memberAuth.session.id, customer.id);
    await ensureViaProxy(base, memberAuth.token);
    await Promise.race([
      closed,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("evicted expert socket was not destroyed")), 5000),
      ),
    ]);
    assert.ok(events.includes(`stop:${expertRuntimeId(admin.id, tenant.id)}`));
    assert.ok(
      manager.getBinding({
        id: expertRuntimeId(member.id, tenant.id),
        runtimeId: expertRuntimeId(member.id, tenant.id),
        workspacePath: customer.workspacePath,
      }),
    );
  } finally {
    await gateway.close();
    // 网关侧 socket.destroy() 对上游只做半关闭(FIN),原生侧升级 socket 需要显式
    // 销毁,否则 server.close 回调悬置(与 membership 撤销测试相同的收尾方式)。
    for (const socket of nativeSockets) socket.destroy();
    await new Promise<void>((resolve) => {
      native.close(() => resolve());
      native.closeAllConnections();
    });
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("customer visibility filters lists, activation, bootstrap and runtime mounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-visibility-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user: admin } = store.bootstrapAdmin("Tenant", "vis-admin@example.test", hash);
  const { user: member } = store.provisionUser(admin.id, tenant.id, {
    email: "vis-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const alpha = await store.createCustomer(admin.id, tenant.id, { name: "Alpha" });
  const beta = await store.createCustomer(admin.id, tenant.id, { name: "Beta" });
  const gamma = await store.createCustomer(admin.id, tenant.id, { name: "Gamma" });
  const auth = new EnterpriseAuth(store);
  // 侦查 manager:记录每次 start 的完整挂载清单,断言可见性在挂载层生效。
  const starts: Array<{ runtimeId: string; workspacePath: string; workspacePaths: string[] }> = [];
  const stops: string[] = [];
  const manager = new RuntimeManager({
    async start(input) {
      const runtimeId = input.runtimeId ?? input.id;
      starts.push({
        runtimeId,
        workspacePath: input.workspacePath,
        workspacePaths: [...(input.workspacePaths ?? [])],
      });
      return {
        id: `fake-${input.id}`,
        url: "http://127.0.0.1:9",
        workspacePath: input.workspacePath,
        stop: async () => {
          stops.push(runtimeId);
        },
      };
    },
    async healthy() {
      return true;
    },
  });
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: manager,
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const memberRuntimeId = expertRuntimeId(member.id, tenant.id);
  const adminRuntimeId = expertRuntimeId(admin.id, tenant.id);
  const bindingFor = (userId: string): EnterpriseRuntimeTarget => ({
    id: expertRuntimeId(userId, tenant.id),
    runtimeId: expertRuntimeId(userId, tenant.id),
    tenantId: tenant.id,
    userId,
    workspacePath: alpha.workspacePath,
    kind: "expert",
  });
  try {
    const adminSession = await login(base, admin.email);
    const memberSession = await login(base, member.email);
    const memberAuth = await auth.login(member.email, password);
    const bootstrapFor = async (
      session: BrowserSession,
    ): Promise<{ activeCustomer: { id: string } | null }> => {
      const response = await fetch(`${base}/api/enterprise/bootstrap`, {
        headers: { cookie: session.cookie },
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { activeCustomer: { id: string } | null };
    };

    // 无授权成员看到全部(向后兼容的信任默认)。
    let response = await api(
      base,
      memberSession,
      `/api/enterprise/customers?tenantId=${tenant.id}`,
      "GET",
    );
    assert.equal(((await response.json()) as Array<{ id: string }>).length, 3);

    // 成员读成员列表被拒;管理员授权子集 {alpha, gamma}。
    response = await api(base, memberSession, `/api/enterprise/tenants/${tenant.id}/users`, "GET");
    assert.equal(response.status, 403);
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/users/${member.id}/customer-access`,
      "PUT",
      { mode: "selected", customerIds: [gamma.id, alpha.id] },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      customerAccess: { mode: "selected", customerIds: [alpha.id, gamma.id].sort() },
    });

    // 列表过滤:成员只看到授权客户,管理员不受限。
    response = await api(
      base,
      memberSession,
      `/api/enterprise/customers?tenantId=${tenant.id}`,
      "GET",
    );
    assert.deepEqual(
      ((await response.json()) as Array<{ id: string }>).map((customer) => customer.id).sort(),
      [gamma.id, alpha.id].sort(),
    );
    response = await api(
      base,
      adminSession,
      `/api/enterprise/customers?tenantId=${tenant.id}`,
      "GET",
    );
    assert.equal(((await response.json()) as Array<{ id: string }>).length, 3);

    // 激活不可见客户与不存在同响应;可见客户正常激活。
    response = await api(
      base,
      memberSession,
      `/api/enterprise/customers/${beta.id}/activate`,
      "POST",
      {},
    );
    assert.equal(response.status, 404);
    response = await api(
      base,
      memberSession,
      `/api/enterprise/customers/${gamma.id}/activate`,
      "POST",
      {},
    );
    assert.equal(response.status, 200);

    // bootstrap:激活客户仍可见时照常返回。
    assert.equal((await bootstrapFor(memberSession)).activeCustomer?.id, gamma.id);

    // 挂载层:成员 runtime 只挂授权工作区,主工作区保持激活客户;管理员挂全部。
    const adminAuth = await auth.login(admin.email, password);
    // ensureViaProxy 携带的是 auth.login 签发的会话,激活也落在同一会话上。
    store.activateCustomer(memberAuth.session.id, gamma.id);
    store.activateCustomer(adminAuth.session.id, beta.id);
    await ensureViaProxy(base, memberAuth.token);
    await ensureViaProxy(base, adminAuth.token);
    assert.deepEqual(
      starts.map((start) => start.runtimeId),
      [memberRuntimeId, adminRuntimeId],
    );
    assert.equal(starts[0]!.workspacePath, gamma.workspacePath);
    assert.deepEqual(
      [...starts[0]!.workspacePaths].sort(),
      [alpha.workspacePath, gamma.workspacePath].sort(),
    );
    assert.equal(starts[0]!.workspacePaths.includes(beta.workspacePath), false);
    assert.equal(starts[1]!.workspacePath, beta.workspacePath);
    assert.deepEqual(
      [...starts[1]!.workspacePaths].sort(),
      [alpha.workspacePath, beta.workspacePath, gamma.workspacePath].sort(),
    );

    // 仅改显示名:不触发任何停机。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/users/${member.id}`,
      "PATCH",
      { displayName: "Visible Member" },
    );
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { displayName: string }).displayName,
      "Visible Member",
    );
    assert.deepEqual(stops, []);
    assert.ok(manager.getBinding(bindingFor(member.id)));
    assert.ok(manager.getBinding(bindingFor(admin.id)));

    // 授权变化只停该成员自己的 runtime;管理员 runtime 不受牵连。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/users/${member.id}/customer-access`,
      "PUT",
      { mode: "selected", customerIds: [alpha.id] },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(stops, [memberRuntimeId]);
    assert.equal(manager.getBinding(bindingFor(member.id)), null);
    assert.ok(manager.getBinding(bindingFor(admin.id)));

    // bootstrap:激活客户(gamma)不再可见 → null,壳层会自动激活第一个可见客户。
    assert.equal((await bootstrapFor(memberSession)).activeCustomer, null);

    // 主工作区回退:会话仍指向 gamma,但 gamma 不可见 → 新 runtime 挂 alpha 且
    // 主工作区回退为第一个可见客户。
    await ensureViaProxy(base, memberAuth.token);
    assert.equal(starts[2]!.workspacePath, alpha.workspacePath);
    assert.deepEqual(starts[2]!.workspacePaths, [alpha.workspacePath]);

    // 管理员读成员列表:投影带可见性摘要;自我降级被守卫拒绝(409)。
    response = await api(base, adminSession, `/api/enterprise/tenants/${tenant.id}/users`, "GET");
    assert.equal(response.status, 200);
    const users = (await response.json()) as Array<{
      id: string;
      customerAccess: { mode: string; customerIds: string[] };
    }>;
    assert.deepEqual(users.find((entry) => entry.id === member.id)!.customerAccess, {
      mode: "selected",
      customerIds: [alpha.id],
    });
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/users/${admin.id}`,
      "PATCH",
      { role: "member" },
    );
    assert.equal(response.status, 409);

    // 禁用:只停该成员 runtime,再次记录一次 member 停机;管理员 runtime 存活。
    response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/users/${member.id}`,
      "PATCH",
      { status: "disabled" },
    );
    assert.equal(((await response.json()) as { status: string }).status, "disabled");
    assert.deepEqual(stops, [memberRuntimeId, memberRuntimeId]);
    assert.ok(manager.getBinding(bindingFor(admin.id)));
  } finally {
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabling a user destroys their live socket and rejects login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-gateway-disable-"));
  await writeFile(join(dir, "index.html"), "ready");
  const store = await EnterpriseStore.open(join(dir, "data.sqlite"), join(dir, "workspaces"));
  const hash = await EnterpriseAuth.hashPassword(password);
  const { tenant, user: admin } = store.bootstrapAdmin(
    "Tenant",
    "disable-admin@example.test",
    hash,
  );
  const { user: member } = store.provisionUser(admin.id, tenant.id, {
    email: "disable-member@example.test",
    passwordHash: hash,
    role: "member",
  });
  const customer = await store.createCustomer(admin.id, tenant.id, { name: "Acme" });
  // 代理需要一个真实 ws 目标才能完成升级握手。
  const runtimeTarget = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(runtimeTarget, "listening");
  const runtimePort = (runtimeTarget.address() as AddressInfo).port;
  const auth = new EnterpriseAuth(store);
  const { manager, events } = recordingManagerFor(`http://127.0.0.1:${runtimePort}`);
  const gateway = createEnterpriseGateway({
    store,
    auth,
    runtimes: manager,
    staticRoot: dir,
    port: 0,
  });
  await gateway.listen();
  const address = gateway.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await login(base, member.email);
    const adminSession = await login(base, admin.email);
    // 禁用前签发的会话:用于验证状态在校验路径上立即生效,不等 socket 清扫。
    const issuedBeforeDisable = await auth.login(member.email, password);
    const activated = await api(
      base,
      browser,
      `/api/enterprise/customers/${customer.id}/activate`,
      "POST",
      {},
    );
    assert.equal(activated.status, 200);
    const socket = new NodeWebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Cookie: browser.cookie, Origin: base },
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await once(socket, "open");
    // 禁用:库状态先变,随后销毁该用户全部会话 socket 并停其本租户 runtime。
    const response = await api(
      base,
      adminSession,
      `/api/enterprise/tenants/${tenant.id}/users/${member.id}`,
      "PATCH",
      { status: "disabled" },
    );
    assert.equal(response.status, 200);
    await Promise.race([
      closed,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("disabled user socket was not destroyed")), 5_000),
      ),
    ]);
    assert.ok(events.includes(`stop:${expertRuntimeId(member.id, tenant.id)}`));
    // 既有会话在下一次校验时立即失效(resolveSession 按 users.status 拒绝)。
    assert.equal(auth.resolveSession(issuedBeforeDisable.token), null);
    // 重新登录被拒:与错误密码相同的 invalid-credentials 路径,不泄露失败原因。
    const relogin = await fetch(`${base}/api/enterprise/login`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ email: member.email, password }),
    });
    assert.equal(relogin.status, 401);
  } finally {
    await new Promise<void>((resolve) => {
      runtimeTarget.close(() => resolve());
    });
    await gateway.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
