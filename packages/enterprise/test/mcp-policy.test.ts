import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTenantMcpEndpointAllowed,
  isTenantMcpSecretRef,
  resolvePublicMcpAddress,
} from "../src/mcp-policy.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const secretA = "ZCODE_ENTERPRISE_MCP_SECRET_11111111111141118111111111111111_KNOWLEDGE";

test("MCP secret references are bound to one tenant", () => {
  assert.equal(isTenantMcpSecretRef(secretA, tenantA), true);
  assert.equal(isTenantMcpSecretRef(secretA, tenantB), false);
  assert.equal(isTenantMcpSecretRef("ZCODE_ENTERPRISE_MCP_SECRET_GLOBAL", tenantA), false);
});

test("MCP endpoints require a tenant allowlist and safe HTTPS names", () => {
  const allowlist = JSON.stringify({ [tenantA]: ["https://knowledge.example.test/mcp"] });
  assert.equal(
    isTenantMcpEndpointAllowed(tenantA, "https://knowledge.example.test/mcp", allowlist),
    true,
  );
  assert.equal(
    isTenantMcpEndpointAllowed(tenantB, "https://knowledge.example.test/mcp", allowlist),
    false,
  );
  for (const endpoint of [
    "https://knowledge.example.test/mcp/other",
    "https://user@knowledge.example.test/mcp",
    "http://knowledge.example.test/mcp",
    "https://127.0.0.1/mcp",
    "https://localhost/mcp",
  ]) {
    assert.equal(isTenantMcpEndpointAllowed(tenantA, endpoint, allowlist), false, endpoint);
  }
  assert.equal(
    isTenantMcpEndpointAllowed(tenantA, "https://knowledge.example.test/mcp", "{"),
    false,
  );
});

test("MCP DNS denies mixed public and private answers", async () => {
  await assert.rejects(
    resolvePublicMcpAddress("knowledge.example.test", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /non-public/,
  );
  await assert.rejects(
    resolvePublicMcpAddress("knowledge.example.test", async () => [
      { address: "169.254.169.254", family: 4 },
    ]),
    /non-public/,
  );
  assert.deepEqual(
    await resolvePublicMcpAddress("knowledge.example.test", async () => [
      { address: "1.1.1.1", family: 4 },
    ]),
    { address: "1.1.1.1", family: 4 },
  );
});
