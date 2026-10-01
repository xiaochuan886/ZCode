import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnterpriseClient,
  isCompleteCustomerDraft,
  isCompleteModelCredentialInput,
} from "../src/enterprise/api.ts";

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

test("custom provider credentials require all connection fields", () => {
  assert.equal(
    isCompleteModelCredentialInput({
      providerName: "OpenAI",
      apiType: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o",
      apiKey: "key-1",
    }),
    true,
  );
  assert.equal(
    isCompleteModelCredentialInput({
      providerName: "OpenAI",
      apiType: "openai-chat-completions",
      baseUrl: "",
      modelId: "gpt-4o",
      apiKey: "key-1",
    }),
    false,
  );
  assert.equal(
    isCompleteModelCredentialInput({
      apiType: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o",
      apiKey: "key-1",
    }),
    true,
  );
});

test("tenant model settings send the generic custom provider payload", async () => {
  let sent: { url: string; body: unknown; csrf: string | null } | undefined;
  const client = createEnterpriseClient(async (url, init) => {
    sent = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    };
    return new Response("{}", { status: 200 });
  });
  await client.saveModelCredential(
    "tenant-1",
    {
      providerName: "OpenAI",
      apiType: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o",
      apiKey: "key-1",
    },
    "csrf-1",
  );
  assert.deepEqual(sent, {
    url: "/api/enterprise/tenants/tenant-1/model-credentials/custom",
    body: {
      providerName: "OpenAI",
      apiType: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o",
      apiKey: "key-1",
    },
    csrf: "csrf-1",
  });
});

test("custom provider payload allows the server default provider name", async () => {
  let body: unknown;
  const client = createEnterpriseClient(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  });
  await client.saveModelCredential(
    "tenant-1",
    {
      apiType: "anthropic-messages",
      baseUrl: "https://api.example.com/v1",
      modelId: "claude-3-5-sonnet",
      apiKey: "key-1",
    },
    "csrf-1",
  );
  assert.deepEqual(body, {
    apiType: "anthropic-messages",
    baseUrl: "https://api.example.com/v1",
    modelId: "claude-3-5-sonnet",
    apiKey: "key-1",
  });
});

test("revoking the custom provider uses the tenant route and CSRF", async () => {
  let sent: { url: string; method: string | undefined; csrf: string | null } | undefined;
  const client = createEnterpriseClient(async (url, init) => {
    sent = {
      url: String(url),
      method: init?.method,
      csrf: new Headers(init?.headers).get("X-CSRF-Token"),
    };
    return new Response("{}", { status: 200 });
  });
  await client.revokeModelCredential("tenant-1", "csrf-1");
  assert.deepEqual(sent, {
    url: "/api/enterprise/tenants/tenant-1/model-credentials/custom",
    method: "DELETE",
    csrf: "csrf-1",
  });
});

test("ordinary server is identified only by a missing enterprise route", async () => {
  const absent = createEnterpriseClient(async () => new Response(null, { status: 404 }));
  assert.equal(await absent.bootstrap(), null);
  const broken = createEnterpriseClient(async () => new Response(null, { status: 503 }));
  await assert.rejects(() => broken.bootstrap());
});
