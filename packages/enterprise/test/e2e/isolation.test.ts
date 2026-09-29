import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const spaceB = store.createServiceSpace(b.user.id, b.tenant.id, { name: "B space" });
    const objectA = store.createServiceObject(a.user.id, spaceA.id, {
      name: "Object A",
      type: "application",
    });
    const objectB = store.createServiceObject(b.user.id, spaceB.id, {
      name: "Object B",
      type: "application",
    });
    const caseA = store.createCase(a.user.id, objectA.id, { title: "A case", category: "support" });
    const caseB = store.createCase(b.user.id, objectB.id, { title: "B case", category: "support" });
    store.createSkill(a.user.id, caseA.id, {
      name: "Private A",
      content: "---\nname: private-a\ndescription: Tenant A only\n---\n# Private A\n",
    });
    const secret = randomBytes(24).toString("hex");
    process.env.ENTERPRISE_E2E_TOKEN_A = secret;
    store.createMcpBinding(a.user.id, a.tenant.id, {
      name: "knowledge-a",
      endpoint: "https://knowledge-a.example.test/mcp",
      secretRef: "ENTERPRISE_E2E_TOKEN_A",
    });

    const runtimes = new RuntimeManager(
      new ContainerRuntimeAdapter({
        image: process.env.ZCODE_ENTERPRISE_RUNTIME_IMAGE ?? "zcode-enterprise-runtime:local",
        dataRoot: join(root, "runtime-data"),
      }),
    );
    const gateway = createEnterpriseGateway({
      store,
      auth: new EnterpriseAuth(store),
      runtimes,
      staticRoot: root,
      port: 0,
    });
    await gateway.listen();
    const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;

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
      const sessionB = await login("b@example.test");
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
    } finally {
      await gateway.close();
      store.close();
      delete process.env.ENTERPRISE_E2E_TOKEN_A;
      await rm(root, { recursive: true, force: true });
    }
  },
);
