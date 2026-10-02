export type Role = "admin" | "member";
/**
 * 网关支持的三种上游协议。定义在 types.ts 是为了避免与
 * model-credential-format.ts 形成模块环(后者已依赖本文件);两处共用同一联合类型,
 * `openai-responses` 与 openai-chat-completions 同走 OpenAI 风格发现/鉴权路径。
 */
export const MODEL_API_TYPES = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
] as const;
export type ModelApiType = (typeof MODEL_API_TYPES)[number];
export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}
/** 用户状态:disabled = 全局封禁(登录拒绝、既有会话立即失效)。 */
export type UserStatus = "active" | "disabled";
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  status: UserStatus;
}
export interface Membership {
  tenantId: string;
  userId: string;
  role: Role;
}
/** 客户可见性:all = 可见租户全部客户(无授权行的信任默认);selected = 恰好授权的客户。 */
export type CustomerAccessMode = "all" | "selected";
export interface CustomerAccess {
  mode: CustomerAccessMode;
  customerIds: string[];
}
/** 租户成员管理投影:全局身份 + 本租户角色/状态 + 客户可见性摘要。 */
export interface TenantUserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  customerAccess: CustomerAccess;
}
export interface TenantUserChange extends TenantUserSummary {
  /** true = 邮箱对应的全局身份已存在,本次只新增了本租户成员关系。 */
  joined: boolean;
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
  /** 该成员在租户内可见的客户工作区(网关按可见性过滤后补充);容器挂载与原生广播使用。 */
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
/**
 * 单模型目录条目的输入/输出格式元数据(schema v10):前端徽标展示用。
 * 专家 runtime 的分发仍只携带模型 id,元数据不进入 provider_config.json。
 */
export interface ModelInputFormatMetadata {
  supportsText: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsPdf: boolean;
}
export interface ModelOutputFormatMetadata {
  supportsText: boolean;
}
/** 富模型条目:`enabled` 缺省视为启用(存储约定:只有显式 false 才落 enabled:false)。 */
export interface TenantModelCatalogEntry {
  id: string;
  enabled?: boolean;
  contextWindow?: number;
  inputFormat?: ModelInputFormatMetadata;
  outputFormat?: ModelOutputFormatMetadata;
  supportsToolCall?: boolean;
  supportsJsonSchemaOutput?: boolean;
}
/** 租户模型供应商目录行(投影):只带 key 尾四位,绝不携带解密后的 API key。 */
export interface TenantModelProvider {
  id: string;
  tenantId: string;
  providerKey: string;
  displayName: string;
  /** 三种上游协议:anthropic-messages / openai-chat-completions / openai-responses。 */
  apiType: ModelApiType;

  baseUrl: string;
  models: TenantModelCatalogEntry[];
  defaultModel: string;
  isDefault: boolean;
  enabled: boolean;
  apiKeyLast4: string | null;
}
/** 分发用解密行:仅网关内部使用,绝不序列化给浏览器。 */
export interface TenantModelProviderDistribution extends TenantModelProvider {
  apiKey: string;
}
/** 连接器认证模式:shared = 网关共享 secret;user-oauth = 每用户 OAuth 令牌。 */
export type TenantMcpConnectorAuthMode = "shared" | "user-oauth";
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
  authMode: TenantMcpConnectorAuthMode;
  /** user-oauth 模式下当前用户是否已连接自己的账号;shared 模式恒为 true。 */
  authorized: boolean;
}
/** 连接器分发行:网关准备专家 runtime 时使用,secret 只在网关环境解析。 */
export interface TenantMcpConnectorDistribution {
  id: string;
  tenantId: string;
  connectorKey: string;
  url: string;
  headerName: string;
  secretEnv: string;
  authMode: TenantMcpConnectorAuthMode;
}
/** user-oauth 连接器的 OAuth 客户端配置(网关内部解密读取,绝不进浏览器响应)。 */
export interface TenantMcpConnectorOauthConfig {
  tenantId: string;
  connectorId: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** 公共客户端可为空;存储时已解密。 */
  clientSecret: string | null;
  /** 单个空格分隔的 scope 串,未配置为空字符串。 */
  scopes: string;
}
/** 解密后的每用户授权(网关内部使用)。 */
export interface UserConnectorAuthorization {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  /** 首次授予生成,重新授权保持稳定,写入专家 HOME 的中继令牌。 */
  relayToken: string;
}
/** 中继鉴权用的每用户授权(含连接器上游与 OAuth 客户端配置,网关内部使用)。 */
export interface UserConnectorAuthorizationForRelay {
  authorizationId: string;
  connectorId: string;
  tenantId: string;
  url: string;
  headerName: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}
/** OAuth 令牌端点响应解析结果。 */
export interface ConnectorOauthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
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
