import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { EnterpriseAuth } from "../../src/auth.js";
import { createEnterpriseGateway } from "../../src/gateway.js";
import { ContainerRuntimeAdapter, RuntimeManager } from "../../src/runtime.js";
import { EnterpriseStore } from "../../src/store.js";
import { smokeNativeSession } from "./native-session-smoke.js";

const execFile = promisify(execFileCallback);
const enabled = process.env.RUN_ENTERPRISE_DOCKER_E2E === "1";

async function availablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function webSocketHandshake(
  port: number,
  origin: string,
  cookie?: string,
): Promise<{ status: number; socket: Socket }> {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  const headers = [
    "GET /ws HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Origin: ${origin}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    ...(cookie ? [`Cookie: ${cookie}`] : []),
    "",
    "",
  ];
  const status = await new Promise<number>((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => reject(new Error("WebSocket handshake timed out")), 10_000);
    const onData = (chunk: Buffer) => {
      received += chunk.toString();
      if (!received.includes("\r\n\r\n")) return;
      clearTimeout(timeout);
      socket.off("data", onData);
      const parsed = Number(received.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
      if (!parsed) reject(new Error(`Unexpected WebSocket handshake: ${received}`));
      else resolve(parsed);
    };
    socket.on("data", onData);
    socket.once("connect", () => socket.write(headers.join("\r\n")));
  });
  return { status, socket };
}

test(
  "container gateway isolates two tenants, native endpoints, workspace, Skill and MCP",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-enterprise-e2e-"));
    await writeFile(join(root, "index.html"), "enterprise");
    const store = await EnterpriseStore.open(join(root, "enterprise.sqlite"), join(root, "cases"));
    const password = "e2e-test-password";
    const hash = await EnterpriseAuth.hashPassword(password);
    const a = store.bootstrapAdmin("Tenant A", "a@example.test", hash);
    const b = store.bootstrapAdmin("Tenant B", "b@example.test", hash);
    store.provisionUser(a.user.id, a.tenant.id, {
      email: "a-member@example.test",
      passwordHash: hash,
      role: "member",
    });
    const caseA = await store.createCustomer(a.user.id, a.tenant.id, {
      name: "A customer",
      type: "account",
    });
    const caseA2 = await store.createCustomer(a.user.id, a.tenant.id, {
      name: "A second customer",
      type: "account",
    });
    const caseB = await store.createCustomer(b.user.id, b.tenant.id, {
      name: "B customer",
      type: "account",
    });
    // The native session RPC requires a selectable model. This local test provider
    // never receives a request because the smoke test only creates and resumes a session.
    const providerConfigDir = join(root, "runtime-data", caseB.id, ".zcode", "v2");
    await mkdir(providerConfigDir, { recursive: true });
    await writeFile(
      join(providerConfigDir, "config.json"),
      JSON.stringify({
        provider: {
          "enterprise-e2e-local": {
            name: "Enterprise E2E local",
            kind: "openai-compatible",
            options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "test-only-key" },
            models: { "e2e-no-inference": { limit: { context: 8192, output: 1024 } } },
          },
        },
      }),
    );
    await store.createCustomerSkill(a.user.id, caseA.id, {
      name: "Private A",
      content: "---\nname: private-a\ndescription: Tenant A only\n---\n# Private A\n",
    });
    const secret = randomBytes(24).toString("hex");
    const secretRef = `ZCODE_ENTERPRISE_MCP_SECRET_${a.tenant.id.replaceAll("-", "").toUpperCase()}_E2E_A`;
    const previousAllowlist = process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
    process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = JSON.stringify({
      [a.tenant.id]: ["https://knowledge-a.example.test"],
    });
    process.env[secretRef] = secret;
    await store.createCustomerMcpBinding(a.user.id, caseA.id, {
      name: "knowledge-a",
      endpoint: "https://knowledge-a.example.test/mcp",
      secretRef,
    });

    const runtimes = new RuntimeManager(
      new ContainerRuntimeAdapter({
        image: process.env.ZCODE_ENTERPRISE_RUNTIME_IMAGE ?? "zcode-enterprise-runtime:local",
        dataRoot: join(root, "runtime-data"),
      }),
    );
    const gatewayPort = await availablePort();
    const gateway = createEnterpriseGateway({
      store,
      auth: new EnterpriseAuth(store),
      runtimes,
      staticRoot: root,
      host: "0.0.0.0",
      port: gatewayPort,
      relayOrigin: `http://host.docker.internal:${gatewayPort}`,
    });
    await gateway.listen();
    const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
    const port = (gateway.server.address() as AddressInfo).port;

    async function login(email: string): Promise<{ cookie: string; csrf: string }> {
      const response = await fetch(`${base}/api/enterprise/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      const bootstrap = await fetch(`${base}/api/enterprise/bootstrap`, { headers: { cookie } });
      assert.equal(bootstrap.status, 200);
      const body = (await bootstrap.json()) as { csrfToken: string };
      return { cookie, csrf: body.csrfToken };
    }

    async function activate(
      id: string,
      session: { cookie: string; csrf: string },
    ): Promise<Response> {
      return fetch(`${base}/api/enterprise/customers/${id}/activate`, {
        method: "POST",
        headers: { cookie: session.cookie, origin: base, "x-csrf-token": session.csrf },
      });
    }

    try {
      const sessionA = await login("a@example.test");
      const memberA = await login("a-member@example.test");
      const sessionB = await login("b@example.test");
      const deniedSocket = await webSocketHandshake(port, base);
      assert.equal(deniedSocket.status, 401);
      deniedSocket.socket.destroy();
      assert.equal((await activate(caseA.id, memberA)).status, 200);
      assert.equal((await activate(caseA.id, sessionA)).status, 200);
      assert.equal((await activate(caseB.id, sessionB)).status, 200);
      assert.equal((await activate(caseB.id, sessionA)).status, 404);
      assert.equal(
        (
          await fetch(`${base}/api/enterprise/customers?tenantId=${b.tenant.id}`, {
            headers: { cookie: sessionA.cookie },
          })
        ).status,
        404,
      );

      const infoA = await fetch(`${base}/api/server-info`, {
        headers: { cookie: sessionA.cookie },
      });
      const infoB = await fetch(`${base}/api/server-info`, {
        headers: { cookie: sessionB.cookie },
      });
      assert.equal(infoA.status, 200);
      assert.equal(infoB.status, 200);
      assert.match(JSON.stringify(await infoA.json()), new RegExp(caseA.id));
      assert.match(JSON.stringify(await infoB.json()), new RegExp(caseB.id));
      const nativeSessionId = await smokeNativeSession(base, sessionB.cookie, caseB.workspacePath);
      assert.ok(nativeSessionId);
      const restoredCase = await fetch(`${base}/api/enterprise/bootstrap`, {
        headers: { cookie: sessionB.cookie },
      });
      const restoredBootstrap = (await restoredCase.json()) as {
        activeCustomer: { id: string } | null;
      };
      assert.equal(restoredBootstrap.activeCustomer?.id, caseB.id);

      const bindingB = runtimes.getBinding(caseB);
      assert.ok(bindingB);
      assert.equal(
        (await fetch(`${bindingB.url}/api/server-info`, { headers: { cookie: sessionA.cookie } }))
          .status,
        401,
      );
      const { stdout } = await execFile("docker", [
        "inspect",
        "--format",
        "{{json .Mounts}}",
        `zcode-enterprise-${caseB.id}`,
      ]);
      assert.ok(stdout.includes(caseB.workspacePath));
      assert.ok(!stdout.includes(caseA.workspacePath));
      await assert.rejects(
        execFile("docker", [
          "exec",
          `zcode-enterprise-${caseB.id}`,
          "test",
          "-e",
          caseA.workspacePath,
        ]),
      );

      const configB = await readFile(join(caseB.workspacePath, ".zcode", "config.json"), "utf8");
      assert.ok(!configB.includes("knowledge-a.example.test"));
      assert.ok(!configB.includes(secret));
      const configA = await readFile(join(caseA.workspacePath, ".zcode", "config.json"), "utf8");
      assert.ok(configA.includes("enterprise-knowledge-a"));
      assert.ok(!configA.includes(secret));
      const relayConfig = (
        JSON.parse(configA) as { mcp: { servers: Record<string, { url: string }> } }
      ).mcp.servers["enterprise-knowledge-a"];
      assert.ok(relayConfig);
      assert.match(relayConfig.url, /^http:\/\/host\.docker\.internal:/);
      const containerProbe = await execFile("docker", [
        "exec",
        `zcode-enterprise-${caseA.id}`,
        "node",
        "-e",
        "fetch(process.argv[1]).then(r => console.log(r.status)).catch(e => { console.error(e); process.exitCode = 1 })",
        relayConfig.url,
      ]);
      assert.equal(containerProbe.stdout.trim(), "401");
      const managedManifestPath = join(
        dirname(caseA.workspacePath),
        ".enterprise-managed",
        `${basename(caseA.workspacePath)}.json`,
      );
      assert.ok((await readFile(managedManifestPath, "utf8")).includes("skills"));
      await assert.rejects(
        execFile("docker", [
          "exec",
          `zcode-enterprise-${caseA.id}`,
          "test",
          "-e",
          managedManifestPath,
        ]),
      );
      assert.match(
        await readFile(
          join(
            caseA.workspacePath,
            ".zcode",
            "skills",
            `enterprise-${store.listSkillsForCustomer(a.user.id, caseA.id)[0]!.id}`,
            "SKILL.md",
          ),
          "utf8",
        ),
        /Private A/,
      );

      // A terminated native server is replaced without changing its Case workspace.
      const firstBinding = runtimes.getBinding(caseA);
      assert.ok(firstBinding);
      await execFile("docker", ["rm", "-f", `zcode-enterprise-${caseA.id}`]);
      const recovered = await fetch(`${base}/api/server-info`, {
        headers: { cookie: sessionA.cookie },
      });
      assert.equal(recovered.status, 200);
      assert.notEqual(runtimes.getBinding(caseA)?.token, firstBinding.token);

      // A second workspace replaces the active route for this browser session.
      const activeSocket = await webSocketHandshake(port, base, sessionA.cookie);
      assert.equal(activeSocket.status, 101);
      const oldSocketClosed = once(activeSocket.socket, "close");
      assert.equal((await activate(caseA2.id, sessionA)).status, 200);
      await Promise.race([
        oldSocketClosed,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Old Case socket remained open")), 5000);
          timer.unref();
        }),
      ]);
      const switched = await fetch(`${base}/api/server-info`, {
        headers: { cookie: sessionA.cookie },
      });
      assert.equal(switched.status, 200);
      assert.match(JSON.stringify(await switched.json()), new RegExp(caseA2.id));
      assert.equal((await activate(caseA.id, sessionA)).status, 200);

      assert.equal((await activate(caseA.id, sessionA)).status, 200);

      store.removeMembership(
        a.user.id,
        a.tenant.id,
        store.findCredential("a-member@example.test")!.user.id,
      );
      assert.equal(
        (await fetch(`${base}/api/server-info`, { headers: { cookie: memberA.cookie } })).status,
        401,
      );
    } finally {
      await gateway.close();
      store.close();
      delete process.env[secretRef];
      if (previousAllowlist === undefined) delete process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
      else process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = previousAllowlist;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "container gateway shares one Customer runtime across native sessions",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-enterprise-customer-e2e-"));
    const workspaceRoot = join(root, "workspaces");
    const dbPath = join(root, "enterprise.sqlite");
    const password = "e2e-customer-password";
    const hash = await EnterpriseAuth.hashPassword(password);

    const store = await EnterpriseStore.open(dbPath, workspaceRoot);
    const initial = store.bootstrapAdmin("Customer Tenant", "customer@example.test", hash);
    const customerA = await store.createCustomer(initial.user.id, initial.tenant.id, {
      name: "First customer",
      type: "account",
    });
    const customerB = await store.createCustomer(initial.user.id, initial.tenant.id, {
      name: "Second customer",
      type: "account",
    });

    const runtimeDataRoot = join(root, "runtime-data");
    async function seedNativeModelConfig(runtimeId: string): Promise<void> {
      // ContainerRuntimeAdapter mounts runtimeDataRoot/<runtimeId> as HOME;
      // native provider configuration therefore belongs in that data mount.
      const configDir = join(runtimeDataRoot, runtimeId, ".zcode", "v2");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.json"),
        JSON.stringify({
          provider: {
            "enterprise-e2e-local": {
              name: "Enterprise E2E local",
              kind: "openai-compatible",
              options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "test-only-key" },
              models: { "e2e-no-inference": { limit: { context: 8192, output: 1024 } } },
            },
          },
        }),
      );
    }

    await seedNativeModelConfig(customerA.id);
    await seedNativeModelConfig(customerB.id);

    const runtimes = new RuntimeManager(
      new ContainerRuntimeAdapter({
        image: process.env.ZCODE_ENTERPRISE_RUNTIME_IMAGE ?? "zcode-enterprise-runtime:local",
        dataRoot: runtimeDataRoot,
      }),
    );
    const gatewayPort = await availablePort();
    const gateway = createEnterpriseGateway({
      store,
      auth: new EnterpriseAuth(store),
      runtimes,
      staticRoot: root,
      host: "0.0.0.0",
      port: gatewayPort,
      relayOrigin: `http://host.docker.internal:${gatewayPort}`,
    });
    await gateway.listen();
    const port = (gateway.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    async function login(): Promise<{ cookie: string; csrf: string }> {
      const response = await fetch(`${base}/api/enterprise/login`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ email: "customer@example.test", password }),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      const bootstrap = await fetch(`${base}/api/enterprise/bootstrap`, { headers: { cookie } });
      assert.equal(bootstrap.status, 200);
      const body = (await bootstrap.json()) as { csrfToken: string };
      return { cookie, csrf: body.csrfToken };
    }

    async function activateCustomer(
      customerId: string,
      session: { cookie: string; csrf: string },
    ): Promise<Response> {
      return fetch(`${base}/api/enterprise/customers/${customerId}/activate`, {
        method: "POST",
        headers: { cookie: session.cookie, origin: base, "x-csrf-token": session.csrf },
      });
    }

    async function inspectRuntimeMount(runtimeId: string): Promise<string> {
      const { stdout } = await execFile("docker", [
        "inspect",
        "--format",
        "{{json .Mounts}}",
        `zcode-enterprise-${runtimeId}`,
      ]);
      return stdout;
    }

    try {
      const session = await login();
      assert.equal((await activateCustomer(customerA.id, session)).status, 200);
      const firstSessionId = await smokeNativeSession(
        base,
        session.cookie,
        customerA.workspacePath,
      );
      const customerTargetA = store.getCustomerRuntimeTarget(initial.user.id, customerA.id);
      const firstBinding = runtimes.getBinding(customerTargetA);
      assert.ok(firstBinding);
      assert.equal(firstBinding.runtimeId, customerA.id);
      assert.equal(firstBinding.workspacePath, customerA.workspacePath);

      const secondSessionId = await smokeNativeSession(
        base,
        session.cookie,
        customerA.workspacePath,
      );
      assert.notEqual(secondSessionId, firstSessionId);
      const secondBinding = runtimes.getBinding(customerTargetA);
      assert.ok(secondBinding);
      assert.equal(secondBinding.runtimeId, firstBinding.runtimeId);
      assert.equal(secondBinding.url, firstBinding.url);
      assert.equal(secondBinding.token, firstBinding.token);

      const customerAInfo = await fetch(`${base}/api/server-info`, {
        headers: { cookie: session.cookie },
      });
      assert.equal(customerAInfo.status, 200);
      const customerAInfoBody = await customerAInfo.text();
      assert.ok(customerAInfoBody.includes(customerA.workspacePath));
      assert.ok(!customerAInfoBody.includes(customerB.workspacePath));

      assert.equal((await activateCustomer(customerB.id, session)).status, 200);
      const customerBSessionId = await smokeNativeSession(
        base,
        session.cookie,
        customerB.workspacePath,
      );
      assert.notEqual(customerBSessionId, firstSessionId);
      const customerTargetB = store.getCustomerRuntimeTarget(initial.user.id, customerB.id);
      const customerBBinding = runtimes.getBinding(customerTargetB);
      assert.ok(customerBBinding);
      assert.equal(customerBBinding.runtimeId, customerB.id);
      assert.notEqual(customerBBinding.runtimeId, firstBinding.runtimeId);
      assert.notEqual(customerBBinding.workspacePath, firstBinding.workspacePath);
      assert.notEqual(customerBBinding.token, firstBinding.token);

      const customerBInfo = await fetch(`${base}/api/server-info`, {
        headers: { cookie: session.cookie },
      });
      assert.equal(customerBInfo.status, 200);
      const customerBInfoBody = await customerBInfo.text();
      assert.ok(customerBInfoBody.includes(customerB.workspacePath));
      assert.ok(!customerBInfoBody.includes(customerA.workspacePath));
      const customerAMounts = await inspectRuntimeMount(customerA.id);
      const customerBMounts = await inspectRuntimeMount(customerB.id);
      assert.ok(customerAMounts.includes(customerA.workspacePath));
      assert.ok(!customerAMounts.includes(customerB.workspacePath));
      assert.ok(customerBMounts.includes(customerB.workspacePath));
      assert.ok(!customerBMounts.includes(customerA.workspacePath));
      await assert.rejects(
        execFile("docker", [
          "exec",
          `zcode-enterprise-${customerB.id}`,
          "test",
          "-e",
          customerA.workspacePath,
        ]),
      );

    } finally {
      await gateway.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
