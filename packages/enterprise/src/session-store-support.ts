import { DatabaseSync } from "node:sqlite";
import {
  EnterpriseError,
  type Customer,
  type EnterpriseRuntimeTarget,
  type EnterpriseSession,
} from "./types.js";
import { EnterpriseStoreBase, type Row, now, id } from "./store-base.js";

type CustomerReader = (actorId: string, customerId: string) => Customer;
type CustomerTargetReader = (actorId: string, customerId: string) => EnterpriseRuntimeTarget;

export class SessionStoreSupport extends EnterpriseStoreBase {
  constructor(
    db: DatabaseSync,
    workspaceRoot: string,
    private readonly getCustomer: CustomerReader,
    private readonly getCustomerTarget: CustomerTargetReader,
  ) {
    super(db, workspaceRoot);
  }

  issueSession(userId: string, tokenHash: string, csrfHash: string): EnterpriseSession {
    const session = {
      id: id(),
      userId,
      activeCustomerId: null,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    this.run(
      "INSERT INTO sessions (id,user_id,token_hash,csrf_hash,expires_at,active_customer_id) VALUES(?,?,?,?,?,?)",
      session.id,
      userId,
      tokenHash,
      csrfHash,
      session.expiresAt,
      null,
    );
    return session;
  }

  private session(row: Row): EnterpriseSession {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      activeCustomerId: row.active_customer_id == null ? null : String(row.active_customer_id),
      expiresAt: String(row.expires_at),
    };
  }

  resolveSession(tokenHash: string): EnterpriseSession | null {
    // users.status(v9)在会话校验路径上硬性生效:被禁用的用户即使会话未到期、
    // socket 清扫尚未跑到,下一次校验(HTTP 请求 / ws 定时复核)也立即失效,
    // 不必等清理任务追上。用户行缺失同样拒绝(fail closed)。
    const row = this.one(
      `SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'`,
      tokenHash,
      now(),
    );
    if (!row) return null;
    if (row.active_customer_id) {
      const customer = this.one(
        "SELECT tenant_id FROM customers WHERE id=?",
        String(row.active_customer_id),
      );
      if (
        !customer ||
        !this.one(
          "SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=?",
          String(row.user_id),
          String(customer.tenant_id),
        )
      )
        return null;
    } else if (
      !this.one("SELECT 1 FROM memberships WHERE user_id=? LIMIT 1", String(row.user_id))
    ) {
      return null;
    }
    return this.session(row);
  }

  revokeSession(tokenHash: string): void {
    this.run("DELETE FROM sessions WHERE token_hash=?", tokenHash);
  }

  matchesCsrf(sessionId: string, csrfHash: string): boolean {
    return Boolean(
      this.one("SELECT 1 FROM sessions WHERE id=? AND csrf_hash=?", sessionId, csrfHash),
    );
  }

  activateCustomer(sessionId: string, customerId: string): EnterpriseSession {
    return this.transaction(() => {
      const row = this.one("SELECT * FROM sessions WHERE id=? AND expires_at>?", sessionId, now());
      if (!row) throw new EnterpriseError("forbidden");
      const customer = this.getCustomer(String(row.user_id), customerId);
      this.run("UPDATE sessions SET active_customer_id=? WHERE id=?", customer.id, sessionId);
      this.run("UPDATE customers SET last_used_at=? WHERE id=?", now(), customer.id);
      return { ...this.session(row), activeCustomerId: customer.id };
    });
  }

  getActiveCustomer(sessionId: string): Customer | null {
    const row = this.one("SELECT * FROM sessions WHERE id=? AND expires_at>?", sessionId, now());
    if (!row || !row.active_customer_id) return null;
    try {
      return this.getCustomer(String(row.user_id), String(row.active_customer_id));
    } catch {
      return null;
    }
  }

  getActiveRuntimeTarget(sessionId: string): EnterpriseRuntimeTarget | null {
    const row = this.one("SELECT * FROM sessions WHERE id=? AND expires_at>?", sessionId, now());
    if (!row) return null;
    if (row.active_customer_id) {
      try {
        return this.getCustomerTarget(String(row.user_id), String(row.active_customer_id));
      } catch {
        return null;
      }
    }
    return null;
  }
}
