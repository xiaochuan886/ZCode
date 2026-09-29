import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { EnterpriseAuth } from "../../src/auth.js";
import { createEnterpriseGateway } from "../../src/gateway.js";
import { ContainerRuntimeAdapter, RuntimeManager } from "../../src/runtime.js";
import { EnterpriseStore } from "../../src/store.js";

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
    const spaceA = store.createServiceSpace(a.user.id, a.tenant.id, { name: "A space" });
    const spaceA2 = store.createServiceSpace(a.user.id, a.tenant.id, { name: "A second space" });
    const spaceB = store.createServiceSpace(b.user.id, b.tenant.id, { name: "B space" });
    store.provisionUser(a.user.id, a.tenant.id, {
      email: "a-member@example.test",
      passwordHash: hash,
      role: "member",
    });
    const objectA = store.createServiceObject(a.user.id, spaceA.id, {
      name: "Object A",
      type: "application",
    });
    const objectB = store.createServiceObject(b.user.id, spaceB.id, {
      name: "Object B",
      type: "application",
    });
    const caseA = store.createCase(a.user.id, objectA.id, { title: "A case", category: "support" });
    const objectA2 = store.createServiceObject(a.user.id, spaceA2.id, {
      name: "Object A2",
      type: "application",
    });
    const caseA2 = store.createCase(a.user.id, objectA2.id, {
      title: "A second case",
      category: "support",
    });
    const caseB = store.createCase(b.user.id, objectB.id, { title: "B case", category: "support" });
    store.createSkill(a.user.id, caseA.id, {
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
    store.createMcpBinding(a.user.id, a.tenant.id, {
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
      return fetch(`${base}/api/enterprise/cases/${id}/activate`, {
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
          await fetch(`${base}/api/enterprise/cases?serviceSpaceId=${spaceB.id}`, {
            headers: { cookie: sessionA.cookie },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/enterprise/objects?serviceSpaceId=${spaceB.id}`, {
            headers: { cookie: sessionA.cookie },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/api/enterprise/spaces?tenantId=${b.tenant.id}`, {
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

      assert.match(
        await readFile(join(caseA.workspacePath, "CASE_CONTEXT.md"), "utf8"),
        /Object A/,
      );
      assert.doesNotMatch(
        await readFile(join(caseB.workspacePath, "CASE_CONTEXT.md"), "utf8"),
        /Object A/,
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
      assert.match(
        await readFile(
          join(
            caseA.workspacePath,
            ".zcode",
            "skills",
            `enterprise-${store.listSkillsForCase(a.user.id, caseA.id)[0]!.id}`,
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

      const status = async (next: string) =>
        fetch(`${base}/api/enterprise/cases/${caseA.id}/status`, {
          method: "PATCH",
          headers: {
            cookie: sessionA.cookie,
            origin: base,
            "x-csrf-token": sessionA.csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify({ status: next }),
        });
      for (const next of ["in_progress", "resolved", "closed"]) {
        assert.equal((await status(next)).status, 200);
      }
      assert.equal(runtimes.getBinding(caseA), null);
      assert.equal((await activate(caseA.id, sessionA)).status, 400);
      assert.equal((await status("in_progress")).status, 200);
      assert.equal((await activate(caseA.id, sessionA)).status, 200);
      assert.match(
        await readFile(join(caseA.workspacePath, "CASE_CONTEXT.md"), "utf8"),
        /Object A/,
      );

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
