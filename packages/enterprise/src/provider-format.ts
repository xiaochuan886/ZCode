import {
  EnterpriseError,
  type ModelInputFormatMetadata,
  type ModelOutputFormatMetadata,
  type TenantModelCatalogEntry,
} from "./types.js";
import type { EncryptedModelCredential, ModelApiType } from "./model-credential-format.js";

/** Stable slug identifying a provider inside its tenant; also the managed slot suffix. */
export const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MODELS = 64;
const MAX_MODEL_ID_LENGTH = 256;

export interface TenantModelProviderInput {
  providerKey: string;
  displayName: string;
  apiType: string;
  baseUrl: string;
  apiKey: string;
  models?: (string | TenantModelCatalogEntry)[];
  defaultModel?: string;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface TenantModelProviderPatch {
  providerKey?: string;
  displayName?: string;
  apiType?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: (string | TenantModelCatalogEntry)[];
  defaultModel?: string;
  isDefault?: boolean;
  enabled?: boolean;
}

/**
 * The encrypted API key envelope stored in `api_key_encrypted`. The last four characters
 * live inside the envelope so the fixed v7 schema needs no extra column, and projections
 * never need to decrypt the key.
 */
export interface ProviderKeyEnvelope extends EncryptedModelCredential {
  lastFour: string | null;
}

export interface ProviderRow {
  id: string;
  tenantId: string;
  providerKey: string;
  displayName: string;
  apiType: ModelApiType;
  baseUrl: string;
  envelope: ProviderKeyEnvelope;
  models: TenantModelCatalogEntry[];
  defaultModel: string;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
}

export const invalid = (): never => {
  // Never include supplied values in errors; they may contain live credentials.
  throw new EnterpriseError("validation");
};

export function validateProviderKey(value: string): string {
  if (typeof value !== "string" || !PROVIDER_KEY_PATTERN.test(value)) invalid();
  return value;
}

export function validateDisplayName(value: string): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || normalized.includes("\0")) invalid();
  return normalized;
}

export function validateApiKey(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) invalid();
  return value;
}

const INPUT_FORMAT_KEYS = [
  "supportsText",
  "supportsImage",
  "supportsVideo",
  "supportsAudio",
  "supportsPdf",
] as const;
const ENTRY_KEYS = [
  "id",
  "enabled",
  "contextWindow",
  "inputFormat",
  "outputFormat",
  "supportsToolCall",
  "supportsJsonSchemaOutput",
  "supportsNativeWebSearch",
  "supportsMidConversationSystem",
  "optionSpecs",
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 本文件运行在 strictNullChecks=off 的基线下:对 never 返回函数(invalid)的
 * 调用不做控制流收窄,因此以下校验一律用内联 throw 语句收窄;错误码保持既有
 * EnterpriseError("validation") 语义不变。
 */
const validationError = () => new EnterpriseError("validation");

/** 数字元数据(如 contextWindow)必须是有限正数;拒绝 NaN/Infinity/非正数。 */
function validatePositiveNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  throw validationError();
}

function validateBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw validationError();
}

/** 严格对象形状:键集合必须完全一致(未知键拒绝,缺键拒绝),值全部为布尔。 */
function validateBooleanShape<T extends object>(
  value: unknown,
  keys: readonly (keyof T & string)[],
): T {
  if (!isPlainObject(value)) throw validationError();
  const present = Object.keys(value);
  if (present.length !== keys.length || keys.some((key) => !(key in value)))
    throw validationError();
  const result: Record<string, boolean> = {};
  for (const key of keys) result[key] = validateBoolean(value[key]);
  return result as T;
}

/**
 * 校验单个富条目并归一化为存储形状:
 * - 字符串输入(向后兼容)归一化为 `{id}`;
 * - 未知元数据键/坏类型一律 validation 拒绝(不给默认值兜底,避免静默丢数据);
 * - enabled 存储约定:只有显式 `false` 才落 `enabled:false`,true/缺省都省略键
 *   (缺省即启用),保证存量行迁移后无需补写 enabled:true。
 */
function validateModelEntry(value: unknown): TenantModelCatalogEntry {
  if (typeof value === "string") {
    const model = value.trim();
    if (!model || model.length > MAX_MODEL_ID_LENGTH || model.includes("\0"))
      throw validationError();
    return { id: model };
  }
  if (!isPlainObject(value)) throw validationError();
  const unknownKeys = Object.keys(value).filter(
    (key) => !(ENTRY_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length) throw validationError();
  if (typeof value.id !== "string") throw validationError();
  const model = value.id.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH || model.includes("\0")) throw validationError();
  const entry: TenantModelCatalogEntry = { id: model };
  if (value.enabled !== undefined && !validateBoolean(value.enabled)) entry.enabled = false;
  if (value.contextWindow !== undefined)
    entry.contextWindow = validatePositiveNumber(value.contextWindow);
  if (value.inputFormat !== undefined)
    entry.inputFormat = validateBooleanShape<ModelInputFormatMetadata>(
      value.inputFormat,
      INPUT_FORMAT_KEYS,
    );
  if (value.outputFormat !== undefined)
    entry.outputFormat = validateBooleanShape<ModelOutputFormatMetadata>(value.outputFormat, [
      "supportsText",
    ]);
  if (value.supportsToolCall !== undefined)
    entry.supportsToolCall = validateBoolean(value.supportsToolCall);
  if (value.supportsJsonSchemaOutput !== undefined)
    entry.supportsJsonSchemaOutput = validateBoolean(value.supportsJsonSchemaOutput);
  if (value.supportsNativeWebSearch !== undefined)
    entry.supportsNativeWebSearch = validateBoolean(value.supportsNativeWebSearch);
  if (value.supportsMidConversationSystem !== undefined)
    entry.supportsMidConversationSystem = validateBoolean(value.supportsMidConversationSystem);
  if (value.optionSpecs !== undefined) entry.optionSpecs = validateOptionSpecs(value.optionSpecs);
  return entry;
}

/**
 * optionSpecs(编辑弹窗默认参数规格)校验:两个受控子键,各自内部键集合严格、
 * 值形状受限(数字/字符串/字符串数组),map 是原生规则引擎的表达式字符串原样保存。
 */
function validateOptionSpecs(value: unknown): NonNullable<TenantModelCatalogEntry["optionSpecs"]> {
  if (!isPlainObject(value)) throw validationError();
  const allowed = new Set(["maxOutputTokens", "reasoningLevel"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw validationError();
  const result: NonNullable<TenantModelCatalogEntry["optionSpecs"]> = {};
  const maxOutput = value.maxOutputTokens;
  if (maxOutput !== undefined) {
    if (!isPlainObject(maxOutput)) throw validationError();
    const keys = new Set(Object.keys(maxOutput));
    if (keys.size === 0 || ![...keys].every((key) => key === "max" || key === "map"))
      throw validationError();
    const normalized: { max?: number; map?: string } = {};
    if (maxOutput.max !== undefined) {
      if (typeof maxOutput.max !== "number" || !Number.isFinite(maxOutput.max))
        throw validationError();
      normalized.max = maxOutput.max;
    }
    if (maxOutput.map !== undefined) {
      if (typeof maxOutput.map !== "string") throw validationError();
      normalized.map = maxOutput.map;
    }
    result.maxOutputTokens = normalized;
  }
  const reasoning = value.reasoningLevel;
  if (reasoning !== undefined) {
    if (!isPlainObject(reasoning)) throw validationError();
    const keys = new Set(Object.keys(reasoning));
    if (keys.size === 0 || ![...keys].every((key) => key === "values" || key === "map"))
      throw validationError();
    const normalized: { values?: string[]; map?: string } = {};
    if (reasoning.values !== undefined) {
      if (
        !Array.isArray(reasoning.values) ||
        reasoning.values.length === 0 ||
        !reasoning.values.every((item) => typeof item === "string" && item.length > 0)
      )
        throw validationError();
      normalized.values = reasoning.values as string[];
    }
    if (reasoning.map !== undefined) {
      if (typeof reasoning.map !== "string") throw validationError();
      normalized.map = reasoning.map;
    }
    result.reasoningLevel = normalized;
  }
  if (!result.maxOutputTokens && !result.reasoningLevel) throw validationError();
  return result;
}

export function validateModels(
  value: (string | TenantModelCatalogEntry)[] | undefined,
): TenantModelCatalogEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid();
  const models: TenantModelCatalogEntry[] = [];
  for (const entry of value) {
    const model = validateModelEntry(entry);
    // id 去重保序:同一 id 的后到条目直接拒绝,避免静默合并元数据。
    if (models.some((existing) => existing.id === model.id)) invalid();
    models.push(model);
  }
  if (models.length > MAX_MODELS) invalid();
  return models;
}

export function validateDefaultModel(value: string | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string") invalid();
  const model = value.trim();
  if (model.length > MAX_MODEL_ID_LENGTH || model.includes("\0")) invalid();
  return model;
}

export function resolveModels(
  models: TenantModelCatalogEntry[],
  defaultModel: string,
): { models: TenantModelCatalogEntry[]; defaultModel: string } {
  if (!models.length) return { models, defaultModel };
  const ids = models.map((entry) => entry.id);
  const resolved = defaultModel && ids.includes(defaultModel) ? defaultModel : ids[0]!;
  if (defaultModel && resolved !== defaultModel) invalid();
  return { models, defaultModel: resolved };
}

/**
 * 读取库中 v10 形状的 models 列(JSON 对象数组)。存储值一律经 validateModels
 * 或 v10 迁移写入,这里做防御性形状检查,损坏行 fail closed(conflict),
 * 与 api_key_envelope 的 decodeEnvelope 同一错误语义。
 */
export function decodeStoredModels(raw: string): TenantModelCatalogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnterpriseError("conflict");
  }
  if (!Array.isArray(parsed)) throw new EnterpriseError("conflict");
  return parsed.map((entry): TenantModelCatalogEntry => {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || !entry.id)
      throw new EnterpriseError("conflict");
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
      throw new EnterpriseError("conflict");
    if (entry.contextWindow !== undefined && typeof entry.contextWindow !== "number")
      throw new EnterpriseError("conflict");
    // 未知元数据键在写入路径已拒绝;读取保留原样键,避免重复实现投影逻辑。
    return entry as unknown as TenantModelCatalogEntry;
  });
}

export function decodeEnvelope(raw: string): ProviderKeyEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnterpriseError("conflict");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new EnterpriseError("conflict");
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.keyVersion !== "number" ||
    typeof record.ciphertext !== "string" ||
    typeof record.nonce !== "string" ||
    typeof record.authTag !== "string"
  )
    throw new EnterpriseError("conflict");
  return {
    keyVersion: record.keyVersion,
    ciphertext: record.ciphertext,
    nonce: record.nonce,
    authTag: record.authTag,
    lastFour: record.lastFour == null ? null : String(record.lastFour),
  };
}
