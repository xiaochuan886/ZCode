import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  "container gateway runs one expert runtime per user with all tenant customer workspaces mounted",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-enterprise-expert-e2e-"));
    await writeFile(join(root, "index.html"), "enterprise");
    const store = await EnterpriseStore.open(join(root, "enterprise.sqlite"), join(root, "cases"));
    const password = "e2e-expert-password";
    const hash = await EnterpriseAuth.hashPassword(password);
    const a = store.bootstrapAdmin("Tenant A", "a@example.test", hash);
    store.provisionUser(a.user.id, a.tenant.id, {
      email: "a-expert@example.test",
      passwordHash: hash,
      role: "member",
    });
    const b = store.bootstrapAdmin("Tenant B", "b@example.test", hash);
    const customerA1 = await store.createCustomer(a.user.id, a.tenant.id, {
      name: "East customer",
      type: "account",
    });
    const customerA2 = await store.createCustomer(a.user.id, a.tenant.id, {
      name: "West customer",
      type: "account",
    });
    const customerB = await store.createCustomer(b.user.id, b.tenant.id, {
      name: "Foreign customer",
      type: "account",
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
      modelRuntimeDataRoot: join(root, "runtime-data"),
    });
    await gateway.listen();
    const port = (gateway.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

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
      customerId: string,
      session: { cookie: string; csrf: string },
    ): Promise<Response> {
      return fetch(`${base}/api/enterprise/customers/${customerId}/activate`, {
        method: "POST",
        headers: { cookie: session.cookie, origin: base, "x-csrf-token": session.csrf },
      });
    }

    async function containerMounts(runtimeId: string): Promise<string> {
      const { stdout } = await execFile("docker", [
        "inspect",
        "--format",
        "{{json .Mounts}}",
        `zcode-enterprise-${runtimeId}`,
      ]);
      return stdout;
    }

    try {
      const adminA = await login("a@example.test");
      const expertA = await login("a-expert@example.test");
      const adminB = await login("b@example.test");

      // 未登录与无活跃客户的握手被拒。
      const deniedSocket = await webSocketHandshake(port, base);
      assert.equal(deniedSocket.status, 401);
      deniedSocket.socket.destroy();

      assert.equal((await activate(customerA1.id, adminA)).status, 200);
      await smokeNativeSession(base, adminA.cookie, customerA1.workspacePath);

      const adminTarget = store.getCustomerRuntimeTarget(a.user.id, customerA1.id);
      const adminBinding = runtimes.getBinding(adminTarget);
      assert.ok(adminBinding);

      // 同一专家切到另一个客户:同一个 runtime,只是另一个工作区,不再重建容器。
      assert.equal((await activate(customerA2.id, adminA)).status, 200);
      await smokeNativeSession(base, adminA.cookie, customerA2.workspacePath);
      const adminTarget2 = store.getCustomerRuntimeTarget(a.user.id, customerA2.id);
      const adminBinding2 = runtimes.getBinding(adminTarget2);
      assert.ok(adminBinding2);
      assert.equal(adminBinding2.runtimeId, adminBinding.runtimeId);
      assert.equal(runtimes.getBinding(adminTarget)?.url, adminBinding2.url);

      // 另一个专家 = 另一个 runtime;同样挂载租户内全部客户工作区,不含外租户。
      assert.equal((await activate(customerA1.id, expertA)).status, 200);
      await smokeNativeSession(base, expertA.cookie, customerA1.workspacePath);
      const expertUser = store.findCredential("a-expert@example.test")!.user;
      const expertTarget = store.getCustomerRuntimeTarget(expertUser.id, customerA1.id);
      const expertBinding = runtimes.getBinding(expertTarget);
      assert.ok(expertBinding);
      assert.notEqual(expertBinding.runtimeId, adminBinding.runtimeId);

      const expertMounts = await containerMounts(expertBinding.runtimeId!);
      assert.ok(expertMounts.includes(customerA1.workspacePath));
      assert.ok(expertMounts.includes(customerA2.workspacePath));
      assert.ok(!expertMounts.includes(customerB.workspacePath));

      // 外租户 runtime 只挂自己的客户。
      assert.equal((await activate(customerB.id, adminB)).status, 200);
      await smokeNativeSession(base, adminB.cookie, customerB.workspacePath);
      const foreignTarget = store.getCustomerRuntimeTarget(b.user.id, customerB.id);
      const foreignBinding = runtimes.getBinding(foreignTarget);
      assert.ok(foreignBinding);
      const foreignMounts = await containerMounts(foreignBinding.runtimeId!);
      assert.ok(foreignMounts.includes(customerB.workspacePath));
      assert.ok(!foreignMounts.includes(customerA1.workspacePath));

      // 跨租户 API 仍然拒绝。
      assert.equal(
        (
          await fetch(`${base}/api/enterprise/customers/${customerA1.id}/activate`, {
            method: "POST",
            headers: { cookie: adminB.cookie, origin: base, "x-csrf-token": adminB.csrf },
          })
        ).status,
        404,
      );

      // 客户 CRUD 是管理员专属;成员创建被拒。
      assert.equal(
        (
          await fetch(`${base}/api/enterprise/customers`, {
            method: "POST",
            headers: {
              cookie: expertA.cookie,
              origin: base,
              "x-csrf-token": expertA.csrf,
              "content-type": "application/json",
            },
            body: JSON.stringify({ tenantId: a.tenant.id, name: "Member customer" }),
          })
        ).status,
        403,
      );

      // 撤销成员资格立即关闭 socket 并停止其专家 runtime。
      const expertSocket = await webSocketHandshake(port, base, expertA.cookie);
      assert.equal(expertSocket.status, 101);
      const expertClosed = once(expertSocket.socket, "close");
      store.removeMembership(a.user.id, a.tenant.id, expertUser.id);
      await Promise.race([
        expertClosed,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Expert socket stayed open")), 5000);
          timer.unref();
        }),
      ]);
    } finally {
      await gateway.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
