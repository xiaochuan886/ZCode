import type { EnterpriseStore } from "./store.js";
import type { EnterpriseRuntimeTarget, Customer, TenantMcpConnectorDistribution } from "./types.js";
import { prepareCustomerWorkspace } from "./materialize.js";
import { isTenantMcpEndpointAllowed, isTenantMcpSecretRef } from "./mcp-policy.js";
import { provisionExpertModelProviders } from "./model-provision.js";
import { seedBaselineSkills } from "./skill-seed.js";

/**
 * 专家 runtime 准备:把租户模型供应商目录分发到专家数据卷的托管 provider 槽位,
 * 把租户共享 Skill 与系统连接器物化到专家 HOME。客户工作区的内容不在这里处理
 * ——它们在客户 CRUD 时已经物化完成。
 */
export async function prepareExpertRuntime(params: {
  target: EnterpriseRuntimeTarget;
  store: EnterpriseStore;
  runtimeDataRoot: string | undefined;
  relayOrigin: string;
}): Promise<void> {
  const { target, store, runtimeDataRoot, relayOrigin } = params;
  if (!runtimeDataRoot) return;
  const tenantSkills = store.tenantSkillsForDistribution(target.tenantId);
  const mcpServers = tenantConnectorServers(store, target.tenantId, relayOrigin);
  // 专家 HOME 就是物化目标:manifest 落在数据根的 .enterprise-managed 下,
  // 连接器与共享 Skill 走同一套 managed-names 合并,专家个人条目保持原样。
  await prepareCustomerWorkspace({
    workspacePath: `${runtimeDataRoot}/${target.runtimeId}`,
    sharedSkills: tenantSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      content: skill.content,
      sha256: skill.contentHash,
    })),
    mcpServers,
  });
  // 基线 Skill(如官方 skill-creator)种子到 HOME `.agents/skills/`:容器里没有
  // 插件商店,不种子则专家完全无法使用这些官方 Skill 创建工具。
  await seedBaselineSkills(`${runtimeDataRoot}/${target.runtimeId}`);
  await provisionExpertModelProviders({
    runtimeOwner: target.runtimeId,
    tenantId: target.tenantId,
    runtimeDataRoot,
    providers: store.tenantModelProvidersForDistribution(target.tenantId),
  });
}

/**
 * 启用的系统连接器 → 专家 HOME 的 `mcp.servers` 托管条目:URL 指向网关中继
 * `/api/enterprise/mcp-relay/t/<connectorId>`,令牌按客户绑定的同一方式呈现;
 * 上游 secret 只留在网关环境,由中继在转发时注入。
 */
function tenantConnectorServers(
  store: EnterpriseStore,
  tenantId: string,
  relayOrigin: string,
): Record<string, Record<string, unknown>> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const connector of store.tenantMcpConnectorsForDistribution(tenantId)) {
    if (!includeConnector(connector, tenantId)) continue;
    const token = store.ensureMcpConnectorToken(connector.id);
    const relayUrl = new URL(
      `/api/enterprise/mcp-relay/t/${encodeURIComponent(connector.id)}`,
      relayOrigin,
    );
    mcpServers[connector.connectorKey] = {
      type: "http",
      url: relayUrl.toString(),
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  return mcpServers;
}

function includeConnector(connector: TenantMcpConnectorDistribution, tenantId: string): boolean {
  if (!isTenantMcpEndpointAllowed(tenantId, connector.url)) {
    process.emitWarning(`MCP connector ${connector.id} skipped: endpoint is not allowlisted.`, {
      code: "ZCODE_ENTERPRISE_MCP_ENDPOINT_DENIED",
    });
    return false;
  }
  if (!isTenantMcpSecretRef(connector.secretEnv, tenantId)) {
    process.emitWarning(`MCP connector ${connector.id} skipped: secret reference is invalid.`, {
      code: "ZCODE_ENTERPRISE_MCP_SECRET_INVALID",
    });
    return false;
  }
  if (!process.env[connector.secretEnv]) {
    process.emitWarning(
      `MCP connector ${connector.id} skipped: configured secret is unavailable.`,
      {
        code: "ZCODE_ENTERPRISE_MCP_SECRET_MISSING",
      },
    );
    return false;
  }
  return true;
}

/**
 * 客户工作区物化：管理员 CRUD 时写入 AGENTS.md、客户 Skill 与 MCP 中继配置。
 * MCP 使用库内稳定令牌——多个专家 runtime 共享同一份工作区配置，
 * 令牌必须跨网关重启一致。上游 secret 仍只在网关环境解析，不落工作区。
 */
export async function materializeCustomer(
  customer: Customer,
  store: EnterpriseStore,
  userId: string,
  relayOrigin: string,
): Promise<void> {
  const skills = store.listSkillsForCustomer(userId, customer.id);
  const bindings = store.listMcpBindingsForCustomer(userId, customer.id);
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const binding of bindings) {
    if (binding.tenantId !== customer.tenantId) {
      process.emitWarning(`MCP binding ${binding.id} skipped: tenant binding is invalid.`, {
        code: "ZCODE_ENTERPRISE_MCP_TENANT_INVALID",
      });
      continue;
    }
    if (!isTenantMcpEndpointAllowed(customer.tenantId, binding.endpoint)) {
      process.emitWarning(`MCP binding ${binding.id} skipped: endpoint is not allowlisted.`, {
        code: "ZCODE_ENTERPRISE_MCP_ENDPOINT_DENIED",
      });
      continue;
    }
    if (binding.secretRef && !isTenantMcpSecretRef(binding.secretRef, customer.tenantId)) {
      process.emitWarning(`MCP binding ${binding.id} skipped: secret reference is invalid.`, {
        code: "ZCODE_ENTERPRISE_MCP_SECRET_INVALID",
      });
      continue;
    }
    if (binding.secretRef && !process.env[binding.secretRef]) {
      process.emitWarning(`MCP binding ${binding.id} skipped: configured secret is unavailable.`, {
        code: "ZCODE_ENTERPRISE_MCP_SECRET_MISSING",
      });
      continue;
    }
    const token = store.ensureMcpBindingToken(binding.id);
    const relayUrl = new URL(
      `/api/enterprise/mcp-relay/${encodeURIComponent(customer.id)}/${encodeURIComponent(binding.id)}`,
      relayOrigin,
    );
    mcpServers[binding.name] = {
      type: "http",
      url: relayUrl.toString(),
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  await prepareCustomerWorkspace({
    workspacePath: customer.workspacePath,
    sharedSkills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      content: skill.content,
      sha256: skill.contentHash,
    })),
    mcpServers,
  });
  await store.writeCustomerAgentsFile(customer);
}
