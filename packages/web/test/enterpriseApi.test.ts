import assert from "node:assert/strict";
import test from "node:test";
import { createEnterpriseClient, isCompleteCustomerDraft } from "../src/enterprise/api.ts";

test("customer creation requires a tenant and customer name", () => {
  assert.equal(isCompleteCustomerDraft({ tenantId: "tenant-1", name: "" }), false);
  assert.equal(isCompleteCustomerDraft({ tenantId: "", name: "客户 A" }), false);
  assert.equal(isCompleteCustomerDraft({ tenantId: "tenant-1", name: "客户 A" }), true);
});

test("customer list uses the selected tenant and accepts array or items responses", async () => {
  const calls: string[] = [];
  const client = createEnterpriseClient(async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ items: [{ id: "customer-1", tenantId: "tenant-1", name: "客户 A" }] }),
      {
        status: 200,
      },
    );
  });
  assert.deepEqual(await client.customers("tenant-1"), [
    { id: "customer-1", tenantId: "tenant-1", name: "客户 A" },
  ]);
  assert.equal(calls[0], "/api/enterprise/customers?tenantId=tenant-1");
});

test("customer mutations carry CSRF and cookies", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createEnterpriseClient(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "customer-1" }), { status: 200 });
  });
  await client.activateCustomer("customer-1", "csrf-1");
  assert.equal(calls[0]?.url, "/api/enterprise/customers/customer-1/activate");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(new Headers(calls[0]?.init?.headers).get("X-CSRF-Token"), "csrf-1");
});

test("customer creation sends the tenant scoped payload", async () => {
  let sent: { url: string; body: unknown; csrf: string | null } | undefined;
  const client = createEnterpriseClient(async (url, init) => {
    sent = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    };
    return new Response(JSON.stringify({ id: "customer-1" }), { status: 200 });
  });
  await client.createCustomer({ tenantId: "tenant-1", name: "客户 A" }, "csrf-1");
  assert.deepEqual(sent, {
    url: "/api/enterprise/customers",
    body: { tenantId: "tenant-1", name: "客户 A", metadata: {} },
    csrf: "csrf-1",
  });
});

test("bootstrap exposes the active customer", async () => {
  const client = createEnterpriseClient(
    async () =>
      new Response(
        JSON.stringify({
          enabled: true,
          user: null,
          tenants: [],
          activeCustomer: {
            id: "customer-1",
            name: "客户 A",
            workspacePath: "/customers/customer-1",
          },
          csrfToken: "csrf-1",
        }),
        { status: 200 },
      ),
  );
  assert.deepEqual(await client.bootstrap(), {
    enabled: true,
    user: null,
    tenants: [],
    activeCustomer: { id: "customer-1", name: "客户 A", workspacePath: "/customers/customer-1" },
    csrfToken: "csrf-1",
  });
});

test("model provider creation sends the tenant scoped catalog payload", async () => {
  let sent: { url: string; body: unknown; csrf: string | null } | undefined;
  const client = createEnterpriseClient(async (url, init) => {
    sent = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    };
    return new Response("{}", { status: 201 });
  });
  await client.createModelProvider(
    "tenant-1",
    {
      providerKey: "openai",
      displayName: "OpenAI",
      apiType: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key-1",
      models: ["gpt-4o", "gpt-4o-mini"],
      defaultModel: "gpt-4o",
      isDefault: true,
    },
    "csrf-1",
  );
  assert.deepEqual(sent, {
    url: "/api/enterprise/tenants/tenant-1/model-providers",
    body: {
      providerKey: "openai",
      displayName: "OpenAI",
      apiType: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key-1",
      models: ["gpt-4o", "gpt-4o-mini"],
      defaultModel: "gpt-4o",
      isDefault: true,
    },
    csrf: "csrf-1",
  });
});

test("model provider mutations use the id scoped routes", async () => {
  const calls: { url: string; method: string | undefined; body: unknown; csrf: string | null }[] =
    [];
  const client = createEnterpriseClient(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init?.body)) : null,
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    });
    return new Response("{}", { status: 200 });
  });
  await client.updateModelProvider("provider-1", { isDefault: true }, "csrf-1");
  await client.testModelProvider("provider-1", "csrf-1");
  await client.deleteModelProvider("provider-1", "csrf-1");
  assert.deepEqual(calls, [
    {
      url: "/api/enterprise/model-providers/provider-1",
      method: "PATCH",
      body: { isDefault: true },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/model-providers/provider-1/test",
      method: "POST",
      body: {},
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/model-providers/provider-1",
      method: "DELETE",
      body: null,
      csrf: "csrf-1",
    },
  ]);
});

test("connector and skill import mutations hit their tenant and id routes", async () => {
  const calls: { url: string; method: string | undefined; body: unknown; csrf: string | null }[] =
    [];
  const client = createEnterpriseClient(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init?.body)) : null,
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await client.createMcpConnector(
    "tenant-1",
    {
      connectorKey: "docs",
      displayName: "Docs",
      url: "https://mcp.example.com",
      secretEnv: "ZCODE_ENTERPRISE_MCP_SECRET_TENANT1_DOCS",
    },
    "csrf-1",
  );
  await client.updateMcpConnector("connector-1", { enabled: false }, "csrf-1");
  await client.deleteMcpConnector("connector-1", "csrf-1");
  await client.importableSkills("tenant-1");
  await client.importTenantSkill(
    "tenant-1",
    { name: "my-skill", origin: "workspace", workspaceId: "customer-1" },
    "csrf-1",
  );
  assert.deepEqual(calls, [
    {
      url: "/api/enterprise/tenants/tenant-1/mcp-connectors",
      method: "POST",
      body: {
        connectorKey: "docs",
        displayName: "Docs",
        url: "https://mcp.example.com",
        secretEnv: "ZCODE_ENTERPRISE_MCP_SECRET_TENANT1_DOCS",
      },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/mcp-connectors/connector-1",
      method: "PATCH",
      body: { enabled: false },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/mcp-connectors/connector-1",
      method: "DELETE",
      body: null,
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/tenants/tenant-1/importable-skills",
      method: undefined,
      body: null,
      csrf: null,
    },
    {
      url: "/api/enterprise/tenants/tenant-1/skills/import",
      method: "POST",
      body: { name: "my-skill", origin: "workspace", workspaceId: "customer-1" },
      csrf: "csrf-1",
    },
  ]);
});

test("user-oauth connector payloads carry the oauth client fields and the authorization routes are scoped", async () => {
  const calls: { url: string; method: string | undefined; body: unknown; csrf: string | null }[] =
    [];
  const client = createEnterpriseClient(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init?.body)) : null,
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    });
    return new Response(JSON.stringify({ ok: true, authorizeUrl: "https://oauth.example.test" }), {
      status: 200,
    });
  });
  await client.createMcpConnector(
    "tenant-1",
    {
      connectorKey: "drive",
      displayName: "Drive",
      url: "https://mcp.example.com",
      authMode: "user-oauth",
      authorizeUrl: "https://oauth.example.test/authorize",
      tokenUrl: "https://oauth.example.test/token",
      clientId: "client-1",
      clientSecret: "secret-1",
      scopes: "mcp.read",
    },
    "csrf-1",
  );
  await client.updateMcpConnector(
    "connector-1",
    { authMode: "user-oauth", clientId: "client-2" },
    "csrf-1",
  );
  const authorize = await client.connectorAuthorizeUrl("tenant-1", "connector-1");
  assert.equal(authorize.authorizeUrl, "https://oauth.example.test");
  await client.revokeConnectorAuthorization("tenant-1", "connector-1", "csrf-1");
  assert.deepEqual(calls, [
    {
      url: "/api/enterprise/tenants/tenant-1/mcp-connectors",
      method: "POST",
      body: {
        connectorKey: "drive",
        displayName: "Drive",
        url: "https://mcp.example.com",
        authMode: "user-oauth",
        authorizeUrl: "https://oauth.example.test/authorize",
        tokenUrl: "https://oauth.example.test/token",
        clientId: "client-1",
        clientSecret: "secret-1",
        scopes: "mcp.read",
      },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/mcp-connectors/connector-1",
      method: "PATCH",
      body: { authMode: "user-oauth", clientId: "client-2" },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/tenants/tenant-1/mcp-connectors/connector-1/authorize",
      method: undefined,
      body: null,
      csrf: null,
    },
    {
      url: "/api/enterprise/tenants/tenant-1/mcp-connectors/connector-1/authorization",
      method: "DELETE",
      body: null,
      csrf: "csrf-1",
    },
  ]);
});

test("tenant user routes are tenant and user scoped with CSRF on mutations", async () => {
  const calls: { url: string; method: string | undefined; body: unknown; csrf: string | null }[] =
    [];
  const client = createEnterpriseClient(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init?.body)) : null,
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    });
    return new Response(
      JSON.stringify({ ok: true, customerAccess: { mode: "all", customerIds: [] } }),
      {
        status: 200,
      },
    );
  });
  await client.tenantUsers("tenant-1");
  await client.createTenantUser(
    "tenant-1",
    { email: "new@example.com", displayName: "New", password: "initial-secret", role: "admin" },
    "csrf-1",
  );
  await client.updateTenantUser("tenant-1", "user-1", { status: "disabled" }, "csrf-1");
  await client.deleteTenantUser("tenant-1", "user-1", "csrf-1");
  await client.setTenantUserCustomerAccess(
    "tenant-1",
    "user-1",
    { mode: "selected", customerIds: ["customer-1", "customer-2"] },
    "csrf-1",
  );
  await client.setTenantUserCustomerAccess("tenant-1", "user-1", { mode: "all" }, "csrf-1");
  assert.deepEqual(calls, [
    {
      url: "/api/enterprise/tenants/tenant-1/users",
      method: undefined,
      body: null,
      csrf: null,
    },
    {
      url: "/api/enterprise/tenants/tenant-1/users",
      method: "POST",
      body: {
        email: "new@example.com",
        displayName: "New",
        password: "initial-secret",
        role: "admin",
      },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/tenants/tenant-1/users/user-1",
      method: "PATCH",
      body: { status: "disabled" },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/tenants/tenant-1/users/user-1",
      method: "DELETE",
      body: null,
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/tenants/tenant-1/users/user-1/customer-access",
      method: "PUT",
      body: { mode: "selected", customerIds: ["customer-1", "customer-2"] },
      csrf: "csrf-1",
    },
    {
      url: "/api/enterprise/tenants/tenant-1/users/user-1/customer-access",
      method: "PUT",
      body: { mode: "all" },
      csrf: "csrf-1",
    },
  ]);
});

test("tenant user payloads omit blank passwords and report join versus create", async () => {
  let sent: { url: string; body: unknown } | undefined;
  const client = createEnterpriseClient(async (url, init) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(
      JSON.stringify({
        id: "user-1",
        email: "expert@example.com",
        displayName: "Expert",
        role: "member",
        status: "active",
        createdAt: "2026-10-01T00:00:00.000Z",
        joined: true,
      }),
      { status: 201 },
    );
  });
  const created = await client.createTenantUser(
    "tenant-1",
    { email: "expert@example.com", displayName: "  Expert  ", password: "", role: "member" },
    "csrf-1",
  );
  assert.equal(created.joined, true);
  assert.equal(created.email, "expert@example.com");
  assert.equal(created.role, "member");
  assert.deepEqual(sent, {
    url: "/api/enterprise/tenants/tenant-1/users",
    body: { email: "expert@example.com", displayName: "Expert", role: "member" },
  });
  await client.updateTenantUser("tenant-1", "user-1", { password: "" }, "csrf-1");
  assert.deepEqual(sent, {
    url: "/api/enterprise/tenants/tenant-1/users/user-1",
    body: {},
  });
});

test("ordinary server is identified only by a missing enterprise route", async () => {
  const absent = createEnterpriseClient(async () => new Response(null, { status: 404 }));
  assert.equal(await absent.bootstrap(), null);
  const broken = createEnterpriseClient(async () => new Response(null, { status: 503 }));
  await assert.rejects(() => broken.bootstrap());
});
