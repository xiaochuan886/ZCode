import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnterpriseError } from "../src/types.js";
import { ModelCredentialStore, type ModelCredentialInput } from "../src/model-credentials.js";
import { EnterpriseStore } from "../src/store.js";

const encryptionKey = Buffer.alloc(32, 0x42);

function credential(
  apiKey: string,
  overrides: Partial<ModelCredentialInput> = {},
): ModelCredentialInput {
  return {
    providerFamily: "custom",
    providerName: "Test provider",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.example.com/v1",
    modelId: "test-model",
    apiKey,
    ...overrides,
  };
}

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
    const secret = "custom-live-secret-1234";

    const status = store.upsertModelCredential(alpha.user.id, alpha.tenant.id, credential(secret));
    assert.equal(status.providerFamily, "custom");
    assert.equal(status.status, "configured");
    assert.equal(status.configured, true);
    assert.equal(status.lastFour, "1234");
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.deepEqual(store.listModelCredentialStatuses(alpha.user.id, alpha.tenant.id), [status]);
    assert.equal(store.getModelCredentialForGateway(alpha.tenant.id, "custom").apiKey, secret);

    assert.throws(
      () =>
        store.upsertModelCredential(beta.user.id, alpha.tenant.id, credential("foreign-secret")),
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
      .get(alpha.tenant.id, "custom") as Record<string, unknown>;
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
    const first = "custom-key-1111";
    const second = "custom-key-2222";
    store.upsertModelCredential(admin.user.id, admin.tenant.id, credential(first));
    const rotated = store.rotateModelCredential(admin.user.id, admin.tenant.id, credential(second));
    assert.equal(rotated.lastFour, "2222");
    assert.equal(store.getModelCredentialForGateway(admin.tenant.id, "custom").apiKey, second);

    const revoked = store.revokeModelCredential(admin.user.id, admin.tenant.id, "custom");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.configured, false);
    assert.equal(revoked.lastFour, null);
    assert.throws(() => store.getModelCredentialForGateway(admin.tenant.id, "custom"), /not_found/);

    // Reconfiguration is a fresh upsert; the revoked row keeps only audit/status metadata.
    store.upsertModelCredential(admin.user.id, admin.tenant.id, credential("new-key-3333"));
    assert.equal(
      store.getModelCredentialForGateway(admin.tenant.id, "custom").apiKey,
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
      store.upsertModelCredential(admin.user.id, admin.tenant.id, credential(secret));
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
    first.store.upsertModelCredential(admin.user.id, tenantId, credential("cipher-secret-9999"));
  } finally {
    first.store.close();
  }

  const wrong = await EnterpriseStore.open(first.dbPath, join(first.dir, "workspaces"), {
    modelCredentialsEncryptionKey: Buffer.alloc(32, 0x24),
  });
  try {
    assert.throws(() => wrong.getModelCredentialForGateway(tenantId, "custom"), /conflict/);
  } finally {
    wrong.close();
  }

  const raw = new DatabaseSync(first.dbPath);
  raw.close();
  const tamper = new DatabaseSync(first.dbPath);
  tamper.prepare("UPDATE model_credentials SET auth_tag=? WHERE tenant_id=?").run("AA==", tenantId);
  tamper.close();
  const tampered = await EnterpriseStore.open(first.dbPath, join(first.dir, "workspaces"), {
    modelCredentialsEncryptionKey: encryptionKey,
  });
  try {
    assert.throws(() => tampered.getModelCredentialForGateway(tenantId, "custom"), /conflict/);
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

test("fixed-provider rows never surface through the custom credential API", async () => {
  const initial = await temporaryStore();
  const admin = initial.store.bootstrapAdmin("Legacy", "legacy@example.test", "hash");
  const timestamp = new Date().toISOString();
  initial.store.close();
  const raw = new DatabaseSync(initial.dbPath);
  raw
    .prepare(
      `INSERT INTO model_credentials
        (tenant_id,provider_family,key_version,ciphertext,nonce,auth_tag,last_four,created_at,updated_at,revoked_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(admin.tenant.id, "zai-api", 1, null, null, null, null, timestamp, timestamp, timestamp);
  raw.close();

  const reopened = await EnterpriseStore.open(initial.dbPath, join(initial.dir, "workspaces"), {
    modelCredentialsEncryptionKey: encryptionKey,
  });
  try {
    assert.deepEqual(reopened.listModelCredentialStatuses(admin.user.id, admin.tenant.id), []);
    assert.throws(
      () => reopened.getModelCredentialForGateway(admin.tenant.id, "zai-api"),
      /validation/,
    );
  } finally {
    reopened.close();
    await rm(initial.dir, { recursive: true, force: true });
  }
});

test("custom provider stores API metadata with an encrypted key and returns status without the key", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE model_credentials (
      tenant_id TEXT NOT NULL,
      provider_family TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      ciphertext TEXT,
      nonce TEXT,
      auth_tag TEXT,
      last_four TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (tenant_id, provider_family)
    );
  `);
  const members = new Map([
    ["admin", "admin"],
    ["member", "member"],
  ]);
  const store = new ModelCredentialStore(
    db,
    <T>(fn: () => T) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    (actorId, tenantId, role) => {
      if (tenantId !== "tenant-a" || !members.has(actorId)) throw new EnterpriseError("not_found");
      if (role === "admin" && members.get(actorId) !== "admin")
        throw new EnterpriseError("forbidden");
    },
    encryptionKey,
  );
  const input: ModelCredentialInput = {
    providerFamily: "custom",
    providerName: "Acme AI",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.example.com/v1",
    modelId: "acme-model",
    apiKey: "custom-secret-1234",
  };
  try {
    const status = store.upsertModelCredential("admin", "tenant-a", input);
    assert.equal(status.providerFamily, "custom");
    assert.equal(status.providerName, "Acme AI");
    assert.equal(status.apiType, "openai-chat-completions");
    assert.equal(status.baseUrl, "https://api.example.com/v1");
    assert.equal(status.modelId, "acme-model");
    assert.equal(status.lastFour, "1234");
    assert.equal(JSON.stringify(status).includes(input.apiKey), false);
    assert.deepEqual(store.getModelCredentialForGateway("tenant-a", "custom"), {
      tenantId: "tenant-a",
      providerFamily: "custom",
      providerName: "Acme AI",
      apiType: "openai-chat-completions",
      baseUrl: "https://api.example.com/v1",
      modelId: "acme-model",
      apiKey: input.apiKey,
    });
    assert.throws(() => store.upsertModelCredential("member", "tenant-a", input), /forbidden/);
    assert.throws(() => store.getModelCredentialForGateway("tenant-b", "custom"), /not_found/);
    const row = db
      .prepare(
        "SELECT ciphertext,nonce,auth_tag,last_four,api_type,base_url,model_id FROM model_credentials",
      )
      .get() as Record<string, unknown>;
    assert.equal(row.last_four, "1234");
    assert.equal(String(row.ciphertext).includes(input.apiKey), false);
    assert.equal(row.api_type, "openai-chat-completions");
    assert.equal(row.base_url, "https://api.example.com/v1");
    assert.equal(row.model_id, "acme-model");
  } finally {
    db.close();
  }
});

test("custom provider rejects insecure or private upstream URLs", () => {
  assert.throws(
    () =>
      ModelCredentialStore.validateInput({
        providerFamily: "custom",
        apiType: "anthropic-messages",
        baseUrl: "http://127.0.0.1:8080",
        modelId: "model",
        apiKey: "secret",
      }),
    /validation/,
  );
  assert.throws(
    () =>
      ModelCredentialStore.validateInput({
        providerFamily: "custom",
        apiType: "openai-chat-completions",
        baseUrl: "https://localhost/v1",
        modelId: "model",
        apiKey: "secret",
      }),
    /validation/,
  );
});
