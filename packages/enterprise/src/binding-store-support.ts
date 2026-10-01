import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type Customer,
  type McpBinding,
  type SharedSkill,
  type TenantSkill,
} from "./types.js";
import { EnterpriseStoreBase, now, id } from "./store-base.js";

type CustomerReader = (actorId: string, customerId: string) => Customer;

export class BindingStoreSupport extends EnterpriseStoreBase {
  constructor(
    db: DatabaseSync,
    workspaceRoot: string,
    private readonly getCustomer: CustomerReader,
  ) {
    super(db, workspaceRoot);
  }

  listSkillsForCustomer(actorId: string, customerId: string): SharedSkill[] {
    const customer = this.getCustomer(actorId, customerId);
    return this.all(
      `SELECT id,tenant_id,customer_id,name,content,content_hash,created_at
         FROM customer_skills WHERE tenant_id=? AND customer_id=? ORDER BY created_at,id`,
      customer.tenantId,
      customer.id,
    ).map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      sourceCustomerId: String(row.customer_id),
      name: String(row.name),
      content: String(row.content),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
    }));
  }

  createCustomerSkill(
    actorId: string,
    customerId: string,
    input: { name: string; content: string },
  ): SharedSkill {
    const customer = this.getCustomer(actorId, customerId);
    if (!input.name.trim() || !input.content) throw new EnterpriseError("validation");
    const skill = {
      id: id(),
      tenantId: customer.tenantId,
      sourceCustomerId: customer.id,
      name: input.name.trim(),
      content: input.content,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      createdAt: now(),
    } satisfies SharedSkill;
    this.run(
      `INSERT INTO customer_skills
         (id,tenant_id,customer_id,name,content,content_hash,created_at)
       VALUES(?,?,?,?,?,?,?)`,
      skill.id,
      skill.tenantId,
      skill.sourceCustomerId,
      skill.name,
      skill.content,
      skill.contentHash,
      skill.createdAt,
    );
    return skill;
  }

  listTenantSkills(actorId: string, tenantId: string): TenantSkill[] {
    this.membership(actorId, tenantId);
    return this.all(
      `SELECT id,tenant_id,name,content,content_hash,created_at
         FROM tenant_skills WHERE tenant_id=? ORDER BY created_at,id`,
      tenantId,
    ).map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      content: String(row.content),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
    }));
  }

  createTenantSkill(
    actorId: string,
    tenantId: string,
    input: { name: string; content: string },
  ): TenantSkill {
    this.membership(actorId, tenantId, "admin");
    if (!input.name.trim() || !input.content) throw new EnterpriseError("validation");
    const skill = {
      id: id(),
      tenantId,
      name: input.name.trim(),
      content: input.content,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      createdAt: now(),
    } satisfies TenantSkill;
    this.run(
      `INSERT INTO tenant_skills (id,tenant_id,name,content,content_hash,created_at)
       VALUES(?,?,?,?,?,?)`,
      skill.id,
      skill.tenantId,
      skill.name,
      skill.content,
      skill.contentHash,
      skill.createdAt,
    );
    return skill;
  }

  deleteTenantSkill(actorId: string, tenantId: string, skillId: string): void {
    this.membership(actorId, tenantId, "admin");
    const existing = this.all(
      "SELECT id FROM tenant_skills WHERE tenant_id=? AND id=?",
      tenantId,
      skillId,
    );
    if (existing.length === 0) throw new EnterpriseError("not_found");
    this.run("DELETE FROM tenant_skills WHERE tenant_id=? AND id=?", tenantId, skillId);
  }

  /** 租户级共享 Skill 分发到该租户全部客户 runtime；与客户自己的 Skill 取并集。 */
  tenantSkillsForDistribution(tenantId: string): TenantSkill[] {
    return this.all(
      `SELECT id,tenant_id,name,content,content_hash,created_at
         FROM tenant_skills WHERE tenant_id=? ORDER BY created_at,id`,
      tenantId,
    ).map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      content: String(row.content),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
    }));
  }

  private binding(row: Record<string, unknown>): McpBinding {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      customerId: String(row.customer_id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      secretRef: row.secret_ref == null ? null : String(row.secret_ref),
      token: String(row.token ?? ""),
      createdAt: String(row.created_at),
    };
  }

  /** 确保绑定持有稳定令牌(空串=旧数据),返回可用于物化的令牌。 */
  ensureMcpBindingToken(bindingId: string): string {
    const row = this.one("SELECT id,token FROM customer_mcp_bindings WHERE id=?", bindingId);
    if (!row) throw new EnterpriseError("not_found");
    const current = row.token == null ? "" : String(row.token);
    if (current) return current;
    const token = randomBytes(32).toString("base64url");
    this.run("UPDATE customer_mcp_bindings SET token=? WHERE id=?", token, bindingId);
    return token;
  }

  /** 中继请求鉴权:按 (客户, 绑定) 取行并做常数时间令牌比较。 */
  findMcpBindingForRelay(customerId: string, bindingId: string, token: string): McpBinding | null {
    const row = this.one(
      `SELECT id,tenant_id,customer_id,name,endpoint,secret_ref,token,created_at
         FROM customer_mcp_bindings WHERE customer_id=? AND id=?`,
      customerId,
      bindingId,
    );
    if (!row) return null;
    const binding = this.binding(row);
    if (!binding.token) return null;
    const expected = Buffer.from(binding.token);
    const presented = Buffer.from(token);
    return expected.length === presented.length && timingSafeEqual(expected, presented)
      ? binding
      : null;
  }

  listMcpBindingsForCustomer(actorId: string, customerId: string): McpBinding[] {
    const customer = this.getCustomer(actorId, customerId);
    return this.all(
      `SELECT id,tenant_id,customer_id,name,endpoint,secret_ref,token,created_at
         FROM customer_mcp_bindings WHERE tenant_id=? AND customer_id=? ORDER BY created_at,id`,
      customer.tenantId,
      customer.id,
    ).map((row) => this.binding(row));
  }

  createCustomerMcpBinding(
    actorId: string,
    customerId: string,
    input: { name: string; endpoint: string; secretRef?: string | null },
  ): McpBinding {
    const customer = this.getCustomer(actorId, customerId);
    if (!input.name.trim() || !input.endpoint.trim()) throw new EnterpriseError("validation");
    const binding = {
      id: id(),
      tenantId: customer.tenantId,
      customerId: customer.id,
      name: input.name.trim(),
      endpoint: input.endpoint.trim(),
      secretRef: input.secretRef ?? null,
      token: randomBytes(32).toString("base64url"),
      createdAt: now(),
    } satisfies McpBinding;
    this.run(
      `INSERT INTO customer_mcp_bindings
         (id,tenant_id,customer_id,name,endpoint,secret_ref,token,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      binding.id,
      binding.tenantId,
      binding.customerId,
      binding.name,
      binding.endpoint,
      binding.secretRef,
      binding.token,
      binding.createdAt,
    );
    return binding;
  }
}
