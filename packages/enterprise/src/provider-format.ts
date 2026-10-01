import { EnterpriseError } from "./types.js";
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
  models?: string[];
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
  models?: string[];
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
  models: string[];
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

export function validateModels(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid();
  const models: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") invalid();
    const model = entry.trim();
    if (!model || model.length > MAX_MODEL_ID_LENGTH || model.includes("\0")) invalid();
    if (!models.includes(model)) models.push(model);
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
  models: string[],
  defaultModel: string,
): { models: string[]; defaultModel: string } {
  if (!models.length) return { models, defaultModel };
  const resolved = defaultModel && models.includes(defaultModel) ? defaultModel : models[0]!;
  if (defaultModel && resolved !== defaultModel) invalid();
  return { models, defaultModel: resolved };
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
