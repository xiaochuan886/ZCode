/**
 * 企业网关 API 的请求/响应类型。拆分为独立模块以便 api.ts(客户端工厂)
 * 保持在架构检查的 400 行上限内;api.ts 原样 re-export,消费方导入不变。
 */
export interface EnterpriseUser {
  id: string;
  email: string;
  displayName: string;
}
export interface Tenant {
  id: string;
  name: string;
  role?: "admin" | "member";
}
export type ModelApiType = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
/** Provider catalog row projection: the API key never leaves the server, only its last four. */
/** 单模型的目录元数据:徽标展示用(上下文/输入输出格式/工具调用);enabled 缺省视为 true。 */
export interface EnterpriseModelMetadata {
  id: string;
  enabled?: boolean;
  contextWindow?: number;
  inputFormat?: {
    supportsText: boolean;
    supportsImage: boolean;
    supportsVideo: boolean;
    supportsAudio: boolean;
    supportsPdf: boolean;
  };
  outputFormat?: { supportsText: boolean };
  supportsToolCall?: boolean;
  supportsJsonSchemaOutput?: boolean;
}
export interface ModelProviderView {
  id: string;
  providerKey: string;
  displayName: string;
  apiType: ModelApiType;
  baseUrl: string;
  models: EnterpriseModelMetadata[];
  defaultModel: string | null;
  isDefault: boolean;
  enabled: boolean;
  apiKeyLast4: string;
}
export interface ModelProviderInput {
  providerKey: string;
  displayName: string;
  apiType: ModelApiType;
  baseUrl: string;
  apiKey: string;
  models?: (string | EnterpriseModelMetadata)[];
  defaultModel?: string;
  isDefault?: boolean;
  enabled?: boolean;
}
/** 编辑时 apiKey 留空表示保留现有密钥,因此 patch 中该字段可省略。 */
export interface ModelProviderPatch {
  displayName?: string;
  apiType?: ModelApiType;
  baseUrl?: string;
  apiKey?: string;
  models?: (string | EnterpriseModelMetadata)[];
  defaultModel?: string | null;
  isDefault?: boolean;
  enabled?: boolean;
}
export interface ModelProviderTestResult {
  ok: boolean;
  /** 连接测试返回上游模型 id 列表(不含元数据)。 */
  models?: string[];
  error?: string;
}
export type TenantMcpConnectorAuthMode = "shared" | "user-oauth";
/** Tenant connector (系统连接器) row projection; the relay token and secret stay server-side. */
export interface TenantMcpConnectorView {
  id: string;
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
export interface TenantMcpConnectorInput {
  connectorKey: string;
  displayName: string;
  url: string;
  headerName?: string;
  /** shared 模式必填;user-oauth 模式禁止。 */
  secretEnv?: string;
  authMode?: TenantMcpConnectorAuthMode;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  /** 编辑时留空表示保留当前密文;公共客户端可无 secret。 */
  clientSecret?: string;
  /** 单个空格分隔的 scope 串。 */
  scopes?: string;
}
export interface TenantMcpConnectorPatch {
  displayName?: string;
  url?: string;
  headerName?: string;
  secretEnv?: string;
  enabled?: boolean;
  authMode?: TenantMcpConnectorAuthMode;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
}
export interface ConnectorAuthorizeResult {
  authorizeUrl: string;
}
export interface ImportableTenantSkillView {
  name: string;
  description: string;
  origin: "home" | "workspace";
  workspaceId: string | null;
  workspaceName: string | null;
  alreadyImported: boolean;
}
export interface TenantSkillImportInput {
  name: string;
  origin: "home" | "workspace";
  workspaceId?: string | null;
}
export interface ImportedTenantSkill {
  ok: boolean;
  skill: { id: string; name: string };
}
export type TenantUserRole = "admin" | "member";
export type TenantUserStatus = "active" | "disabled";
/** 客户可见性:mode all(无授权,可见全部客户,向后兼容默认)或 selected(仅可见所列客户)。 */
export interface TenantCustomerAccess {
  mode: "all" | "selected";
  customerIds: string[];
}
export interface TenantCustomerAccessInput {
  mode: "all" | "selected";
  customerIds?: string[];
}
/** 租户成员投影:customerAccess 在部分路由(如创建返回)可能缺省,缺省按 all 处理。 */
export interface TenantUserView {
  id: string;
  email: string;
  displayName: string;
  role: TenantUserRole;
  status: TenantUserStatus;
  createdAt: string;
  customerAccess?: TenantCustomerAccess;
}
export interface TenantUserInput {
  email: string;
  displayName?: string;
  /** 仅全新全局用户必填;已有邮箱直接加入租户,由后端区分,空值不下发。 */
  password?: string;
  role: TenantUserRole;
}
export interface TenantUserPatch {
  displayName?: string;
  role?: TenantUserRole;
  /** 管理员重置密码;留空(或省略)表示保留当前密码。 */
  password?: string;
  status?: TenantUserStatus;
}
/** 创建成员返回:扁平用户投影 + joined 区分「加入已有全局账号」与「新建账号」。 */
export interface CreatedTenantUser extends TenantUserView {
  joined: boolean;
}
export interface TenantCustomerAccessUpdateResult {
  ok: boolean;
  customerAccess: TenantCustomerAccess;
}
export interface Customer {
  id: string;
  tenantId?: string;
  name: string;
  type?: string;
  metadata?: Record<string, unknown>;
  workspacePath?: string;
  workspaceIdentity?: string;
}
export interface ActiveCustomer {
  id: string;
  name: string;
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface CustomerDraft {
  tenantId: string;
  name: string;
  type?: string;
  metadata?: Record<string, unknown>;
}
export interface EnterpriseBootstrap {
  enabled: true;
  user: EnterpriseUser | null;
  tenants: Tenant[];
  activeCustomer: ActiveCustomer | null;
  csrfToken: string | null;
}
export interface TenantSkillView {
  id: string;
  tenantId: string;
  name: string;
  content: string;
  createdAt: string;
}
