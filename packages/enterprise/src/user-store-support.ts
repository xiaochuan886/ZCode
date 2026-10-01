import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type CustomerAccess,
  type CustomerAccessMode,
  type Role,
  type TenantUserChange,
  type TenantUserSummary,
  type UserStatus,
} from "./types.js";
import { EnterpriseStoreBase, fail, id, type Row } from "./store-base.js";

/**
 * 租户成员管理与客户可见性的唯一所有者。用户是全局身份,这里只管理
 * (tenant, user) 成员关系、users.status 与 customer_access_grants;
 * 路由层(网关)负责停止 runtime / 销毁 socket 等副作用,store 保持纯写。
 */
export class UserStoreSupport extends EnterpriseStoreBase {
  constructor(db: DatabaseSync, workspaceRoot: string) {
    super(db, workspaceRoot);
  }

  private grantsByUser(tenantId: string): Map<string, string[]> {
    const grants = new Map<string, string[]>();
    for (const row of this.all(
      "SELECT user_id, customer_id FROM customer_access_grants WHERE tenant_id=? ORDER BY customer_id",
      tenantId,
    )) {
      const userId = String(row.user_id);
      const list = grants.get(userId) ?? [];
      list.push(String(row.customer_id));
      grants.set(userId, list);
    }
    return grants;
  }

  private tenantUser(tenantId: string, row: Row, grantedIds?: string[]): TenantUserSummary {
    const grants =
      grantedIds ??
      this.all(
        "SELECT customer_id FROM customer_access_grants WHERE tenant_id=? AND user_id=? ORDER BY customer_id",
        tenantId,
        String(row.user_id),
      ).map((grant) => String(grant.customer_id));
    return {
      id: String(row.user_id),
      email: String(row.email),
      displayName: String(row.display_name),
      role: String(row.role) as Role,
      status: row.status == null ? "active" : (String(row.status) as UserStatus),
      createdAt: String(row.created_at),
      customerAccess: grants.length
        ? { mode: "selected", customerIds: grants }
        : { mode: "all", customerIds: [] },
    };
  }

  private memberRow(tenantId: string, userId: string): Row {
    const row = this.one(
      `SELECT u.id AS user_id,u.email,u.display_name,u.created_at,u.status,m.role
         FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=? AND m.user_id=?`,
      tenantId,
      userId,
    );
    if (!row) throw new EnterpriseError("not_found");
    return row;
  }

  /** 除本成员外,还有几个 active 管理员;0 = 目标是最后一个可用管理员。 */
  private otherActiveAdmins(tenantId: string, userId: string): number {
    return Number(
      this.one(
        `SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id=m.user_id
          WHERE m.tenant_id=? AND m.role='admin' AND m.user_id<>? AND u.status='active'`,
        tenantId,
        userId,
      )?.n ?? 0,
    );
  }

  listTenantUsers(actorId: string, tenantId: string): TenantUserSummary[] {
    this.membership(actorId, tenantId, "admin");
    const grants = this.grantsByUser(tenantId);
    return this.all(
      `SELECT u.id AS user_id,u.email,u.display_name,u.created_at,u.status,m.role
         FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=? ORDER BY u.created_at, u.email COLLATE NOCASE`,
      tenantId,
    ).map((row) => this.tenantUser(tenantId, row, grants.get(String(row.user_id)) ?? []));
  }

  getTenantUser(actorId: string, tenantId: string, userId: string): TenantUserSummary {
    this.membership(actorId, tenantId, "admin");
    return this.tenantUser(tenantId, this.memberRow(tenantId, userId));
  }

  /**
   * 按邮箱创建或加入:邮箱已有全局身份时只补成员关系(密码忽略,身份沿用自有
   * 凭据);全新邮箱必须有初始密码。已是本租户成员 → conflict。
   */
  createOrJoinTenantUser(
    actorId: string,
    tenantId: string,
    input: { email: string; passwordHash?: string; role: Role; displayName?: string },
  ): TenantUserChange {
    this.membership(actorId, tenantId, "admin");
    if (input.role !== "admin" && input.role !== "member") fail("validation");
    const existing = this.findCredential(input.email);
    if (existing) {
      if (
        this.one(
          "SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=?",
          tenantId,
          existing.user.id,
        )
      )
        fail("conflict");
      this.run("INSERT INTO memberships VALUES(?,?,?)", tenantId, existing.user.id, input.role);
      return {
        ...this.tenantUser(tenantId, this.memberRow(tenantId, existing.user.id)),
        joined: true,
      };
    }
    if (!input.passwordHash) fail("validation");
    return this.transaction(() => {
      const user = this.createUser(input.email, input.passwordHash!, input.displayName);
      this.run("INSERT INTO memberships VALUES(?,?,?)", tenantId, user.id, input.role);
      return { ...this.tenantUser(tenantId, this.memberRow(tenantId, user.id)), joined: false };
    });
  }

  /**
   * 编辑成员(displayName / role / 管理员重置密码 / status)。守卫(409):
   * 不能降级或禁用自己;不能降级或禁用租户最后一个可用管理员。副作用
   * (停 runtime、销毁 socket)由路由层按返回投影的变更决定。
   */
  updateTenantUser(
    actorId: string,
    tenantId: string,
    userId: string,
    patch: { displayName?: string; role?: Role; passwordHash?: string; status?: UserStatus },
  ): TenantUserSummary {
    this.membership(actorId, tenantId, "admin");
    const current = this.tenantUser(tenantId, this.memberRow(tenantId, userId));
    if (patch.status !== undefined && patch.status !== "active" && patch.status !== "disabled")
      fail("validation");
    const displayName = patch.displayName === undefined ? undefined : patch.displayName.trim();
    if (displayName === "") fail("validation");
    if (patch.passwordHash !== undefined && !patch.passwordHash) fail("validation");
    const newRole = patch.role ?? current.role;
    const newStatus = patch.status ?? current.status;
    const demotes = current.role === "admin" && newRole !== "admin";
    const disables = current.status === "active" && newStatus === "disabled";
    if (demotes || disables) {
      // 自我锁定防护与最后管理员防护:都按 conflict 拒绝,防止租户失去可用管理员。
      if (userId === actorId) fail("conflict");
      if (this.otherActiveAdmins(tenantId, userId) === 0) fail("conflict");
    }
    this.transaction(() => {
      if (displayName !== undefined)
        this.run("UPDATE users SET display_name=? WHERE id=?", displayName, userId);
      if (patch.passwordHash !== undefined)
        this.run("UPDATE users SET password_hash=? WHERE id=?", patch.passwordHash, userId);
      if (newStatus !== current.status)
        this.run("UPDATE users SET status=? WHERE id=?", newStatus, userId);
      if (newRole !== current.role)
        this.run(
          "UPDATE memberships SET role=? WHERE tenant_id=? AND user_id=?",
          newRole,
          tenantId,
          userId,
        );
    });
    return this.tenantUser(tenantId, this.memberRow(tenantId, userId));
  }

  /**
   * 移出租户:只删成员关系(全局用户行保留,可能属于其他租户),并清理本租户
   * 授权与 active_customer 绑定。守卫同 updateTenantUser(自身与最后管理员)。
   */
  removeTenantUser(actorId: string, tenantId: string, userId: string): void {
    this.membership(actorId, tenantId, "admin");
    const current = this.tenantUser(tenantId, this.memberRow(tenantId, userId));
    if (userId === actorId) fail("conflict");
    if (
      current.role === "admin" &&
      current.status === "active" &&
      this.otherActiveAdmins(tenantId, userId) === 0
    )
      fail("conflict");
    this.transaction(() => {
      this.run(
        "DELETE FROM customer_access_grants WHERE tenant_id=? AND user_id=?",
        tenantId,
        userId,
      );
      this.run(
        `UPDATE sessions SET active_customer_id=NULL
          WHERE user_id=? AND active_customer_id IN (SELECT id FROM customers WHERE tenant_id=?)`,
        userId,
        tenantId,
      );
      this.run("DELETE FROM memberships WHERE tenant_id=? AND user_id=?", tenantId, userId);
    });
  }

  /** 设置客户可见性:selected 必须非空且全部属于本租户客户;all 清空授权。 */
  setUserCustomerAccess(
    actorId: string,
    tenantId: string,
    userId: string,
    input: { mode: CustomerAccessMode; customerIds?: string[] },
  ): CustomerAccess {
    this.membership(actorId, tenantId, "admin");
    this.memberRow(tenantId, userId);
    if (input.mode !== "all" && input.mode !== "selected") fail("validation");
    if (input.mode === "all") {
      this.run(
        "DELETE FROM customer_access_grants WHERE tenant_id=? AND user_id=?",
        tenantId,
        userId,
      );
      return { mode: "all", customerIds: [] };
    }
    const requested = [...new Set(input.customerIds ?? [])].sort();
    if (requested.length === 0) fail("validation");
    const placeholders = requested.map(() => "?").join(",");
    const known = this.all(
      `SELECT id FROM customers WHERE tenant_id=? AND id IN (${placeholders})`,
      tenantId,
      ...requested,
    );
    if (known.length !== requested.length) fail("validation");
    this.transaction(() => {
      this.run(
        "DELETE FROM customer_access_grants WHERE tenant_id=? AND user_id=?",
        tenantId,
        userId,
      );
      for (const customerId of requested) {
        this.run(
          "INSERT INTO customer_access_grants (id,tenant_id,user_id,customer_id) VALUES(?,?,?,?)",
          id(),
          tenantId,
          userId,
          customerId,
        );
      }
    });
    return { mode: "selected", customerIds: requested };
  }

  /** 读取某用户在本租户的可见性;不做角色特判(管理员由调用方决定)。 */
  customerAccessForUser(userId: string, tenantId: string): CustomerAccess {
    const customerIds = this.all(
      "SELECT customer_id FROM customer_access_grants WHERE tenant_id=? AND user_id=? ORDER BY customer_id",
      tenantId,
      userId,
    ).map((grant) => String(grant.customer_id));
    return customerIds.length
      ? { mode: "selected", customerIds }
      : { mode: "all", customerIds: [] };
  }

  /**
   * 该成员在本租户可见(可挂载)的客户 id 列表,顺序与 listCustomers 一致:
   * 管理员恒为全部;成员无授权行 = 全部,有授权行 = 恰好授权的客户。
   */
  visibleCustomerIdsFor(userId: string, tenantId: string): string[] {
    const membership = this.membership(userId, tenantId);
    const access = this.customerAccessForUser(userId, tenantId);
    const allIds = this.all(
      `SELECT id FROM customers WHERE tenant_id=?
          ORDER BY (last_used_at IS NULL), last_used_at DESC, name COLLATE NOCASE, created_at, id`,
      tenantId,
    ).map((row) => String(row.id));
    if (membership.role === "admin" || access.mode === "all") return allIds;
    const granted = new Set(access.customerIds);
    return allIds.filter((customerId) => granted.has(customerId));
  }
}
