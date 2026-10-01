import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { EnterpriseError } from "./types.js";

const MODEL_CREDENTIAL_KEY_ENV = "ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY";
const MODEL_CREDENTIAL_KEY_VERSION = 1;
const GCM_NONCE_BYTES = 12;
const AES_KEY_BYTES = 32;
const DEFAULT_CUSTOM_PROVIDER_NAME = "Custom provider";
const DEFAULT_LEGACY_MODEL_ID = "default-model";

const blockedModelIpv4Subnets = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));

const blockedModelIpv6Subnets = [
  "2001::/32",
  "2001:2::/48",
  "2001:10::/28",
  "2001:20::/28",
  "2001:db8::/32",
  "2002::/16",
  "3ffe::/16",
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

export type ModelCredentialEncryptionKey = string | Uint8Array;

/** Enterprise mode exposes one deliberately generic provider slot. */
export const MODEL_PROVIDER_FAMILIES = ["custom"] as const;
export type ModelProviderFamily = (typeof MODEL_PROVIDER_FAMILIES)[number];

/** These are the native wire formats supported by the enterprise relay. */
export const MODEL_API_TYPES = ["anthropic-messages", "openai-chat-completions"] as const;
export type ModelApiType = (typeof MODEL_API_TYPES)[number];

export interface ModelCredentialInput {
  providerFamily: ModelProviderFamily;
  providerName?: string;
  apiType: ModelApiType;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface ModelCredentialDetails {
  providerName?: string;
  apiType?: ModelApiType;
  baseUrl?: string;
  modelId?: string;
}

export interface NormalizedModelCredentialInput {
  providerFamily: ModelProviderFamily;
  providerName: string;
  apiType: ModelApiType;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface ModelCredentialStatus {
  tenantId: string;
  providerFamily: ModelProviderFamily;
  providerName: string;
  apiType: ModelApiType;
  baseUrl: string;
  modelId: string;
  status: "configured" | "revoked";
  configured: boolean;
  lastFour: string | null;
  updatedAt: string;
}

/** The decrypted value is an internal gateway capability; never serialize it to a browser. */
export interface GatewayModelCredential {
  tenantId: string;
  providerFamily: ModelProviderFamily;
  providerName: string;
  apiType: ModelApiType;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface EncryptedModelCredential {
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
}

export interface EncryptedModelCredentialRow {
  tenantId: string;
  providerFamily: string;
  providerName: string | null;
  apiType: string | null;
  baseUrl: string | null;
  modelId: string | null;
  keyVersion: number;
  ciphertext: string | null;
  nonce: string | null;
  authTag: string | null;
  lastFour: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

const invalid = (): never => {
  // Do not include supplied values in errors. They may contain live credentials or private URLs.
  throw new EnterpriseError("validation");
};

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) invalid();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== AES_KEY_BYTES) invalid();
  return decoded;
}

function decodeHex(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) invalid();
  return Buffer.from(value, "hex");
}

/** Resolve a 32-byte key from an explicit constructor value or the operator environment. */
export function resolveModelCredentialKey(
  value: ModelCredentialEncryptionKey | undefined = process.env[MODEL_CREDENTIAL_KEY_ENV],
): Buffer {
  if (value == null || (typeof value === "string" && !value.trim())) invalid();
  if (typeof value !== "string") {
    const key = Buffer.from(value as Uint8Array);
    if (key.length !== AES_KEY_BYTES) invalid();
    return key;
  }

  const normalized = value.trim();
  if (normalized.startsWith("base64:")) return decodeBase64(normalized.slice("base64:".length));
  if (normalized.startsWith("hex:")) return decodeHex(normalized.slice("hex:".length));
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return decodeHex(normalized);
  return decodeBase64(normalized);
}

export function normalizeProviderFamily(value: string): ModelProviderFamily {
  if (typeof value !== "string") invalid();
  const normalized = value.trim().toLowerCase();
  if (normalized !== "custom") invalid();
  return normalized as ModelProviderFamily;
}

export function normalizeModelApiType(value: string): ModelApiType {
  if (typeof value !== "string") invalid();
  const normalized = value.trim().toLowerCase();
  if (!MODEL_API_TYPES.includes(normalized as ModelApiType)) invalid();
  return normalized as ModelApiType;
}

/** Return true only for an address that can be reached on the public Internet. */
export function isPublicModelAddress(address: string, family: number): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (family === 4 && parsed.kind() === "ipv4") {
      const ipv4 = parsed as ipaddr.IPv4;
      return (
        ipv4.range() === "unicast" && !blockedModelIpv4Subnets.some((subnet) => ipv4.match(subnet))
      );
    }
    if (family !== 6 || parsed.kind() !== "ipv6") return false;
    const ipv6 = parsed as ipaddr.IPv6;
    // Only globally routable IPv6 is accepted. This excludes loopback, ULA, link-local,
    // documentation, benchmark and other special ranges that can be used for SSRF pivots.
    return (
      ipv6.range() === "unicast" &&
      (ipv6.parts[0]! & 0xe000) === 0x2000 &&
      !blockedModelIpv6Subnets.some((subnet) => ipv6.match(subnet))
    );
  } catch {
    return false;
  }
}

/** Validate and canonicalize an administrator supplied upstream base URL. */
export function normalizeModelBaseUrl(value: string): string {
  if (typeof value !== "string" || !value.trim()) invalid();
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return invalid();
  }
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    !hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (isIP(hostname) !== 0 && !isPublicModelAddress(hostname, isIP(hostname)))
  )
    invalid();
  parsed.hostname = hostname;
  parsed.pathname = parsed.pathname.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
  return parsed.toString().replace(/\/$/u, "");
}

export function keyLastFour(apiKey: string): string | null {
  const characters = [...apiKey];
  return characters.length >= 4 ? characters.slice(-4).join("") : null;
}

export function normalizeModelCredentialInput(
  input: ModelCredentialInput,
): NormalizedModelCredentialInput {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.providerFamily !== "string" ||
    (typeof input.providerName !== "undefined" && typeof input.providerName !== "string") ||
    typeof input.apiType !== "string" ||
    typeof input.baseUrl !== "string" ||
    typeof input.modelId !== "string" ||
    typeof input.apiKey !== "string"
  )
    invalid();
  const providerFamily = normalizeProviderFamily(input.providerFamily);
  const providerName = (input.providerName ?? DEFAULT_CUSTOM_PROVIDER_NAME).trim();
  const modelId = input.modelId.trim();
  const apiKey = input.apiKey;
  if (
    !providerName ||
    providerName.length > 128 ||
    providerName.includes("\0") ||
    !modelId ||
    modelId.length > 256 ||
    modelId.includes("\0") ||
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    apiKey.includes("\0")
  )
    invalid();
  return {
    providerFamily,
    providerName,
    apiType: normalizeModelApiType(input.apiType),
    baseUrl: normalizeModelBaseUrl(input.baseUrl),
    modelId,
    apiKey,
  };
}

function associatedData(tenantId: string, providerFamily: string): Buffer {
  return Buffer.from(`${tenantId}\0${providerFamily}`, "utf8");
}

export class ModelCredentialCipher {
  private readonly key: Buffer;

  constructor(key?: ModelCredentialEncryptionKey) {
    this.key = resolveModelCredentialKey(key);
  }

  encrypt(apiKey: string, tenantId: string, providerFamily: string): EncryptedModelCredential {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(associatedData(tenantId, providerFamily));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return {
      keyVersion: MODEL_CREDENTIAL_KEY_VERSION,
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(row: EncryptedModelCredential, tenantId: string, providerFamily: string): string {
    if (row.keyVersion !== MODEL_CREDENTIAL_KEY_VERSION) throw new EnterpriseError("conflict");
    try {
      const nonce = Buffer.from(row.nonce, "base64");
      const authTag = Buffer.from(row.authTag, "base64");
      const ciphertext = Buffer.from(row.ciphertext, "base64");
      if (nonce.length !== GCM_NONCE_BYTES || authTag.length !== 16 || ciphertext.length === 0)
        throw new Error("invalid encrypted credential");
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(associatedData(tenantId, providerFamily));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Authentication and decoding failures must not reveal ciphertext or key material.
      throw new EnterpriseError("conflict");
    }
  }
}

function safeApiType(value: string | null): ModelApiType {
  return value === "openai-chat-completions" ? value : "anthropic-messages";
}

function valueOrDefault(value: string | null, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

export function toModelCredentialStatus(row: EncryptedModelCredentialRow): ModelCredentialStatus {
  const configured =
    row.revokedAt == null && row.ciphertext != null && row.nonce != null && row.authTag != null;
  return {
    tenantId: row.tenantId,
    providerFamily: "custom",
    providerName: valueOrDefault(row.providerName, DEFAULT_CUSTOM_PROVIDER_NAME),
    apiType: safeApiType(row.apiType),
    baseUrl: valueOrDefault(row.baseUrl, ""),
    modelId: valueOrDefault(row.modelId, DEFAULT_LEGACY_MODEL_ID),
    status: configured ? "configured" : "revoked",
    configured,
    lastFour: configured ? row.lastFour : null,
    updatedAt: row.updatedAt,
  };
}
