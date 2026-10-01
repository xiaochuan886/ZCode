import { randomBytes } from "node:crypto";
import type { EnterpriseStore } from "./store.js";
import type { Customer } from "./types.js";
import { EnterpriseError } from "./types.js";
import { prepareCustomerWorkspace } from "./materialize.js";
import type { RelayCredential } from "./mcp-relay.js";
import { isTenantMcpEndpointAllowed, isTenantMcpSecretRef } from "./mcp-policy.js";
import { provisionCustomerModelProvider } from "./model-provision.js";
import type { GatewayModelCredential } from "./model-credentials.js";

function tenantModelCredential(
  store: EnterpriseStore,
  tenantId: string,
): GatewayModelCredential | null {
  try {
    return store.getModelCredentialForGateway(tenantId, "custom");
  } catch (error) {
    if (error instanceof EnterpriseError && error.code === "not_found") return null;
    throw error;
  }
}

/** Prepare the stable Customer workspace without replacing its native context files. */
export async function prepareCustomer(
  value: Customer,
  store: EnterpriseStore,
  userId: string,
  relayOrigin: string,
  relayCredentials: Map<string, Map<string, RelayCredential>>,
  modelRuntimeDataRoot: string | undefined,
): Promise<void> {
  const skills = store.listSkillsForCustomer(userId, value.id);
  const bindings = store.listMcpBindingsForCustomer(userId, value.id);
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const customerCredentials = new Map<string, RelayCredential>();
  for (const binding of bindings) {
    if (binding.tenantId !== value.tenantId) {
      process.emitWarning(`MCP binding ${binding.id} skipped: tenant binding is invalid.`, {
        code: "ZCODE_ENTERPRISE_MCP_TENANT_INVALID",
      });
      continue;
    }
    if (!isTenantMcpEndpointAllowed(value.tenantId, binding.endpoint)) {
      process.emitWarning(`MCP binding ${binding.id} skipped: endpoint is not allowlisted.`, {
        code: "ZCODE_ENTERPRISE_MCP_ENDPOINT_DENIED",
      });
      continue;
    }
    let secret: string | undefined;
    if (binding.secretRef) {
      if (!isTenantMcpSecretRef(binding.secretRef, value.tenantId)) {
        process.emitWarning(`MCP binding ${binding.id} skipped: secret reference is invalid.`, {
          code: "ZCODE_ENTERPRISE_MCP_SECRET_INVALID",
        });
        continue;
      }
      secret = process.env[binding.secretRef];
      if (!secret) {
        process.emitWarning(
          `MCP binding ${binding.id} skipped: configured secret is unavailable.`,
          { code: "ZCODE_ENTERPRISE_MCP_SECRET_MISSING" },
        );
        continue;
      }
    }
    const token = randomBytes(32).toString("base64url");
    customerCredentials.set(binding.id, { token, actorId: userId });
    const relayUrl = new URL(
      `/api/enterprise/mcp-relay/${encodeURIComponent(value.id)}/${encodeURIComponent(binding.id)}`,
      relayOrigin,
    );
    mcpServers[binding.name] = {
      type: "http",
      url: relayUrl.toString(),
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  await prepareCustomerWorkspace({
    workspacePath: value.workspacePath,
    sharedSkills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      content: skill.content,
      sha256: skill.contentHash,
    })),
    mcpServers,
  });
  if (modelRuntimeDataRoot) {
    await provisionCustomerModelProvider({
      customerId: value.id,
      tenantId: value.tenantId,
      runtimeDataRoot: modelRuntimeDataRoot,
      credential: tenantModelCredential(store, value.tenantId),
    });
  }
  relayCredentials.set(value.id, customerCredentials);
}
