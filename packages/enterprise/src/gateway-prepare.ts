import { randomBytes } from "node:crypto";
import type { EnterpriseStore } from "./store.js";
import type { EnterpriseCase } from "./types.js";
import { prepareCaseWorkspace } from "./materialize.js";
import type { RelayCredential } from "./mcp-relay.js";
import { isTenantMcpEndpointAllowed, isTenantMcpSecretRef } from "./mcp-policy.js";
import {
  enterpriseModelProviders,
  provisionCaseModelProviders,
  type EnterpriseModelProvider,
  type ModelRelayCapability,
} from "./model-provision.js";

export async function prepare(
  value: EnterpriseCase,
  store: EnterpriseStore,
  userId: string,
  relayOrigin: string,
  relayCredentials: Map<string, Map<string, RelayCredential>>,
  modelRuntimeDataRoot: string | undefined,
  modelRelayCapabilities: Map<string, Map<EnterpriseModelProvider, ModelRelayCapability>>,
): Promise<void> {
  const skills = store.listSkillsForCase(userId, value.id);
  const bindings = store.listMcpBindingsForCase(userId, value.id);
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const caseCredentials = new Map<string, RelayCredential>();
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
    caseCredentials.set(binding.id, { token, actorId: userId });
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
  await prepareCaseWorkspace({
    workspacePath: value.workspacePath,
    caseContext: {
      caseId: value.id,
      title: value.title,
      category: value.category,
      serviceObject: value.objectSnapshot,
      contextSnapshot: value.contextSnapshot,
    },
    sharedSkills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      content: skill.content,
      sha256: skill.contentHash,
    })),
    mcpServers,
  });
  if (modelRuntimeDataRoot) {
    const configured = new Set(
      store
        .listModelCredentialStatuses(userId, value.tenantId)
        .filter((credential) => credential.configured)
        .map((credential) => credential.providerFamily),
    );
    const capabilities = await provisionCaseModelProviders({
      caseId: value.id,
      actorId: userId,
      relayOrigin,
      runtimeDataRoot: modelRuntimeDataRoot,
      configuredProviders: enterpriseModelProviders.filter((provider) => configured.has(provider)),
    });
    modelRelayCapabilities.set(value.id, capabilities);
  }
  relayCredentials.set(value.id, caseCredentials);
}
