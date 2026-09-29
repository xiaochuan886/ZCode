import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnterpriseStore } from "../src/store.js";

test("tenant boundaries, immutable snapshots and case transitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-enterprise-"));
  const store = await EnterpriseStore.open(join(dir, "enterprise.db"), join(dir, "workspaces"));
  try {
    const a = store.bootstrapAdmin("Alpha", "a@example.test", "hash-a");
    const b = store.bootstrapAdmin("Beta", "b@example.test", "hash-b");
    const space = store.createServiceSpace(a.user.id, a.tenant.id, { name: "Support" });
    const provisioned = store.provisionUser(a.user.id, a.tenant.id, {
      email: "member@example.test",
      passwordHash: "hash-member",
      role: "member",
    });
    assert.equal(provisioned.membership.tenantId, a.tenant.id);
    assert.throws(
      () =>
        store.provisionUser(a.user.id, a.tenant.id, {
          email: "member@example.test",
          passwordHash: "another-hash",
          role: "member",
        }),
      /conflict/,
    );
    assert.throws(
      () =>
        store.provisionUser(b.user.id, a.tenant.id, {
          email: "leak@example.test",
          passwordHash: "hash",
          role: "member",
        }),
      /not_found/,
    );
    assert.equal(store.findCredential("leak@example.test"), null);
    assert.throws(
      () => store.updateServiceSpace(b.user.id, space.id, { name: "Foreign" }),
      /not_found/,
    );
    assert.throws(
      () => store.updateServiceSpace(provisioned.user.id, space.id, { name: "Member" }),
      /forbidden/,
    );
    assert.equal(
      store.updateServiceSpace(a.user.id, space.id, { name: "Customer Support" }).name,
      "Customer Support",
    );
    const object = store.createServiceObject(a.user.id, space.id, {
      name: "Server",
      type: "machine",
      metadata: { serial: "one" },
    });
    const record = store.createCase(a.user.id, object.id, {
      title: "Issue",
      category: "incident",
      contextSnapshot: { incident: "disk" },
    });
    store.updateServiceObject(a.user.id, object.id, {
      name: "Renamed",
      type: "machine",
      metadata: { serial: "two" },
    });
    assert.equal(store.getCase(a.user.id, record.id).objectSnapshot.name, "Server");
    assert.equal(store.getCase(a.user.id, record.id).category, "incident");
    assert.equal(store.getCase(a.user.id, record.id).contextSnapshot.incident, "disk");
    const skill = store.createSkill(a.user.id, record.id, { name: "repair", content: "# Repair" });
    assert.equal(skill.contentHash.length, 64);
    assert.equal(store.listSkillsForCase(a.user.id, record.id).length, 1);
    assert.throws(() => store.listSkillsForCase(b.user.id, record.id), /not_found/);
    assert.throws(() => store.getCase(b.user.id, record.id), /not_found/);
    assert.throws(() => store.createCase(b.user.id, object.id, { title: "Leak" }), /not_found/);
    assert.throws(() => store.transitionCase(a.user.id, record.id, "closed"), /invalid_transition/);
    assert.equal(store.transitionCase(a.user.id, record.id, "in_progress").status, "in_progress");
    assert.equal(store.transitionCase(a.user.id, record.id, "resolved").status, "resolved");
    assert.equal(store.transitionCase(a.user.id, record.id, "closed").status, "closed");
    assert.equal(store.transitionCase(a.user.id, record.id, "in_progress").status, "in_progress");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
