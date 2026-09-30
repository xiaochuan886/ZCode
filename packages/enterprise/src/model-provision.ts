import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const enterpriseModelProviders = ["zai-api", "bigmodel-api"] as const;
export type EnterpriseModelProvider = (typeof enterpriseModelProviders)[number];

export interface ModelRelayCapability {
  token: string;
  actorId: string;
  providerFamily: EnterpriseModelProvider;
}

function managedRule(
  providerFamily: EnterpriseModelProvider,
  caseId: string,
  relayOrigin: string,
  token: string,
) {
  return {
    providerId: `enterprise-${providerFamily}`,
    templateId: providerFamily,
    providerName: providerFamily === "zai-api" ? "企业 Z.ai Coding Plan" : "企业智谱 Coding Plan",
    config: {
      group: "standard-personal",
      access: { type: "zhipu-coding-plan-api-key", apiKey: token },
      api: {
        type: "anthropic-messages",
        baseUrl: `${relayOrigin}/api/enterprise/model-relay/${encodeURIComponent(caseId)}/${providerFamily}`,
      },
    },
  };
}

/** Materialize only scoped relay capabilities in Case HOME; tenant API keys stay in the gateway. */
export async function provisionCaseModelProviders(input: {
  caseId: string;
  actorId: string;
  relayOrigin: string;
  runtimeDataRoot: string;
  configuredProviders: readonly EnterpriseModelProvider[];
}): Promise<Map<EnterpriseModelProvider, ModelRelayCapability>> {
  const capabilities = new Map<EnterpriseModelProvider, ModelRelayCapability>();
  const rules = input.configuredProviders.map((providerFamily) => {
    const token = randomBytes(32).toString("base64url");
    capabilities.set(providerFamily, { token, actorId: input.actorId, providerFamily });
    return managedRule(providerFamily, input.caseId, input.relayOrigin, token);
  });
  const configDir = join(input.runtimeDataRoot, input.caseId, ".zcode", "v2");
  const target = join(configDir, "provider_config.json");
  let previous: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      previous = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const oldConfig = previous?.config as Record<string, unknown> | undefined;
  const oldRules = (oldConfig?.providerConfigRules as { providerRules?: unknown[] } | undefined)
    ?.providerRules;
  const unmanagedRules = Array.isArray(oldRules)
    ? oldRules.filter((rule) => {
        if (!rule || typeof rule !== "object") return false;
        const providerId = (rule as { providerId?: unknown }).providerId;
        return providerId !== "enterprise-zai-api" && providerId !== "enterprise-bigmodel-api";
      })
    : [];
  const providerOrder = [
    ...rules.map((rule) => rule.providerId),
    ...(
      (Array.isArray(oldConfig?.providerOrder) ? oldConfig.providerOrder : []) as string[]
    ).filter((id) => id !== "enterprise-zai-api" && id !== "enterprise-bigmodel-api"),
  ];
  const defaultModelSelection = rules.length
    ? { providerId: rules[0]!.providerId, modelId: "GLM-5.3" }
    : undefined;
  const contents = {
    schemaVersion: 1,
    config: {
      providerOrder,
      providerConfigRules: { providerRules: [...rules, ...unmanagedRules] },
      modelConfigRules: oldConfig?.modelConfigRules ?? {
        providerModelRules: [],
        manualProviderModelRules: [],
      },
      ...(defaultModelSelection ? { defaultModelSelection } : {}),
    },
  };
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true }));
    throw error;
  }
  return capabilities;
}
