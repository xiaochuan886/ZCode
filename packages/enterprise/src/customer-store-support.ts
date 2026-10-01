import { mkdir, lstat, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  expertRuntimeId,
  type Customer,
  type EnterpriseRuntimeTarget,
} from "./types.js";
import { EnterpriseStoreBase, type Row, now, id, json } from "./store-base.js";

export class CustomerStoreSupport extends EnterpriseStoreBase {
  constructor(db: DatabaseSync, workspaceRoot: string) {
    super(db, workspaceRoot);
  }

  private async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Enterprise workspace is not a real directory: ${path}`);
    }
  }

  private customer(row: Row): Customer {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      type: String(row.type),
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      workspacePath: String(row.workspace_path),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
    };
  }

  private customerRow(actorId: string, customerId: string): Customer {
    const row = this.one("SELECT * FROM customers WHERE id=?", customerId);
    if (!row) throw new EnterpriseError("not_found");
    this.membership(actorId, String(row.tenant_id));
    return this.customer(row);
  }

  getCustomer(actorId: string, customerId: string): Customer {
    return this.customerRow(actorId, customerId);
  }

  listCustomers(actorId: string, tenantId: string): Customer[] {
    this.membership(actorId, tenantId);
    return this.all(
      `SELECT * FROM customers WHERE tenant_id=?
       ORDER BY (last_used_at IS NULL), last_used_at DESC, name COLLATE NOCASE, created_at, id`,
      tenantId,
    ).map((row) => this.customer(row));
  }

  async createCustomer(
    actorId: string,
    tenantId: string,
    input: { name: string; type?: string; metadata?: Record<string, unknown> },
  ): Promise<Customer> {
    this.membership(actorId, tenantId);
    const name = input.name.trim();
    const type = input.type?.trim() ?? "";
    if (!name) throw new EnterpriseError("validation");
    if (this.one("SELECT id FROM customers WHERE tenant_id=? AND name=?", tenantId, name))
      throw new EnterpriseError("conflict");
    const customerId = id();
    const workspacePath = join(this.workspaceRoot, "customers", customerId);
    const createdAt = now();
    const record = {
      id: customerId,
      tenantId,
      name,
      type,
      metadata: input.metadata ?? {},
      workspacePath,
      createdAt,
      updatedAt: createdAt,
      lastUsedAt: null,
    } satisfies Customer;
    await this.ensureDirectory(workspacePath);
    try {
      this.transaction(() =>
        this.run(
          "INSERT INTO customers VALUES(?,?,?,?,?,?,?,?,?)",
          record.id,
          record.tenantId,
          record.name,
          record.type,
          json(record.metadata),
          record.workspacePath,
          record.createdAt,
          record.updatedAt,
          null,
        ),
      );
      return record;
    } catch (error) {
      // 只清理本次创建且仍为空的目录；非空 orphan 必须保留给管理员恢复。
      await rmdir(workspacePath).catch(() => undefined);
      throw error;
    }
  }

  updateCustomer(
    actorId: string,
    customerId: string,
    input: { name: string; type?: string; metadata?: Record<string, unknown> },
  ): Customer {
    const current = this.customerRow(actorId, customerId);
    if (this.getMembership(actorId, current.tenantId).role !== "admin")
      throw new EnterpriseError("forbidden");
    const name = input.name.trim();
    const type = input.type?.trim() ?? "";
    if (!name) throw new EnterpriseError("validation");
    if (
      this.one(
        "SELECT id FROM customers WHERE tenant_id=? AND name=? AND id<>?",
        current.tenantId,
        name,
        customerId,
      )
    )
      throw new EnterpriseError("conflict");
    this.run(
      "UPDATE customers SET name=?,type=?,metadata=?,updated_at=? WHERE id=?",
      name,
      type,
      json(input.metadata ?? current.metadata),
      now(),
      customerId,
    );
    return this.customerRow(actorId, customerId);
  }

  /** 管理员删除客户:行级联删除 Skill/绑定与令牌,返回工作区路径供网关清理目录。 */
  deleteCustomer(actorId: string, customerId: string): { workspacePath: string } {
    const customer = this.customerRow(actorId, customerId);
    this.transaction(() => {
      this.run(
        "UPDATE sessions SET active_customer_id=NULL WHERE active_customer_id=?",
        customer.id,
      );
      this.run("DELETE FROM customers WHERE id=?", customer.id);
    });
    return { workspacePath: customer.workspacePath };
  }

  /**
   * 客户物化时重写最小 AGENTS.md。企业层管理此文件；用户对生成文件的编辑
   * 会在下一次物化被覆盖（产品文案中已声明）。
   */
  async writeCustomerAgentsFile(customer: Customer): Promise<void> {
    const content = `# ${customer.name}

此工作区由企业网关管理（租户客户：${customer.name}${customer.type ? `，类型：${customer.type}` : ""}）。
会话、任务与文件由 ZCode 原生界面负责；本文件由企业管理面在客户变更时重写。
`;
    await this.ensureDirectory(customer.workspacePath);
    await writeFile(join(customer.workspacePath, "AGENTS.md"), content, {
      encoding: "utf8",
      mode: 0o644,
    });
  }

  getCustomerRuntimeTarget(actorId: string, customerId: string): EnterpriseRuntimeTarget {
    const customer = this.customerRow(actorId, customerId);
    // runtime 属于专家(用户×租户),不属于客户;客户只是其中挂载的一个工作区。
    return {
      id: expertRuntimeId(actorId, customer.tenantId),
      tenantId: customer.tenantId,
      userId: actorId,
      workspacePath: customer.workspacePath,
      runtimeId: expertRuntimeId(actorId, customer.tenantId),
      kind: "expert",
    };
  }

  /** 租户下全部成员的专家 runtime 目标;用于凭据/Skill/客户变更时停止受影响 runtime。 */
  expertRuntimeTargetsForTenant(actorId: string, tenantId: string): EnterpriseRuntimeTarget[] {
    this.membership(actorId, tenantId);
    return this.all(
      "SELECT user_id FROM memberships WHERE tenant_id=? ORDER BY user_id",
      tenantId,
    ).map((row) => {
      const userId = String(row.user_id);
      const firstCustomer = this.one(
        "SELECT workspace_path FROM customers WHERE tenant_id=? ORDER BY created_at,id LIMIT 1",
        tenantId,
      );
      return {
        id: expertRuntimeId(userId, tenantId),
        tenantId,
        userId,
        workspacePath: firstCustomer ? String(firstCustomer.workspace_path) : "",
        runtimeId: expertRuntimeId(userId, tenantId),
        kind: "expert",
      } satisfies EnterpriseRuntimeTarget;
    });
  }
}
