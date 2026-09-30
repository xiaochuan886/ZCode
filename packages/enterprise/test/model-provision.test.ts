import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { provisionCaseModelProviders } from "../src/model-provision.js";

test("case provider config uses the native file and only a scoped relay token", async () => {
  const runtimeDataRoot = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-provision-"));
  try {
    const capabilities = await provisionCaseModelProviders({
      caseId: "case-1",
      actorId: "user-1",
      relayOrigin: "http://host.docker.internal:3031",
      runtimeDataRoot,
      configuredProviders: ["zai-api"],
    });
    const configPath = join(runtimeDataRoot, "case-1", ".zcode", "v2", "provider_config.json");
    const serialized = await readFile(configPath, "utf8");
    const config = JSON.parse(serialized) as {
      config: {
        defaultModelSelection: { providerId: string; modelId: string };
        providerConfigRules: {
          providerRules: Array<{
            providerId: string;
            config: { access: { apiKey: string }; api: { baseUrl: string } };
          }>;
        };
      };
    };
    const capability = capabilities.get("zai-api");
    assert.ok(capability);
    assert.equal(capability.actorId, "user-1");
    assert.deepEqual(config.config.defaultModelSelection, {
      providerId: "enterprise-zai-api",
      modelId: "GLM-5.3",
    });
    assert.equal(
      config.config.providerConfigRules.providerRules[0]?.config.access.apiKey,
      capability.token,
    );
    assert.equal(
      config.config.providerConfigRules.providerRules[0]?.config.api.baseUrl,
      "http://host.docker.internal:3031/api/enterprise/model-relay/case-1/zai-api",
    );
    assert.equal(serialized.includes("real-upstream-api-key"), false);

    await provisionCaseModelProviders({
      caseId: "case-1",
      actorId: "user-1",
      relayOrigin: "http://host.docker.internal:3031",
      runtimeDataRoot,
      configuredProviders: [],
    });
    const revoked = JSON.parse(await readFile(configPath, "utf8")) as {
      config: { providerConfigRules: { providerRules: unknown[] }; providerOrder: string[] };
    };
    assert.deepEqual(revoked.config.providerConfigRules.providerRules, []);
    assert.deepEqual(revoked.config.providerOrder, []);
  } finally {
    await rm(runtimeDataRoot, { recursive: true, force: true });
  }
});
