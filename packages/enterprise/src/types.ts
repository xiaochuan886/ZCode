export type Role = "admin" | "member";
export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}
export interface Membership {
  tenantId: string;
  userId: string;
  role: Role;
}
export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}
export type EnterpriseRuntimeKind = "expert";
/**
 * 专家 runtime 目标:一个 (用户, 租户) 一个长驻 runtime,客户工作区全部挂载其中。
 * workspacePath 是主工作区(最近打开的客户),仅用于容器启动 env 与健康检查;
 * 路由身份完全由 runtimeId 决定,切换客户不触发任何 runtime 变更。
 */
export interface EnterpriseRuntimeTarget {
  id: string;
  tenantId: string;
  userId: string;
  workspacePath: string;
  runtimeId: string;
  kind: EnterpriseRuntimeKind;
  /** 该专家租户全部客户工作区(网关补充);容器挂载与原生广播使用。 */
  workspacePaths?: string[];
}
export function expertRuntimeId(userId: string, tenantId: string): string {
  return `e-${userId}-${tenantId}`;
}
export interface EnterpriseSession {
  id: string;
  userId: string;
  activeCustomerId: string | null;
  expiresAt: string;
}
export interface SharedSkill {
  id: string;
  tenantId: string;
  sourceCustomerId: string;
  name: string;
  content: string;
  contentHash: string;
  createdAt: string;
}
export interface TenantSkill {
  id: string;
  tenantId: string;
  name: string;
  content: string;
  contentHash: string;
  createdAt: string;
}
export interface McpBinding {
  id: string;
  tenantId: string;
  customerId: string | null;
  name: string;
  endpoint: string;
  secretRef: string | null;
  /** 稳定中继令牌;仅网关内部使用,浏览器响应必须剥离。 */
  token: string;
  createdAt: string;
}
/** 租户模型供应商目录行(投影):只带 key 尾四位,绝不携带解密后的 API key。 */
export interface TenantModelProvider {
  id: string;
  tenantId: string;
  providerKey: string;
  displayName: string;
  apiType: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  isDefault: boolean;
  enabled: boolean;
  apiKeyLast4: string | null;
}
/** 分发用解密行:仅网关内部使用,绝不序列化给浏览器。 */
export interface TenantModelProviderDistribution extends TenantModelProvider {
  apiKey: string;
}
/** 租户系统连接器(投影):只暴露 endpoint host 与配置状态,不回传 token/secret。 */
export interface TenantMcpConnector {
  id: string;
  tenantId: string;
  connectorKey: string;
  displayName: string;
  endpointHost: string;
  headerName: string;
  secretConfigured: boolean;
  enabled: boolean;
}
/** 连接器分发行:网关准备专家 runtime 时使用,secret 只在网关环境解析。 */
export interface TenantMcpConnectorDistribution {
  id: string;
  tenantId: string;
  connectorKey: string;
  url: string;
  headerName: string;
  secretEnv: string;
}
export class EnterpriseError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_transition"
      | "invalid_credentials"
      | "conflict"
      | "validation",
  ) {
    super(code);
    this.name = "EnterpriseError";
  }
}
