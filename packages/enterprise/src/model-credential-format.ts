import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { EnterpriseError, MODEL_API_TYPES, type ModelApiType } from "./types.js";

// 协议清单的权威定义在 types.ts(避免模块环);这里原样 re-export,
// 既有从本模块导入 MODEL_API_TYPES / ModelApiType 的消费方不受影响。
export { MODEL_API_TYPES } from "./types.js";
export type { ModelApiType } from "./types.js";

const MODEL_CREDENTIAL_KEY_ENV = "ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY";
const MODEL_CREDENTIAL_KEY_VERSION = 1;
const GCM_NONCE_BYTES = 12;
const AES_KEY_BYTES = 32;

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

export interface EncryptedModelCredential {
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
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
  if (normalized.startsWith("hex:")) return decodeHex(normalized);
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return decodeHex(normalized);
  return decodeBase64(normalized);
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

function associatedData(tenantId: string, bindingKey: string): Buffer {
  return Buffer.from(`${tenantId}\0${bindingKey}`, "utf8");
}

export class ModelCredentialCipher {
  private readonly key: Buffer;

  constructor(key?: ModelCredentialEncryptionKey) {
    this.key = resolveModelCredentialKey(key);
  }

  encrypt(apiKey: string, tenantId: string, bindingKey: string): EncryptedModelCredential {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(associatedData(tenantId, bindingKey));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return {
      keyVersion: MODEL_CREDENTIAL_KEY_VERSION,
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(row: EncryptedModelCredential, tenantId: string, bindingKey: string): string {
    if (row.keyVersion !== MODEL_CREDENTIAL_KEY_VERSION) throw new EnterpriseError("conflict");
    try {
      const nonce = Buffer.from(row.nonce, "base64");
      const authTag = Buffer.from(row.authTag, "base64");
      const ciphertext = Buffer.from(row.ciphertext, "base64");
      if (nonce.length !== GCM_NONCE_BYTES || authTag.length !== 16 || ciphertext.length === 0)
        throw new Error("invalid encrypted credential");
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(associatedData(tenantId, bindingKey));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Authentication and decoding failures must not reveal ciphertext or key material.
      throw new EnterpriseError("conflict");
    }
  }
}
