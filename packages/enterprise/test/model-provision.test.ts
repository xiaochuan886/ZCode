import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  provisionExpertModelProviders,
  type ExpertModelProviderSlot,
} from "../src/model-provision.js";
import { prepareExpertRuntime } from "../src/gateway-prepare.js";
import { EnterpriseStore } from "../src/store.js";

type ProviderConfigFile = {
  config: {
    defaultModelSelection?: { providerId: string; modelId: string };
    providerOrder: string[];
    providerConfigRules: {
      providerRules: Array<{
        providerId: string;
        providerName: string;
        config: {
          access: { type: string; apiKey: string };
          api: { type: string; baseUrl: string };
          personalModelIds: string[];
          modelOrder: string[];
        };
      }>;
    };
  };
};

function slot(
  overrides: Partial<ExpertModelProviderSlot> & { providerKey: string },
): ExpertModelProviderSlot {
  return {
    tenantId: "tenant-a",
    displayName: `Provider ${overrides.providerKey}`,
    apiType: "openai-chat-completions",
    baseUrl: `https://${overrides.providerKey}.example.com/v1`,
    apiKey: `key-${overrides.providerKey}`,
    models: [`${overrides.providerKey}-model-a`, `${overrides.providerKey}-model-b`],
    defaultModel: `${overrides.providerKey}-model-a`,
    isDefault: false,
    ...overrides,
  };
}

async function readConfig(
  runtimeDataRoot: string,
  owner = "e-user-1-tenant-a",
): Promise<ProviderConfigFile> {
  return JSON.parse(
    await readFile(join(runtimeDataRoot, owner, ".zcode", "v2", "provider_config.json"), "utf8"),
  ) as ProviderConfigFile;
}

test("provider catalog distributes one managed slot per provider with real keys and model lists", async () => {
  const runtimeDataRoot = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-provision-"));
  try {
    await provisionExpertModelProviders({
      runtimeOwner: "e-user-1-tenant-a",
      tenantId: "tenant-a",
      runtimeDataRoot,
      providers: [
        slot({ providerKey: "acme", isDefault: true, apiType: "anthropic-messages" }),
        slot({ providerKey: "beta", apiKey: "key-beta-live" }),
      ],
    });
    const config = await readConfig(runtimeDataRoot);
    const rules = config.config.providerConfigRules.providerRules;
    assert.deepEqual(
      rules.map((rule) => rule.providerId),
      ["enterprise-acme", "enterprise-beta"],
    );
    const acme = rules[0]!;
    assert.equal(acme.providerName, "Provider acme");
    // 服务端分发：真实 key 与真实上游地址直接写入，原生 runtime 直连供应商。
    assert.equal(acme.config.access.apiKey, "key-acme");
    assert.equal(acme.config.api.baseUrl, "https://acme.example.com/v1");
    assert.equal(acme.config.api.type, "anthropic-messages");
    assert.deepEqual(acme.config.personalModelIds, ["acme-model-a", "acme-model-b"]);
    assert.deepEqual(acme.config.modelOrder, ["acme-model-a", "acme-model-b"]);
    assert.equal(rules[1]!.config.access.apiKey, "key-beta-live");
    assert.deepEqual(config.config.providerOrder, ["enterprise-acme", "enterprise-beta"]);
    // 默认供应商固定默认模型选择。
    assert.deepEqual(config.config.defaultModelSelection, {
      providerId: "enterprise-acme",
      modelId: "acme-model-a",
    });
  } finally {
    await rm(runtimeDataRoot, { recursive: true, force: true });
  }
});

test("re-provisioning replaces the managed slot set and keeps unmanaged rules", async () => {
  const runtimeDataRoot = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-replace-"));
  try {
    const configDir = join(runtimeDataRoot, "e-user-1-tenant-a", ".zcode", "v2");
    const configPath = join(configDir, "provider_config.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: [
            "enterprise-acme",
            "enterprise-removed",
            "self-hosted",
            "enterprise-zai-api",
          ],
          providerConfigRules: {
            providerRules: [
              {
                providerId: "enterprise-acme",
                config: {
                  access: { type: "api-key", apiKey: "old-token" },
                  api: { type: "anthropic-messages", baseUrl: "https://old.example.com" },
                  personalModelIds: ["old-model"],
                  modelOrder: ["old-model"],
                },
              },
              {
                providerId: "enterprise-removed",
                config: {
                  access: { type: "api-key", apiKey: "removed-token" },
                  api: { type: "anthropic-messages", baseUrl: "https://removed.example.com" },
                  personalModelIds: ["removed-model"],
                  modelOrder: ["removed-model"],
                },
              },
              {
                providerId: "self-hosted",
                config: {
                  access: { type: "api-key", apiKey: "self-key" },
                  api: { type: "openai-chat-completions", baseUrl: "https://self.example.com" },
                  personalModelIds: ["self-model"],
                  modelOrder: ["self-model"],
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          defaultModelSelection: { providerId: "self-hosted", modelId: "self-model" },
        },
      })}\n`,
    );
    // 分发集合现在只剩 acme:被删除/停用供应商的托管槽位在下一次准备时消失。
    await provisionExpertModelProviders({
      runtimeOwner: "e-user-1-tenant-a",
      tenantId: "tenant-a",
      runtimeDataRoot,
      providers: [slot({ providerKey: "acme", isDefault: true, apiKey: "rotated-key" })],
    });
    const config = await readConfig(runtimeDataRoot);
    const rules = config.config.providerConfigRules.providerRules;
    assert.deepEqual(
      rules.map((rule) => rule.providerId),
      ["enterprise-acme", "self-hosted"],
    );
    assert.equal(rules[0]!.config.access.apiKey, "rotated-key");
    // 非托管条目与其默认模型选择保持原样。
    assert.deepEqual(config.config.providerOrder, ["enterprise-acme", "self-hosted"]);
    assert.deepEqual(config.config.defaultModelSelection, {
      providerId: "enterprise-acme",
      modelId: "acme-model-a",
    });

    // 没有任何供应商时托管槽位整体清空;上一轮托管默认随之消失。
    await provisionExpertModelProviders({
      runtimeOwner: "e-user-1-tenant-a",
      tenantId: "tenant-a",
      runtimeDataRoot,
      providers: [],
    });
    const emptied = await readConfig(runtimeDataRoot);
    assert.deepEqual(
      emptied.config.providerConfigRules.providerRules.map((rule) => rule.providerId),
      ["self-hosted"],
    );
    assert.deepEqual(emptied.config.providerOrder, ["self-hosted"]);
    assert.equal(emptied.config.defaultModelSelection, undefined);
  } finally {
    await rm(runtimeDataRoot, { recursive: true, force: true });
  }
});

test("provider provisioning refuses a provider from another tenant", async () => {
  const runtimeDataRoot = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-cross-tenant-"));
  try {
    await assert.rejects(
      provisionExpertModelProviders({
        runtimeOwner: "e-user-1-tenant-a",
        tenantId: "tenant-a",
        runtimeDataRoot,
        providers: [slot({ providerKey: "acme", tenantId: "tenant-b" })],
      }),
      /validation/,
    );
  } finally {
    await rm(runtimeDataRoot, { recursive: true, force: true });
  }
});

test("tenant connectors are distributed into the expert HOME config with the managed merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-connector-prepare-"));
  const runtimeDataRoot = join(dir, "runtimes");
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const admin = store.bootstrapAdmin("Connectors", "connector-admin@example.test", "hash");
    const tenantId = admin.tenant.id;
    const prefix = `ZCODE_ENTERPRISE_MCP_SECRET_${tenantId.replaceAll("-", "").toUpperCase()}_`;
    const secretRef = `${prefix}PREPARE_TEST`;
    const priorSecret = process.env[secretRef];
    const priorAllowlist = process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
    process.env[secretRef] = "connector-upstream-secret";
    process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = JSON.stringify({
      [tenantId]: ["https://relay-upstream.example.test"],
    });
    const live = store.createTenantMcpConnector(admin.user.id, tenantId, {
      connectorKey: "search",
      displayName: "Search connector",
      url: "https://relay-upstream.example.test/mcp",
      secretEnv: secretRef,
    });
    const disabled = store.createTenantMcpConnector(admin.user.id, tenantId, {
      connectorKey: "disabled-one",
      displayName: "Disabled",
      url: "https://relay-upstream.example.test/mcp",
      secretEnv: secretRef,
    });
    store.updateTenantMcpConnector(admin.user.id, disabled.id, { enabled: false });
    const target = {
      id: "e-user-1-tenant-a",
      tenantId,
      userId: admin.user.id,
      workspacePath: "",
      runtimeId: "e-user-1-tenant-a",
      kind: "expert" as const,
    };
    // 预置专家个人 MCP 条目:托管合并必须保留它。
    const homeConfig = join(runtimeDataRoot, target.runtimeId, ".zcode", "config.json");
    await mkdir(join(runtimeDataRoot, target.runtimeId, ".zcode"), { recursive: true });
    await writeFile(
      homeConfig,
      `${JSON.stringify({ mcp: { servers: { "my-personal": { type: "http", url: "https://personal.example.test" } } } })}\n`,
    );
    try {
      await prepareExpertRuntime({
        target,
        store,
        runtimeDataRoot,
        relayOrigin: "https://gateway.example.test",
      });
      const parsed = JSON.parse(await readFile(homeConfig, "utf8")) as {
        mcp: {
          servers: Record<string, { url: string; headers: { Authorization: string } }>;
        };
      };
      const managed = parsed.mcp.servers["enterprise-search"]!;
      assert.ok(managed, "enabled connector should be distributed");
      assert.equal(
        managed.url,
        `https://gateway.example.test/api/enterprise/mcp-relay/t/${live.id}`,
      );
      assert.ok(managed.headers.Authorization.startsWith("Bearer "));
      const token = managed.headers.Authorization.slice("Bearer ".length);
      assert.equal(token, store.ensureMcpConnectorToken(live.id));
      assert.equal(parsed.mcp.servers["enterprise-disabled-one"], undefined);
      assert.deepEqual(parsed.mcp.servers["my-personal"], {
        type: "http",
        url: "https://personal.example.test",
      });
      assert.equal(
        JSON.stringify(parsed).includes("connector-upstream-secret"),
        false,
        "upstream secret must never reach the expert HOME",
      );

      // 删除连接器后下一次准备移除其托管条目,个人条目仍在。
      store.deleteTenantMcpConnector(admin.user.id, live.id);
      await prepareExpertRuntime({
        target,
        store,
        runtimeDataRoot,
        relayOrigin: "https://gateway.example.test",
      });
      const afterDelete = JSON.parse(await readFile(homeConfig, "utf8")) as {
        mcp: { servers: Record<string, unknown> };
      };
      assert.equal(afterDelete.mcp.servers["enterprise-search"], undefined);
      assert.ok(afterDelete.mcp.servers["my-personal"]);
    } finally {
      if (priorSecret === undefined) delete process.env[secretRef];
      else process.env[secretRef] = priorSecret;
      if (priorAllowlist === undefined) delete process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
      else process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = priorAllowlist;
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime preparation seeds baseline plugins from the configured seed root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-plugin-prepare-"));
  const runtimeDataRoot = join(dir, "runtimes");
  const seedRoot = join(dir, "plugin-seed");
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const admin = store.bootstrapAdmin("Plugins", "plugin-admin@example.test", "hash");
    const tenantId = admin.tenant.id;
    const member = store.provisionUser(admin.user.id, tenantId, {
      email: "plugin-member@example.test",
      passwordHash: "hash",
      role: "member",
    });
    const target = (userId: string) => ({
      id: `e-${userId}-${tenantId}`,
      tenantId,
      userId,
      workspacePath: "",
      runtimeId: `e-${userId}-${tenantId}`,
      kind: "expert" as const,
    });
    await mkdir(join(seedRoot, "superpowers", "0.5.1"), { recursive: true });
    await writeFile(join(seedRoot, "superpowers", "0.5.1", "plugin.json"), "{}\n");
    await prepareExpertRuntime({
      target: target(admin.user.id),
      store,
      runtimeDataRoot,
      relayOrigin: "https://gateway.example.test",
      pluginSeedRoot: seedRoot,
    });
    const home = join(runtimeDataRoot, target(admin.user.id).runtimeId);
    assert.equal(
      await readFile(
        join(
          home,
          ".zcode",
          "cli",
          "plugins",
          "cache",
          "zcode-plugins-official",
          "superpowers",
          "0.5.1",
          "plugin.json",
        ),
        "utf8",
      ),
      "{}\n",
    );
    const config = JSON.parse(
      await readFile(join(home, ".zcode", "cli", "config.json"), "utf8"),
    ) as {
      plugins: { enabledPlugins: Record<string, boolean> };
    };
    assert.equal(config.plugins.enabledPlugins["superpowers@zcode-plugins-official"], true);
    // 安装注册表(installed_plugins.json)是发现链路的另一道门槛:记录指向
    // 种子缓存目录(installPath 为空时的解析回退),插件 skills 才会加载。
    const registry = JSON.parse(
      await readFile(join(home, ".zcode", "cli", "plugins", "installed_plugins.json"), "utf8"),
    ) as {
      version: number;
      plugins: Array<{ id: string; version: string; installPath: string; scope: string }>;
    };
    assert.equal(registry.version, 1);
    assert.deepEqual(
      registry.plugins.map(({ id, version, installPath, scope }) => ({
        id,
        version,
        installPath,
        scope,
      })),
      [
        {
          id: "superpowers@zcode-plugins-official",
          version: "0.5.1",
          installPath: "",
          scope: "user",
        },
      ],
    );

    // 未配置种子根:prepare 不产生任何插件缓存,也不写 CLI config 或安装注册表。
    await prepareExpertRuntime({
      target: target(member.user.id),
      store,
      runtimeDataRoot,
      relayOrigin: "https://gateway.example.test",
    });
    const memberHome = join(runtimeDataRoot, target(member.user.id).runtimeId);
    await assert.rejects(
      readFile(join(memberHome, ".zcode", "cli", "config.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    await assert.rejects(
      readFile(join(memberHome, ".zcode", "cli", "plugins", "installed_plugins.json")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("user-oauth connectors distribute only into the authorized expert HOME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-user-oauth-prepare-"));
  const runtimeDataRoot = join(dir, "runtimes");
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: Buffer.alloc(32, 0x42),
  });
  try {
    const admin = store.bootstrapAdmin("Oauth", "oauth-admin@example.test", "hash");
    const member = store.provisionUser(admin.user.id, admin.tenant.id, {
      email: "oauth-member@example.test",
      passwordHash: "hash",
      role: "member",
    });
    const tenantId = admin.tenant.id;
    const priorAllowlist = process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
    process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = JSON.stringify({
      [tenantId]: ["https://user-mcp.example.test"],
    });
    const connector = store.createTenantMcpConnector(admin.user.id, tenantId, {
      connectorKey: "drive",
      displayName: "Drive",
      url: "https://user-mcp.example.test/mcp",
      authMode: "user-oauth",
      authorizeUrl: "https://oauth.example.test/authorize",
      tokenUrl: "https://oauth.example.test/token",
      clientId: "client-1",
    });
    const target = (userId: string) => ({
      id: `e-${userId}-${tenantId}`,
      tenantId,
      userId,
      workspacePath: "",
      runtimeId: `e-${userId}-${tenantId}`,
      kind: "expert" as const,
    });
    const homeConfig = (userId: string) =>
      join(runtimeDataRoot, target(userId).runtimeId, ".zcode", "config.json");
    const servers = async (userId: string) =>
      (
        JSON.parse(await readFile(homeConfig(userId), "utf8")) as {
          mcp: { servers: Record<string, { headers: { Authorization: string } }> };
        }
      ).mcp.servers;
    try {
      // 未授权:两个专家 HOME 都没有条目。
      await prepareExpertRuntime({
        target: target(admin.user.id),
        store,
        runtimeDataRoot,
        relayOrigin: "https://gateway.example.test",
      });
      await prepareExpertRuntime({
        target: target(member.user.id),
        store,
        runtimeDataRoot,
        relayOrigin: "https://gateway.example.test",
      });
      assert.equal((await servers(admin.user.id))["enterprise-drive"], undefined);
      assert.equal((await servers(member.user.id))["enterprise-drive"], undefined);

      // 管理员授权后:仅其 HOME 拿到带个人 relay token 的条目。
      store.upsertUserConnectorAuthorization({
        connectorId: connector.id,
        userId: admin.user.id,
        accessToken: "admin-access-token",
      });
      const adminRelayToken = store.userConnectorAuthorization(
        connector.id,
        admin.user.id,
      )!.relayToken;
      await prepareExpertRuntime({
        target: target(admin.user.id),
        store,
        runtimeDataRoot,
        relayOrigin: "https://gateway.example.test",
      });
      await prepareExpertRuntime({
        target: target(member.user.id),
        store,
        runtimeDataRoot,
        relayOrigin: "https://gateway.example.test",
      });
      const adminEntry = (await servers(admin.user.id))["enterprise-drive"]!;
      assert.ok(adminEntry, "authorized expert should receive the connector entry");
      assert.equal(
        adminEntry.headers.Authorization,
        `Bearer ${adminRelayToken}`,
        "entry must carry the per-user relay token",
      );
      assert.equal((await servers(member.user.id))["enterprise-drive"], undefined);

      // 撤销后下一次准备移除条目。
      store.deleteUserConnectorAuthorization(admin.user.id, connector.id);
      await prepareExpertRuntime({
        target: target(admin.user.id),
        store,
        runtimeDataRoot,
        relayOrigin: "https://gateway.example.test",
      });
      assert.equal((await servers(admin.user.id))["enterprise-drive"], undefined);
    } finally {
      if (priorAllowlist === undefined) delete process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON;
      else process.env.ZCODE_ENTERPRISE_MCP_ALLOWLIST_JSON = priorAllowlist;
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
