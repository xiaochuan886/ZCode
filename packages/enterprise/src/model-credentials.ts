import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EnterpriseError, type Role } from "./types.js";

const MODEL_CREDENTIAL_KEY_ENV = "ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY";
const MODEL_CREDENTIAL_KEY_VERSION = 1;
const GCM_NONCE_BYTES = 12;
const AES_KEY_BYTES = 32;

export type ModelCredentialEncryptionKey = string | Uint8Array;
export const MODEL_PROVIDER_FAMILIES = ["zai-api", "bigmodel-api"] as const;
export type ModelProviderFamily = (typeof MODEL_PROVIDER_FAMILIES)[number];

export interface ModelCredentialStatus {
  tenantId: string;
  providerFamily: string;
  status: "configured" | "revoked";
  configured: boolean;
  lastFour: string | null;
  updatedAt: string;
}

/** The decrypted value is an internal gateway capability; never serialize it to a browser. */
export interface GatewayModelCredential {
  tenantId: string;
  providerFamily: string;
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
  keyVersion: number;
  ciphertext: string | null;
  nonce: string | null;
  authTag: string | null;
  lastFour: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

const invalidKey = (): never => {
  // Do not include the supplied value in this error. It can be a live secret.
  throw new EnterpriseError("validation");
};

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) invalidKey();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== AES_KEY_BYTES) invalidKey();
  return decoded;
}

function decodeHex(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) invalidKey();
  return Buffer.from(value, "hex");
}

/** Resolve a 32-byte key from an explicit constructor value or the operator environment. */
export function resolveModelCredentialKey(
  value: ModelCredentialEncryptionKey | undefined = process.env[MODEL_CREDENTIAL_KEY_ENV],
): Buffer {
  if (value == null || (typeof value === "string" && !value.trim())) invalidKey();
  if (typeof value !== "string") {
    const key = Buffer.from(value as Uint8Array);
    if (key.length !== AES_KEY_BYTES) invalidKey();
    return key;
  }

  const normalized = value.trim();
  if (normalized.startsWith("base64:")) return decodeBase64(normalized.slice("base64:".length));
  if (normalized.startsWith("hex:")) return decodeHex(normalized.slice("hex:".length));
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return decodeHex(normalized);
  return decodeBase64(normalized);
}

export function normalizeProviderFamily(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 128 ||
    normalized.includes("\0") ||
    !MODEL_PROVIDER_FAMILIES.includes(normalized as ModelProviderFamily)
  )
    throw new EnterpriseError("validation");
  return normalized;
}

export function keyLastFour(apiKey: string): string | null {
  const characters = [...apiKey];
  return characters.length >= 4 ? characters.slice(-4).join("") : null;
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

export function toModelCredentialStatus(row: EncryptedModelCredentialRow): ModelCredentialStatus {
  const configured =
    row.revokedAt == null && row.ciphertext != null && row.nonce != null && row.authTag != null;
  return {
    tenantId: row.tenantId,
    providerFamily: row.providerFamily,
    status: configured ? "configured" : "revoked",
    configured,
    lastFour: configured ? row.lastFour : null,
    updatedAt: row.updatedAt,
  };
}

type CredentialRow = Record<string, unknown>;
type CredentialTransaction = <T>(fn: () => T) => T;
type CredentialMembership = (actorId: string, tenantId: string, role?: Role) => unknown;

/** SQLite adapter for model credentials; EnterpriseStore remains the only owner of its instance. */
export class ModelCredentialStore {
  private modelCredentialCipher: ModelCredentialCipher | null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: CredentialTransaction,
    private readonly membership: CredentialMembership,
    encryptionKey?: ModelCredentialEncryptionKey,
  ) {
    this.modelCredentialCipher =
      encryptionKey === undefined ? null : new ModelCredentialCipher(encryptionKey);
  }

  private one(sql: string, ...values: (string | number | null)[]): CredentialRow | undefined {
    return this.db.prepare(sql).get(...values) as CredentialRow | undefined;
  }

  private all(sql: string, ...values: (string | number | null)[]): CredentialRow[] {
    return this.db.prepare(sql).all(...values) as CredentialRow[];
  }

  private run(sql: string, ...values: (string | number | null)[]): void {
    this.db.prepare(sql).run(...values);
  }

  private row(row: CredentialRow): EncryptedModelCredentialRow {
    return {
      tenantId: String(row.tenant_id),
      providerFamily: String(row.provider_family),
      keyVersion: Number(row.key_version),
      ciphertext: row.ciphertext == null ? null : String(row.ciphertext),
      nonce: row.nonce == null ? null : String(row.nonce),
      authTag: row.auth_tag == null ? null : String(row.auth_tag),
      lastFour: row.last_four == null ? null : String(row.last_four),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    };
  }

  private cipher(): ModelCredentialCipher {
    if (!this.modelCredentialCipher) this.modelCredentialCipher = new ModelCredentialCipher();
    return this.modelCredentialCipher;
  }

  private status(tenantId: string, providerFamily: string): ModelCredentialStatus {
    const row = this.one(
      "SELECT * FROM model_credentials WHERE tenant_id=? AND provider_family=?",
      tenantId,
      providerFamily,
    );
    if (!row) throw new EnterpriseError("not_found");
    return toModelCredentialStatus(this.row(row));
  }

  private write(
    actorId: string,
    tenantId: string,
    providerFamily: string,
    apiKey: string,
    requireExisting: boolean,
  ): ModelCredentialStatus {
    return this.transaction(() => {
      this.membership(actorId, tenantId, "admin");
      const normalizedProviderFamily = normalizeProviderFamily(providerFamily);
      if (!apiKey) throw new EnterpriseError("validation");
      const existing = this.one(
        "SELECT created_at FROM model_credentials WHERE tenant_id=? AND provider_family=?",
        tenantId,
        normalizedProviderFamily,
      );
      if (requireExisting && !existing) throw new EnterpriseError("not_found");
      const encrypted = this.cipher().encrypt(apiKey, tenantId, normalizedProviderFamily);
      const timestamp = new Date().toISOString();
      if (existing) {
        this.run(
          "UPDATE model_credentials SET key_version=?,ciphertext=?,nonce=?,auth_tag=?,last_four=?,updated_at=?,revoked_at=NULL WHERE tenant_id=? AND provider_family=?",
          encrypted.keyVersion,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          keyLastFour(apiKey),
          timestamp,
          tenantId,
          normalizedProviderFamily,
        );
      } else {
        this.run(
          "INSERT INTO model_credentials(tenant_id,provider_family,key_version,ciphertext,nonce,auth_tag,last_four,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)",
          tenantId,
          normalizedProviderFamily,
          encrypted.keyVersion,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          keyLastFour(apiKey),
          timestamp,
          timestamp,
        );
      }
      return this.status(tenantId, normalizedProviderFamily);
    });
  }

  upsertModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
    apiKey: string,
  ): ModelCredentialStatus {
    return this.write(actorId, tenantId, providerFamily, apiKey, false);
  }

  rotateModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
    apiKey: string,
  ): ModelCredentialStatus {
    return this.write(actorId, tenantId, providerFamily, apiKey, true);
  }

  revokeModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
  ): ModelCredentialStatus {
    return this.transaction(() => {
      this.membership(actorId, tenantId, "admin");
      const normalizedProviderFamily = normalizeProviderFamily(providerFamily);
      if (
        !this.one(
          "SELECT 1 FROM model_credentials WHERE tenant_id=? AND provider_family=?",
          tenantId,
          normalizedProviderFamily,
        )
      )
        throw new EnterpriseError("not_found");
      const timestamp = new Date().toISOString();
      this.run(
        "UPDATE model_credentials SET ciphertext=NULL,nonce=NULL,auth_tag=NULL,last_four=NULL,revoked_at=?,updated_at=? WHERE tenant_id=? AND provider_family=?",
        timestamp,
        timestamp,
        tenantId,
        normalizedProviderFamily,
      );
      return this.status(tenantId, normalizedProviderFamily);
    });
  }

  deleteModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
  ): ModelCredentialStatus {
    return this.revokeModelCredential(actorId, tenantId, providerFamily);
  }

  listModelCredentialStatuses(actorId: string, tenantId: string): ModelCredentialStatus[] {
    this.membership(actorId, tenantId);
    return this.all(
      "SELECT * FROM model_credentials WHERE tenant_id=? ORDER BY provider_family",
      tenantId,
    ).map((row) => toModelCredentialStatus(this.row(row)));
  }

  getModelCredentialForGateway(tenantId: string, providerFamily: string): GatewayModelCredential {
    const normalizedProviderFamily = normalizeProviderFamily(providerFamily);
    const row = this.one(
      "SELECT * FROM model_credentials WHERE tenant_id=? AND provider_family=?",
      tenantId,
      normalizedProviderFamily,
    );
    if (!row) throw new EnterpriseError("not_found");
    const credential = this.row(row);
    if (
      credential.revokedAt != null ||
      credential.ciphertext == null ||
      credential.nonce == null ||
      credential.authTag == null
    )
      throw new EnterpriseError("not_found");
    const apiKey = this.cipher().decrypt(
      {
        keyVersion: credential.keyVersion,
        ciphertext: credential.ciphertext,
        nonce: credential.nonce,
        authTag: credential.authTag,
      },
      tenantId,
      normalizedProviderFamily,
    );
    return { tenantId, providerFamily: normalizedProviderFamily, apiKey };
  }
}
