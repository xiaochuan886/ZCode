import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type TenantModelProvider,
  type TenantModelProviderDistribution,
} from "./types.js";
import { EnterpriseStoreBase, id, now, type Row } from "./store-base.js";
import {
  keyLastFour,
  ModelCredentialCipher,
  normalizeModelApiType,
  normalizeModelBaseUrl,
  type ModelApiType,
  type ModelCredentialEncryptionKey,
} from "./model-credential-format.js";
import {
  decodeEnvelope,
  decodeStoredModels,
  invalid,
  type ProviderKeyEnvelope,
  type ProviderRow,
  resolveModels,
  type TenantModelProviderInput,
  type TenantModelProviderPatch,
  validateApiKey,
  validateDefaultModel,
  validateDisplayName,
  validateModels,
  validateProviderKey,
} from "./provider-format.js";

/** SQLite adapter for the tenant model provider catalog; EnterpriseStore owns its instance. */
export class ProviderStoreSupport extends EnterpriseStoreBase {
  private cipherInstance: ModelCredentialCipher | null;

  constructor(db: DatabaseSync, encryptionKey?: ModelCredentialEncryptionKey) {
    super(db, "");
    this.cipherInstance =
      encryptionKey === undefined ? null : new ModelCredentialCipher(encryptionKey);
  }

  private cipher(): ModelCredentialCipher {
    if (!this.cipherInstance) this.cipherInstance = new ModelCredentialCipher();
    return this.cipherInstance;
  }

  private row(row: Row): ProviderRow {
    // v10 起 models 列存富条目对象数组;v9 及之前的字符串数组由迁移原位转换,
    // 这里只接受新形状,损坏行 fail closed(conflict)。
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      providerKey: String(row.provider_key),
      displayName: String(row.display_name),
      apiType: String(row.api_type) as ModelApiType,
      baseUrl: String(row.base_url),
      envelope: decodeEnvelope(String(row.api_key_encrypted)),
      models: decodeStoredModels(String(row.models)),
      defaultModel: String(row.default_model ?? ""),
      isDefault: Number(row.is_default) === 1,
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
    };
  }

  private projection(row: ProviderRow): TenantModelProvider {
    return {
      id: row.id,
      tenantId: row.tenantId,
      providerKey: row.providerKey,
      displayName: row.displayName,
      apiType: row.apiType,
      baseUrl: row.baseUrl,
      models: row.models,
      defaultModel: row.defaultModel,
      isDefault: row.isDefault,
      enabled: row.enabled,
      apiKeyLast4: row.envelope.lastFour,
    };
  }

  private byId(providerId: string): ProviderRow {
    const row = this.one("SELECT * FROM tenant_model_providers WHERE id=?", providerId);
    if (!row) throw new EnterpriseError("not_found");
    return this.row(row);
  }

  private decrypted(row: ProviderRow): TenantModelProviderDistribution {
    return {
      ...this.projection(row),
      apiKey: this.cipher().decrypt(row.envelope, row.tenantId, row.providerKey),
    };
  }

  listTenantModelProviders(actorId: string, tenantId: string): TenantModelProvider[] {
    this.membership(actorId, tenantId);
    // 目录按创建顺序展示:created_at 毫秒级精度,同毫秒插入时用随机 id 平局会让
    // 列表顺序抖动,因此改用 rowid(插入顺序)作为确定性排序键。
    return this.all(
      "SELECT * FROM tenant_model_providers WHERE tenant_id=? ORDER BY rowid",
      tenantId,
    ).map((row) => this.projection(this.row(row)));
  }

  /**
   * 工作台模型就绪信号:成员可读,只返回租户是否存在启用供应商。
   * 供应商目录列表是管理员专属,工作台门控因此改走这个不泄露目录细节的端点。
   */
  tenantModelReady(actorId: string, tenantId: string): boolean {
    this.membership(actorId, tenantId);
    return (
      this.one(
        "SELECT 1 FROM tenant_model_providers WHERE tenant_id=? AND enabled=1 LIMIT 1",
        tenantId,
      ) !== undefined
    );
  }

  getTenantModelProvider(actorId: string, providerId: string): TenantModelProvider {
    const row = this.byId(providerId);
    this.membership(actorId, row.tenantId);
    return this.projection(row);
  }

  createTenantModelProvider(
    actorId: string,
    tenantId: string,
    input: TenantModelProviderInput,
  ): TenantModelProvider {
    const providerKey = validateProviderKey(input.providerKey);
    const displayName = validateDisplayName(input.displayName);
    const apiType = normalizeModelApiType(input.apiType);
    const baseUrl = normalizeModelBaseUrl(input.baseUrl);
    const apiKey = validateApiKey(input.apiKey);
    const models = validateModels(input.models);
    const resolved = resolveModels(models, validateDefaultModel(input.defaultModel));
    const enabled = input.enabled ?? true;
    return this.transaction(() => {
      this.membership(actorId, tenantId, "admin");
      if (
        this.one(
          "SELECT id FROM tenant_model_providers WHERE tenant_id=? AND provider_key=?",
          tenantId,
          providerKey,
        )
      )
        throw new EnterpriseError("conflict");
      // 首个供应商自动成为租户默认;之后的行只有显式 isDefault 才切默认。
      const isFirst = !this.one(
        "SELECT id FROM tenant_model_providers WHERE tenant_id=? LIMIT 1",
        tenantId,
      );
      const isDefault = isFirst ? true : input.isDefault === true;
      if (isDefault)
        this.run("UPDATE tenant_model_providers SET is_default=0 WHERE tenant_id=?", tenantId);
      const providerId = id();
      const envelope: ProviderKeyEnvelope = {
        ...this.cipher().encrypt(apiKey, tenantId, providerKey),
        lastFour: keyLastFour(apiKey),
      };
      this.run(
        `INSERT INTO tenant_model_providers
           (id,tenant_id,provider_key,display_name,api_type,base_url,api_key_encrypted,models,default_model,is_default,enabled,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        providerId,
        tenantId,
        providerKey,
        displayName,
        apiType,
        baseUrl,
        JSON.stringify(envelope),
        JSON.stringify(resolved.models),
        resolved.defaultModel,
        isDefault ? 1 : 0,
        enabled ? 1 : 0,
        now(),
      );
      return this.projection(this.byId(providerId));
    });
  }

  updateTenantModelProvider(
    actorId: string,
    providerId: string,
    patch: TenantModelProviderPatch,
  ): TenantModelProvider {
    if (patch.providerKey !== undefined) invalid();
    return this.transaction(() => {
      const current = this.byId(providerId);
      this.membership(actorId, current.tenantId, "admin");
      const displayName =
        patch.displayName === undefined
          ? current.displayName
          : validateDisplayName(patch.displayName);
      const apiType =
        patch.apiType === undefined ? current.apiType : normalizeModelApiType(patch.apiType);
      const baseUrl =
        patch.baseUrl === undefined ? current.baseUrl : normalizeModelBaseUrl(patch.baseUrl);
      const models = patch.models === undefined ? current.models : validateModels(patch.models);
      const defaultModel =
        patch.defaultModel === undefined
          ? current.defaultModel
          : validateDefaultModel(patch.defaultModel);
      const resolved = resolveModels(models, defaultModel);
      const enabled = patch.enabled === undefined ? current.enabled : patch.enabled === true;
      // API key 未变化时原样保留密文,避免无谓的解密/重加密。
      const envelope =
        patch.apiKey === undefined
          ? current.envelope
          : {
              ...this.cipher().encrypt(
                validateApiKey(patch.apiKey),
                current.tenantId,
                current.providerKey,
              ),
              lastFour: keyLastFour(patch.apiKey),
            };
      const isDefault =
        patch.isDefault === undefined ? current.isDefault : patch.isDefault === true;
      if (patch.isDefault === true)
        this.run(
          "UPDATE tenant_model_providers SET is_default=0 WHERE tenant_id=? AND id<>?",
          current.tenantId,
          providerId,
        );
      this.run(
        `UPDATE tenant_model_providers
           SET display_name=?,api_type=?,base_url=?,api_key_encrypted=?,models=?,default_model=?,is_default=?,enabled=?
         WHERE id=?`,
        displayName,
        apiType,
        baseUrl,
        JSON.stringify(envelope),
        JSON.stringify(resolved.models),
        resolved.defaultModel,
        isDefault ? 1 : 0,
        enabled ? 1 : 0,
        providerId,
      );
      return this.projection(this.byId(providerId));
    });
  }

  deleteTenantModelProvider(actorId: string, providerId: string): void {
    this.transaction(() => {
      const current = this.byId(providerId);
      this.membership(actorId, current.tenantId, "admin");
      this.run("DELETE FROM tenant_model_providers WHERE id=?", providerId);
      if (current.isDefault) {
        // 删除默认供应商后把最早的启用行提升为默认,保持"恰好一个默认"的稳定语义。
        this.run(
          `UPDATE tenant_model_providers
              SET is_default=1
            WHERE tenant_id=? AND enabled=1 AND id=(
              SELECT id FROM tenant_model_providers WHERE tenant_id=? AND enabled=1 ORDER BY rowid LIMIT 1
            )`,
          current.tenantId,
          current.tenantId,
        );
      }
    });
  }

  /** 分发集合:仅启用行,默认行排最前;解密后的 key 只在网关内部流转。 */
  tenantModelProvidersForDistribution(tenantId: string): TenantModelProviderDistribution[] {
    return this.all(
      "SELECT * FROM tenant_model_providers WHERE tenant_id=? AND enabled=1 ORDER BY is_default DESC,rowid",
      tenantId,
    ).map((row) => this.decrypted(this.row(row)));
  }

  /** 连接测试用解密行:管理员门禁,绝不序列化给浏览器。 */
  tenantModelProviderForConnectionTest(
    actorId: string,
    providerId: string,
  ): TenantModelProviderDistribution {
    const row = this.byId(providerId);
    this.membership(actorId, row.tenantId, "admin");
    return this.decrypted(row);
  }

  /**
   * v7 迁移 seeding:legacy 单凭据(只可能有 custom family)转为一条目录行。
   * 在迁移事务内执行——解密失败(密钥缺失/不匹配)会让迁移整体回滚,operator
   * 修正 ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY 后重试即可;seed 成功后 legacy
   * 行不再参与分发。
   */
  seedFromLegacyCredentials(db: DatabaseSync = this.db): void {
    const tenants = db.prepare("SELECT id FROM tenants").all() as Row[];
    const insert = db.prepare(
      `INSERT INTO tenant_model_providers
         (id,tenant_id,provider_key,display_name,api_type,base_url,api_key_encrypted,models,default_model,is_default,enabled,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const tenant of tenants) {
      const tenantId = String(tenant.id);
      const legacy = db
        .prepare(
          `SELECT provider_name,api_type,base_url,model_id,key_version,ciphertext,nonce,auth_tag,revoked_at
             FROM model_credentials WHERE tenant_id=? AND provider_family='custom'`,
        )
        .get(tenantId) as Row | undefined;
      if (
        !legacy ||
        legacy.revoked_at != null ||
        legacy.ciphertext == null ||
        legacy.nonce == null ||
        legacy.auth_tag == null ||
        legacy.api_type == null ||
        legacy.base_url == null ||
        legacy.model_id == null
      )
        continue;
      if (
        db.prepare("SELECT 1 FROM tenant_model_providers WHERE tenant_id=? LIMIT 1").get(tenantId)
      )
        continue;
      const apiKey = this.cipher().decrypt(
        {
          keyVersion: Number(legacy.key_version),
          ciphertext: String(legacy.ciphertext),
          nonce: String(legacy.nonce),
          authTag: String(legacy.auth_tag),
        },
        tenantId,
        "custom",
      );
      const modelId = String(legacy.model_id);
      const providerKey = "custom";
      const envelope: ProviderKeyEnvelope = {
        ...this.cipher().encrypt(apiKey, tenantId, providerKey),
        lastFour: keyLastFour(apiKey),
      };
      insert.run(
        id(),
        tenantId,
        providerKey,
        legacy.provider_name == null ? "Custom provider" : String(legacy.provider_name),
        normalizeModelApiType(String(legacy.api_type)),
        normalizeModelBaseUrl(String(legacy.base_url)),
        JSON.stringify(envelope),
        // v10 起直接以富条目形状 seed;v6→v10 一次迁移时即使走到 v10 转换,
        // 对象数组行也按幂等规则原样保留。
        JSON.stringify([{ id: modelId }]),
        modelId,
        1,
        1,
        now(),
      );
    }
  }
}
