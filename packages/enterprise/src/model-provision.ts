import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  normalizeModelCredentialInput,
  type GatewayModelCredential,
} from "./model-credentials.js";
import { EnterpriseError } from "./types.js";

/** Enterprise mode has one generic provider slot; fixed Z.ai/BigModel slots are not provisioned. */
export const enterpriseModelProviders = ["custom"] as const;
export type EnterpriseModelProvider = (typeof enterpriseModelProviders)[number];
export const ENTERPRISE_MODEL_PROVIDER_ID = "enterprise-custom";

function managedProviderRule(credential: ReturnType<typeof normalizeModelCredentialInput>) {
  return {
    providerId: ENTERPRISE_MODEL_PROVIDER_ID,
    providerName: credential.providerName,
    config: {
      group: "standard-personal" as const,
      // 服务端分发：写入真实上游地址与真实 API key，原生 runtime 直连供应商。
      // 不再经过网关中继，避免中继的公网 DNS 校验在 fake-IP 代理环境下拒绝请求。
      access: { type: "api-key" as const, apiKey: credential.apiKey },
      api: {
        type: credential.apiType,
        baseUrl: credential.baseUrl,
      },
      personalModelIds: [credential.modelId],
      modelOrder: [credential.modelId],
    },
  };
}

function isManagedProviderId(value: unknown): boolean {
  return (
    value === ENTERPRISE_MODEL_PROVIDER_ID ||
    value === "enterprise-zai-api" ||
    value === "enterprise-bigmodel-api"
  );
}

function unmanagedProviderRules(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((rule) => {
    if (!rule || typeof rule !== "object") return false;
    return !isManagedProviderId((rule as { providerId?: unknown }).providerId);
  });
}

function unmanagedProviderOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (providerId): providerId is string =>
      typeof providerId === "string" && !isManagedProviderId(providerId),
  );
}

function unmanagedModelRules(value: unknown): Record<string, unknown[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { providerModelRules: [], manualProviderModelRules: [] };
  }
  const source = value as Record<string, unknown>;
  const filter = (rules: unknown): unknown[] =>
    Array.isArray(rules)
      ? rules.filter((rule) => {
          if (!rule || typeof rule !== "object") return false;
          return !isManagedProviderId((rule as { providerId?: unknown }).providerId);
        })
      : [];
  return {
    providerModelRules: filter(source.providerModelRules),
    manualProviderModelRules: filter(source.manualProviderModelRules),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function readPreviousConfig(target: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    throw new Error("invalid provider configuration");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Distribute the tenant credential into a Customer runtime. The runtime receives the real
 * upstream base URL and API key in the managed `enterprise-custom` slot and connects to the
 * provider directly with the native provider stack.
 */
export async function provisionCustomerModelProvider(input: {
  customerId: string;
  tenantId: string;
  runtimeDataRoot: string;
  credential: GatewayModelCredential | null;
}): Promise<void> {
  if (!input.customerId.trim() || !input.tenantId.trim())
    throw new Error("invalid Customer model scope");
  const suppliedCredential = input.credential;
  const credential = suppliedCredential ? normalizeModelCredentialInput(suppliedCredential) : null;
  if (credential && suppliedCredential && suppliedCredential.tenantId !== input.tenantId)
    throw new EnterpriseError("validation");

  const managedRule = credential ? managedProviderRule(credential) : null;

  const configDir = join(input.runtimeDataRoot, input.customerId, ".zcode", "v2");
  const target = join(configDir, "provider_config.json");
  const previous = await readPreviousConfig(target);
  const oldConfig = previous?.config as Record<string, unknown> | undefined;
  const oldProviderRules = (
    oldConfig?.providerConfigRules as { providerRules?: unknown[] } | undefined
  )?.providerRules;
  const providerRules = managedRule
    ? [managedRule, ...unmanagedProviderRules(oldProviderRules)]
    : unmanagedProviderRules(oldProviderRules);
  const providerOrder = unique([
    ...(managedRule ? [ENTERPRISE_MODEL_PROVIDER_ID] : []),
    ...unmanagedProviderOrder(oldConfig?.providerOrder),
  ]);
  const oldDefault = oldConfig?.defaultModelSelection;
  const defaultModelSelection = managedRule
    ? { providerId: ENTERPRISE_MODEL_PROVIDER_ID, modelId: credential!.modelId }
    : oldDefault &&
        typeof oldDefault === "object" &&
        !Array.isArray(oldDefault) &&
        !isManagedProviderId((oldDefault as { providerId?: unknown }).providerId)
      ? oldDefault
      : undefined;
  const modelConfigRules = unmanagedModelRules(oldConfig?.modelConfigRules);
  const contents = {
    schemaVersion: 1,
    config: {
      providerOrder,
      providerConfigRules: { providerRules },
      modelConfigRules,
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
    await rm(temporary, { force: true });
    throw error;
  }
}
