import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PROVIDER_KEY_PATTERN } from "./provider-format.js";
import { EnterpriseError, type TenantModelCatalogEntry } from "./types.js";

/** One enabled tenant catalog provider as handed to the distribution step. */
export interface ExpertModelProviderSlot {
  tenantId: string;
  providerKey: string;
  displayName: string;
  apiType: string;
  baseUrl: string;
  apiKey: string;
  /** 目录富条目(v10 原样传入);只有 `enabled !== false` 的 id 会写入专家槽位。 */
  models: TenantModelCatalogEntry[];
  defaultModel: string;
  isDefault: boolean;
}

/** Managed provider slot id: `enterprise-<provider_key>`; unmanaged entries are preserved. */
export const managedModelProviderId = (providerKey: string): string => `enterprise-${providerKey}`;

function isManagedProviderId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // legacy 固定槽位(enterprise-zai-api / enterprise-bigmodel-api)同样由该前缀规则覆盖。
  return value.startsWith("enterprise-")
    ? PROVIDER_KEY_PATTERN.test(value.slice("enterprise-".length))
    : false;
}

/**
 * 分发到专家槽位的模型 id:单模型级 `enabled === false` 的条目被排除。
 * 分发保持 id-only——徽标元数据(contextWindow/输入输出格式等)不进入
 * provider_config.json,由专家 runtime 的内置规则引擎按 id 自行解析。
 */
function distributedModelIds(provider: ExpertModelProviderSlot): string[] {
  return provider.models.filter((entry) => entry.enabled !== false).map((entry) => entry.id);
}

/** 默认模型的分发 id:默认模型本身被停用时顺延到首个可用模型,再退回空串。 */
function distributedDefaultModelId(provider: ExpertModelProviderSlot): string {
  const ids = distributedModelIds(provider);
  if (provider.defaultModel && ids.includes(provider.defaultModel)) return provider.defaultModel;
  return ids[0] ?? "";
}

function managedProviderRule(provider: ExpertModelProviderSlot) {
  const distributed = distributedModelIds(provider);
  // 目录为空但 defaultModel 仍有值时保留旧回退(正常写入路径下 models 恒含
  // defaultModel,回退只为防御异常行);只要目录非空就只发未停用条目,
  // 防止全部停用时停用的默认模型借回退复活。
  const models =
    provider.models.length === 0 ? [provider.defaultModel].filter(Boolean) : distributed;
  return {
    providerId: managedModelProviderId(provider.providerKey),
    providerName: provider.displayName,
    config: {
      group: "standard-personal" as const,
      // 服务端分发：写入真实上游地址与真实 API key，原生 runtime 直连供应商。
      access: { type: "api-key" as const, apiKey: provider.apiKey },
      api: {
        type: provider.apiType,
        baseUrl: provider.baseUrl,
      },
      personalModelIds: models,
      modelOrder: models,
    },
  };
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
 * Distribute the tenant provider catalog into an expert runtime. Every enabled provider
 * becomes a managed `enterprise-<provider_key>` slot carrying the real upstream base URL,
 * the real API key and its model list; the tenant-default provider pins the default model.
 * The managed slot set is replaced atomically on every prepare; unmanaged entries survive.
 */
export async function provisionExpertModelProviders(input: {
  runtimeOwner: string;
  tenantId: string;
  runtimeDataRoot: string;
  providers: ExpertModelProviderSlot[];
}): Promise<void> {
  if (!input.runtimeOwner.trim() || !input.tenantId.trim())
    throw new Error("invalid expert runtime model scope");
  for (const provider of input.providers) {
    if (provider.tenantId !== input.tenantId) throw new EnterpriseError("validation");
  }
  const managedRules = input.providers.map((provider) => managedProviderRule(provider));
  const managedIds = managedRules.map((rule) => rule.providerId);
  const defaultProvider = input.providers.find((provider) => provider.isDefault);

  const configDir = join(input.runtimeDataRoot, input.runtimeOwner, ".zcode", "v2");
  const target = join(configDir, "provider_config.json");
  const previous = await readPreviousConfig(target);
  const oldConfig = previous?.config as Record<string, unknown> | undefined;
  const oldProviderRules = (
    oldConfig?.providerConfigRules as { providerRules?: unknown[] } | undefined
  )?.providerRules;
  const providerRules = [...managedRules, ...unmanagedProviderRules(oldProviderRules)];
  const providerOrder = unique([
    ...managedIds,
    ...unmanagedProviderOrder(oldConfig?.providerOrder),
  ]);
  const oldDefault = oldConfig?.defaultModelSelection;
  const previousDefault =
    oldDefault && typeof oldDefault === "object" && !Array.isArray(oldDefault)
      ? (oldDefault as { providerId?: unknown; modelId?: unknown })
      : undefined;
  const defaultModelSelection = defaultProvider
    ? {
        providerId: managedModelProviderId(defaultProvider.providerKey),
        // 默认模型被单模型级停用时顺延到首个可用模型;全部停用则置空
        // (下方的 truthy 展开会整体省略 defaultModelSelection),避免默认
        // 选择指向一个未分发进槽位的模型 id。
        modelId: distributedDefaultModelId(defaultProvider),
      }
    : previousDefault &&
        typeof previousDefault.providerId === "string" &&
        typeof previousDefault.modelId === "string" &&
        !isManagedProviderId(previousDefault.providerId)
      ? { providerId: previousDefault.providerId, modelId: previousDefault.modelId }
      : undefined;
  const modelConfigRules = unmanagedModelRules(oldConfig?.modelConfigRules);
  const contents = {
    schemaVersion: 1,
    config: {
      providerOrder,
      providerConfigRules: { providerRules },
      modelConfigRules,
      ...(defaultModelSelection && defaultModelSelection.modelId ? { defaultModelSelection } : {}),
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
