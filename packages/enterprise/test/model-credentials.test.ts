import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnterpriseStore } from "../src/store.js";

const encryptionKey = Buffer.alloc(32, 0x42);

async function temporaryStore(key: Uint8Array | undefined = encryptionKey) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-credentials-"));
  const dbPath = join(dir, "enterprise.db");
  const store = await EnterpriseStore.open(dbPath, join(dir, "workspaces"), {
    modelCredentialsEncryptionKey: key,
  });
  return { dir, dbPath, store };
}

async function temporaryStoreWithoutKey() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-model-no-key-"));
  const dbPath = join(dir, "enterprise.db");
  const store = await EnterpriseStore.open(dbPath, join(dir, "workspaces"));
  return { dir, dbPath, store };
}

test("model credentials are tenant-scoped and encrypted at rest", async () => {
  const { dir, dbPath, store } = await temporaryStore();
  try {
    const alpha = store.bootstrapAdmin("Alpha", "alpha-model@example.test", "hash-alpha");
    const beta = store.bootstrapAdmin("Beta", "beta-model@example.test", "hash-beta");
    const secret = "zai-live-secret-1234";

    const status = store.upsertModelCredential(alpha.user.id, alpha.tenant.id, "ZAI-API", secret);
    assert.equal(status.providerFamily, "zai-api");
    assert.equal(status.status, "configured");
    assert.equal(status.configured, true);
    assert.equal(status.lastFour, "1234");
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.deepEqual(store.listModelCredentialStatuses(alpha.user.id, alpha.tenant.id), [status]);
    assert.equal(store.getModelCredentialForGateway(alpha.tenant.id, "zai-api").apiKey, secret);

    assert.throws(
      () => store.upsertModelCredential(beta.user.id, alpha.tenant.id, "zai-api", "foreign-secret"),
      /not_found/,
    );
    assert.throws(
      () => store.listModelCredentialStatuses(beta.user.id, alpha.tenant.id),
      /not_found/,
    );

    store.close();
    const raw = new DatabaseSync(dbPath);
    const row = raw
      .prepare(
        "SELECT ciphertext,nonce,auth_tag,last_four FROM model_credentials WHERE tenant_id=? AND provider_family=?",
      )
      .get(alpha.tenant.id, "zai-api") as Record<string, unknown>;
    assert.equal(String(row.last_four), "1234");
    assert.notEqual(String(row.ciphertext), secret);
    assert.equal(String(row.ciphertext).includes(secret), false);
    assert.ok(String(row.nonce).length > 0);
    assert.ok(String(row.auth_tag).length > 0);
    raw.close();
  } finally {
    try {
      store.close();
    } catch {
      // The test closes the store before inspecting SQLite directly.
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotation replaces the gateway secret and revocation destroys it", async () => {
  const { dir, store } = await temporaryStore();
  try {
    const admin = store.bootstrapAdmin("Rotation", "rotation@example.test", "hash");
    const first = "bigmodel-key-1111";
    const second = "bigmodel-key-2222";
    store.upsertModelCredential(admin.user.id, admin.tenant.id, "bigmodel-api", first);
    const rotated = store.rotateModelCredential(
      admin.user.id,
      admin.tenant.id,
      "bigmodel-api",
      second,
    );
    assert.equal(rotated.lastFour, "2222");
    assert.equal(
      store.getModelCredentialForGateway(admin.tenant.id, "bigmodel-api").apiKey,
      second,
    );

    const revoked = store.revokeModelCredential(admin.user.id, admin.tenant.id, "bigmodel-api");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.configured, false);
    assert.equal(revoked.lastFour, null);
    assert.throws(
      () => store.getModelCredentialForGateway(admin.tenant.id, "bigmodel-api"),
      /not_found/,
    );

    // Reconfiguration is a fresh upsert; the revoked row keeps only audit/status metadata.
    store.upsertModelCredential(admin.user.id, admin.tenant.id, "bigmodel-api", "new-key-3333");
    assert.equal(
      store.getModelCredentialForGateway(admin.tenant.id, "bigmodel-api").apiKey,
      "new-key-3333",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing or malformed key configuration fails without echoing API keys", async () => {
  const previous = process.env.ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY;
  delete process.env.ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY;
  const { dir, store } = await temporaryStoreWithoutKey();
  const secret = "must-not-appear-in-error";
  try {
    const admin = store.bootstrapAdmin("No Key", "no-key@example.test", "hash");
    let failure: unknown;
    try {
      store.upsertModelCredential(admin.user.id, admin.tenant.id, "zai-api", secret);
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), /validation/);
    assert.equal(String(failure).includes(secret), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY;
    else process.env.ZCODE_ENTERPRISE_MODEL_CREDENTIALS_KEY = previous;
  }
});

test("wrong key, row rebinding and GCM tampering fail closed", async () => {
  const first = await temporaryStore();
  let tenantId = "";
  try {
    const admin = first.store.bootstrapAdmin("Cipher", "cipher@example.test", "hash");
    tenantId = admin.tenant.id;
    first.store.upsertModelCredential(admin.user.id, tenantId, "zai-api", "cipher-secret-9999");
  } finally {
    first.store.close();
  }

  const wrong = await EnterpriseStore.open(first.dbPath, join(first.dir, "workspaces"), {
    modelCredentialsEncryptionKey: Buffer.alloc(32, 0x24),
  });
  try {
    assert.throws(() => wrong.getModelCredentialForGateway(tenantId, "zai-api"), /conflict/);
  } finally {
    wrong.close();
  }

  const raw = new DatabaseSync(first.dbPath);
  raw
    .prepare("UPDATE model_credentials SET provider_family=? WHERE tenant_id=?")
    .run("bigmodel-api", tenantId);
  raw.close();
  const rebound = await EnterpriseStore.open(first.dbPath, join(first.dir, "workspaces"), {
    modelCredentialsEncryptionKey: encryptionKey,
  });
  try {
    assert.throws(() => rebound.getModelCredentialForGateway(tenantId, "bigmodel-api"), /conflict/);
  } finally {
    rebound.close();
  }

  const restored = new DatabaseSync(first.dbPath);
  restored
    .prepare("UPDATE model_credentials SET provider_family=? WHERE tenant_id=?")
    .run("zai-api", tenantId);
  restored.close();
  const tamper = new DatabaseSync(first.dbPath);
  tamper.prepare("UPDATE model_credentials SET auth_tag=? WHERE tenant_id=?").run("AA==", tenantId);
  tamper.close();
  const tampered = await EnterpriseStore.open(first.dbPath, join(first.dir, "workspaces"), {
    modelCredentialsEncryptionKey: encryptionKey,
  });
  try {
    assert.throws(() => tampered.getModelCredentialForGateway(tenantId, "zai-api"), /conflict/);
  } finally {
    tampered.close();
    await rm(first.dir, { recursive: true, force: true });
  }
});

test("schema version one upgrades the credential table transactionally", async () => {
  const initial = await temporaryStore();
  initial.store.close();
  const raw = new DatabaseSync(initial.dbPath);
  raw.exec("DROP TABLE model_credentials; PRAGMA user_version = 1;");
  raw.close();

  const migrated = await EnterpriseStore.open(initial.dbPath, join(initial.dir, "workspaces"), {
    modelCredentialsEncryptionKey: encryptionKey,
  });
  try {
    const check = new DatabaseSync(initial.dbPath);
    assert.equal(
      (check.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version,
      2,
    );
    assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name='model_credentials'").get());
    check.close();
  } finally {
    migrated.close();
    await rm(initial.dir, { recursive: true, force: true });
  }
});
