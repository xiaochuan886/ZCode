import { mkdir, lstat, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EnterpriseError, type Customer, type EnterpriseRuntimeTarget } from "./types.js";
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

  getCustomerRuntimeTarget(actorId: string, customerId: string): EnterpriseRuntimeTarget {
    const customer = this.customerRow(actorId, customerId);
    return {
      id: customer.id,
      tenantId: customer.tenantId,
      customerId: customer.id,
      workspacePath: customer.workspacePath,
      runtimeId: customer.id,
      kind: "customer",
    };
  }
}
