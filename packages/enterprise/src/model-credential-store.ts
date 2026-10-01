import { DatabaseSync } from "node:sqlite";
import { EnterpriseError, type Role } from "./types.js";
import {
  keyLastFour,
  normalizeModelCredentialInput,
  normalizeProviderFamily,
  toModelCredentialStatus,
  ModelCredentialCipher,
  type EncryptedModelCredentialRow,
  type GatewayModelCredential,
  type ModelApiType,
  type ModelCredentialEncryptionKey,
  type ModelCredentialInput,
  type ModelCredentialStatus,
  type ModelProviderFamily,
  type NormalizedModelCredentialInput,
} from "./model-credential-format.js";

type CredentialRow = Record<string, unknown>;
type CredentialTransaction = <T>(fn: () => T) => T;
type CredentialMembership = (actorId: string, tenantId: string, role?: Role) => unknown;

/** SQLite adapter for tenant model credentials; EnterpriseStore remains the only owner of its instance. */
export class ModelCredentialStore {
  private modelCredentialCipher: ModelCredentialCipher | null;
  private metadataColumnsReady = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: CredentialTransaction,
    private readonly membership: CredentialMembership,
    encryptionKey?: ModelCredentialEncryptionKey,
  ) {
    this.modelCredentialCipher =
      encryptionKey === undefined ? null : new ModelCredentialCipher(encryptionKey);
  }

  static validateInput(input: ModelCredentialInput): NormalizedModelCredentialInput {
    return normalizeModelCredentialInput(input);
  }

  /** Add metadata columns lazily so this module can upgrade existing v2 credential tables. */
  private ensureMetadataColumns(): void {
    if (this.metadataColumnsReady) return;
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(model_credentials)").all() as CredentialRow[]).map(
        (row) => String(row.name),
      ),
    );
    if (!columns.size) return;
    const additions: ReadonlyArray<[string, string]> = [
      ["provider_name", "TEXT"],
      ["api_type", "TEXT"],
      ["base_url", "TEXT"],
      ["model_id", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE model_credentials ADD COLUMN ${name} ${definition}`);
      }
    }
    this.metadataColumnsReady = true;
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
      providerName: row.provider_name == null ? null : String(row.provider_name),
      apiType: row.api_type == null ? null : String(row.api_type),
      baseUrl: row.base_url == null ? null : String(row.base_url),
      modelId: row.model_id == null ? null : String(row.model_id),
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

  private status(tenantId: string, providerFamily: ModelProviderFamily): ModelCredentialStatus {
    this.ensureMetadataColumns();
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
    input: ModelCredentialInput,
    requireExisting: boolean,
  ): ModelCredentialStatus {
    return this.transaction(() => {
      this.ensureMetadataColumns();
      this.membership(actorId, tenantId, "admin");
      const normalized = normalizeModelCredentialInput(input);
      const existing = this.one(
        "SELECT created_at FROM model_credentials WHERE tenant_id=? AND provider_family=?",
        tenantId,
        normalized.providerFamily,
      );
      if (requireExisting && !existing) throw new EnterpriseError("not_found");
      const encrypted = this.cipher().encrypt(
        normalized.apiKey,
        tenantId,
        normalized.providerFamily,
      );
      const timestamp = new Date().toISOString();
      if (existing) {
        this.run(
          "UPDATE model_credentials SET key_version=?,ciphertext=?,nonce=?,auth_tag=?,last_four=?,provider_name=?,api_type=?,base_url=?,model_id=?,updated_at=?,revoked_at=NULL WHERE tenant_id=? AND provider_family=?",
          encrypted.keyVersion,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          keyLastFour(normalized.apiKey),
          normalized.providerName,
          normalized.apiType,
          normalized.baseUrl,
          normalized.modelId,
          timestamp,
          tenantId,
          normalized.providerFamily,
        );
      } else {
        this.run(
          "INSERT INTO model_credentials(tenant_id,provider_family,key_version,ciphertext,nonce,auth_tag,last_four,created_at,updated_at,revoked_at,provider_name,api_type,base_url,model_id) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)",
          tenantId,
          normalized.providerFamily,
          encrypted.keyVersion,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          keyLastFour(normalized.apiKey),
          timestamp,
          timestamp,
          normalized.providerName,
          normalized.apiType,
          normalized.baseUrl,
          normalized.modelId,
        );
      }
      return this.status(tenantId, normalized.providerFamily);
    });
  }

  upsertModelCredential(
    actorId: string,
    tenantId: string,
    input: ModelCredentialInput,
  ): ModelCredentialStatus {
    return this.write(actorId, tenantId, input, false);
  }

  rotateModelCredential(
    actorId: string,
    tenantId: string,
    input: ModelCredentialInput,
  ): ModelCredentialStatus {
    return this.write(actorId, tenantId, input, true);
  }

  revokeModelCredential(
    actorId: string,
    tenantId: string,
    providerFamily: string,
  ): ModelCredentialStatus {
    return this.transaction(() => {
      this.ensureMetadataColumns();
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
    this.ensureMetadataColumns();
    this.membership(actorId, tenantId);
    // 仅 custom 是合法的 provider family；历史固定 provider 行已由 schema v4 清除，
    // 过滤保留为对异常写入的兜底。
    return this.all(
      "SELECT * FROM model_credentials WHERE tenant_id=? AND provider_family='custom' ORDER BY provider_family",
      tenantId,
    ).map((row) => toModelCredentialStatus(this.row(row)));
  }

  getModelCredentialForGateway(tenantId: string, providerFamily: string): GatewayModelCredential {
    this.ensureMetadataColumns();
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
      credential.authTag == null ||
      credential.providerName == null ||
      credential.apiType == null ||
      credential.baseUrl == null ||
      credential.modelId == null
    )
      throw new EnterpriseError("not_found");
    const input = normalizeModelCredentialInput({
      providerFamily: "custom",
      providerName: credential.providerName,
      apiType: credential.apiType as ModelApiType,
      baseUrl: credential.baseUrl,
      modelId: credential.modelId,
      apiKey: "placeholder",
    });
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
    return { tenantId, ...input, apiKey };
  }
}
