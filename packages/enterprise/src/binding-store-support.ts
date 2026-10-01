import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EnterpriseError, type Customer, type McpBinding, type SharedSkill } from "./types.js";
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

  listMcpBindingsForCustomer(actorId: string, customerId: string): McpBinding[] {
    const customer = this.getCustomer(actorId, customerId);
    return this.all(
      `SELECT id,tenant_id,customer_id,name,endpoint,secret_ref,created_at
         FROM customer_mcp_bindings WHERE tenant_id=? AND customer_id=? ORDER BY created_at,id`,
      customer.tenantId,
      customer.id,
    ).map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      customerId: String(row.customer_id),
      name: String(row.name),
      endpoint: String(row.endpoint),
      secretRef: row.secret_ref == null ? null : String(row.secret_ref),
      createdAt: String(row.created_at),
    }));
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
      createdAt: now(),
    } satisfies McpBinding;
    this.run(
      `INSERT INTO customer_mcp_bindings
         (id,tenant_id,customer_id,name,endpoint,secret_ref,created_at)
       VALUES(?,?,?,?,?,?,?)`,
      binding.id,
      binding.tenantId,
      binding.customerId,
      binding.name,
      binding.endpoint,
      binding.secretRef,
      binding.createdAt,
    );
    return binding;
  }
}
