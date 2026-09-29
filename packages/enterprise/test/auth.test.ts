import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnterpriseStore } from "../src/store.js";
import { EnterpriseAuth } from "../src/auth.js";

test("passwords, revocable sessions, membership and same-origin mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-"));
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const hash = await EnterpriseAuth.hashPassword("secret-password");
    const { tenant, user } = store.bootstrapAdmin("Alpha", "a@example.test", hash);
    const auth = new EnterpriseAuth(store);
    await assert.rejects(auth.login("a@example.test", "wrong"), /invalid_credentials/);
    const issued = await auth.login("a@example.test", "secret-password");
    assert.equal(auth.resolveSession(issued.token)?.userId, user.id);
    auth.validateMutation(
      "https://example.test",
      "https://example.test",
      issued.csrfToken,
      issued.csrfToken,
    );
    assert.throws(
      () =>
        auth.validateMutation(
          "https://evil.test",
          "https://example.test",
          issued.csrfToken,
          issued.csrfToken,
        ),
      /forbidden/,
    );
    store.removeMembership(user.id, tenant.id, user.id);
    assert.equal(auth.resolveSession(issued.token), null);
    auth.revokeSession(issued.token);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
