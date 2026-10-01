import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { provisionCustomerModelProvider } from "../src/model-provision.js";

type ProviderConfigFile = {
  config: {
    defaultModelSelection?: { providerId: string; modelId: string };
    providerOrder: string[];
    providerConfigRules: {
      providerRules: Array<{
        providerId: string;
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

test("customer provider config distributes the real upstream credential for native access", async () => {
  const runtimeDataRoot = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-provision-"));
  try {
    await provisionCustomerModelProvider({
      customerId: "customer-1",
      tenantId: "tenant-a",
      runtimeDataRoot,
      credential: {
        tenantId: "tenant-a",
        providerFamily: "custom",
        providerName: "Acme AI",
        apiType: "openai-chat-completions",
        baseUrl: "https://api.example.com/v1",
        modelId: "acme-model",
        apiKey: "real-upstream-api-key",
      },
    });
    const configPath = join(runtimeDataRoot, "customer-1", ".zcode", "v2", "provider_config.json");
    const serialized = await readFile(configPath, "utf8");
    const config = JSON.parse(serialized) as ProviderConfigFile;
    const rule = config.config.providerConfigRules.providerRules[0]!;
    assert.deepEqual(config.config.defaultModelSelection, {
      providerId: "enterprise-custom",
      modelId: "acme-model",
    });
    // 服务端分发：真实 key 与真实上游地址直接写入，原生 runtime 直连供应商。
    assert.equal(rule.providerId, "enterprise-custom");
    assert.equal(rule.config.access.apiKey, "real-upstream-api-key");
    assert.equal(rule.config.api.baseUrl, "https://api.example.com/v1");
    assert.equal(rule.config.api.type, "openai-chat-completions");
    assert.deepEqual(rule.config.personalModelIds, ["acme-model"]);
    assert.deepEqual(rule.config.modelOrder, ["acme-model"]);
    assert.equal(serialized.includes("model-relay"), false);

    await provisionCustomerModelProvider({
      customerId: "customer-1",
      tenantId: "tenant-a",
      runtimeDataRoot,
      credential: null,
    });
    const revoked = JSON.parse(await readFile(configPath, "utf8")) as ProviderConfigFile;
    assert.deepEqual(revoked.config.providerConfigRules.providerRules, []);
    assert.deepEqual(revoked.config.providerOrder, []);
  } finally {
    await rm(runtimeDataRoot, { recursive: true, force: true });
  }
});

test("customer provider provisioning replaces a previously managed slot and keeps unmanaged rules", async () => {
  const runtimeDataRoot = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-replace-"));
  try {
    const configDir = join(runtimeDataRoot, "customer-1", ".zcode", "v2");
    const configPath = join(configDir, "provider_config.json");
    await (await import("node:fs/promises")).mkdir(configDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: ["enterprise-custom", "self-hosted", "enterprise-zai-api"],
          providerConfigRules: {
            providerRules: [
              {
                providerId: "enterprise-custom",
                config: {
                  access: { type: "api-key", apiKey: "old-token" },
                  api: { type: "anthropic-messages", baseUrl: "https://old.example.com" },
                  personalModelIds: ["old-model"],
                  modelOrder: ["old-model"],
                },
              },
              {
                providerId: "enterprise-zai-api",
                config: {
                  access: { type: "api-key", apiKey: "old-fixed-token" },
                  api: { type: "anthropic-messages", baseUrl: "https://old-zai.example.com" },
                  personalModelIds: ["old-zai-model"],
                  modelOrder: ["old-zai-model"],
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
    await provisionCustomerModelProvider({
      customerId: "customer-1",
      tenantId: "tenant-a",
      runtimeDataRoot,
      credential: {
        tenantId: "tenant-a",
        providerFamily: "custom",
        providerName: "Acme AI",
        apiType: "anthropic-messages",
        baseUrl: "https://api.example.com",
        modelId: "acme-model",
        apiKey: "real-upstream-api-key",
      },
    });
    const config = JSON.parse(await readFile(configPath, "utf8")) as ProviderConfigFile;
    const rules = config.config.providerConfigRules.providerRules;
    assert.equal(rules.length, 2);
    assert.deepEqual(
      rules.map((rule) => rule.providerId),
      ["enterprise-custom", "self-hosted"],
    );
    assert.equal(rules[0]!.config.access.apiKey, "real-upstream-api-key");
    assert.deepEqual(config.config.providerOrder, ["enterprise-custom", "self-hosted"]);
    assert.deepEqual(config.config.defaultModelSelection, {
      providerId: "enterprise-custom",
      modelId: "acme-model",
    });
  } finally {
    await rm(runtimeDataRoot, { recursive: true, force: true });
  }
});

test("customer provider provisioning refuses a credential from another tenant", async () => {
  const runtimeDataRoot = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-cross-tenant-"));
  try {
    await assert.rejects(
      provisionCustomerModelProvider({
        customerId: "customer-1",
        tenantId: "tenant-a",
        runtimeDataRoot,
        credential: {
          tenantId: "tenant-b",
          providerFamily: "custom",
          providerName: "Other tenant",
          apiType: "anthropic-messages",
          baseUrl: "https://api.example.com",
          modelId: "model",
          apiKey: "secret",
        },
      }),
      /validation/,
    );
  } finally {
    await rm(runtimeDataRoot, { recursive: true, force: true });
  }
});
