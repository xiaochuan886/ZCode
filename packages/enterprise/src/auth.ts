import { randomBytes, scrypt as callbackScrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { EnterpriseError, type EnterpriseSession } from "./types.js";
import type { EnterpriseStore } from "./store.js";
const scrypt = promisify(callbackScrypt);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class EnterpriseAuth {
  constructor(private readonly store: EnterpriseStore) {}
  static async hashPassword(password: string): Promise<string> {
    if (password.length < 8) throw new EnterpriseError("validation");
    const salt = randomBytes(16).toString("hex");
    const hash = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt:${salt}:${hash.toString("hex")}`;
  }
  static async verifyPassword(password: string, encoded: string): Promise<boolean> {
    const [kind, salt, hex] = encoded.split(":");
    if (kind !== "scrypt" || !salt || !hex || hex.length !== 128) return false;
    const expected = Buffer.from(hex, "hex");
    const actual = (await scrypt(password, salt, 64)) as Buffer;
    return timingSafeEqual(expected, actual);
  }
  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; csrfToken: string; session: EnterpriseSession }> {
    const credential = this.store.findCredential(email);
    if (
      !credential ||
      // 禁用用户与错误密码走同一个 invalid_credentials 路径,不泄露具体失败原因。
      credential.user.status === "disabled" ||
      !(await EnterpriseAuth.verifyPassword(password, credential.passwordHash)) ||
      this.store.listTenantsForUser(credential.user.id).length === 0
    )
      throw new EnterpriseError("invalid_credentials");
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    return {
      token,
      csrfToken,
      session: this.store.issueSession(credential.user.id, digest(token), digest(csrfToken)),
    };
  }
  resolveSession(token: string): EnterpriseSession | null {
    return this.store.resolveSession(digest(token));
  }
  revokeSession(token: string): void {
    this.store.revokeSession(digest(token));
  }
  validateMutation(
    origin: string | null,
    expectedOrigin: string,
    csrfHeader: string | null,
    csrfToken: string,
  ): void {
    if (!origin || origin !== expectedOrigin || !csrfHeader || csrfHeader !== csrfToken)
      throw new EnterpriseError("forbidden");
  }
  validateSessionMutation(
    token: string,
    origin: string | null,
    expectedOrigin: string,
    csrfHeader: string | null,
  ): EnterpriseSession {
    const session = this.resolveSession(token);
    if (
      !session ||
      !origin ||
      origin !== expectedOrigin ||
      !csrfHeader ||
      !this.store.matchesCsrf(session.id, digest(csrfHeader))
    )
      throw new EnterpriseError("forbidden");
    return session;
  }
}
