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
export type ModelApiType = "anthropic-messages" | "openai-chat-completions";
/** Provider catalog row projection: the API key never leaves the server, only its last four. */
export interface ModelProviderView {
  id: string;
  providerKey: string;
  displayName: string;
  apiType: ModelApiType;
  baseUrl: string;
  models: string[];
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
  models?: string[];
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
  models?: string[];
  defaultModel?: string | null;
  isDefault?: boolean;
  enabled?: boolean;
}
export interface ModelProviderTestResult {
  ok: boolean;
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
export class EnterpriseApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EnterpriseApiError";
    this.status = status;
  }
}
export function isCompleteCustomerDraft(draft: Pick<CustomerDraft, "tenantId" | "name">): boolean {
  return Boolean(draft.tenantId.trim() && draft.name.trim());
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function records<T>(value: T[] | { items: T[] }): T[] {
  return Array.isArray(value) ? value : value.items;
}
export function createEnterpriseClient(fetcher: Fetch = fetch) {
  async function request<T>(
    path: string,
    init: RequestInit = {},
    csrfToken?: string | null,
  ): Promise<T> {
    const response = await fetcher(`/api/enterprise${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`.trim();
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        detail = body.message ?? body.error ?? detail;
      } catch {
        /* HTTP status remains the error */
      }
      throw new EnterpriseApiError(detail, response.status);
    }
    return response.json() as Promise<T>;
  }
  const post = <T>(path: string, body: unknown, token: string | null) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }, token);
  return {
    async bootstrap(): Promise<EnterpriseBootstrap | null> {
      const response = await fetcher("/api/enterprise/bootstrap", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Enterprise bootstrap failed (${response.status})`);
      const body = (await response.json()) as EnterpriseBootstrap;
      if (body.enabled !== true) return null;
      return {
        ...body,
        activeCustomer: body.activeCustomer ?? null,
      };
    },
    login: (email: string, password: string, token: string | null) =>
      post<void>("/login", { email, password }, token),
    logout: (token: string | null) => post<void>("/logout", {}, token),
    customers: async (tenantId: string) =>
      records(
        await request<Customer[] | { items: Customer[] }>(
          `/customers?tenantId=${encodeURIComponent(tenantId)}`,
        ),
      ),
    createCustomer: (draft: CustomerDraft, token: string | null) =>
      post<Customer>(
        "/customers",
        {
          tenantId: draft.tenantId,
          name: draft.name.trim(),
          ...(draft.type?.trim() ? { type: draft.type.trim() } : {}),
          metadata: draft.metadata ?? {},
        },
        token,
      ),
    activateCustomer: (id: string, token: string | null) =>
      post<void>(`/customers/${encodeURIComponent(id)}/activate`, {}, token),
    updateCustomer: (id: string, input: { name?: string; type?: string }, token: string | null) =>
      request<Customer>(
        `/customers/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
        token,
      ),
    deleteCustomer: (id: string, token: string | null) =>
      request<{ ok: boolean }>(`/customers/${encodeURIComponent(id)}`, { method: "DELETE" }, token),
    tenantSkills: async (tenantId: string) => {
      const body = await request<{ items: TenantSkillView[] } | TenantSkillView[]>(
        `/tenants/${encodeURIComponent(tenantId)}/skills`,
      );
      return records(body);
    },
    createTenantSkill: (
      tenantId: string,
      input: { name: string; content: string },
      token: string | null,
    ) =>
      post<TenantSkillView>(
        `/tenants/${encodeURIComponent(tenantId)}/skills`,
        { name: input.name.trim(), content: input.content },
        token,
      ),
    deleteTenantSkill: (tenantId: string, skillId: string, token: string | null) =>
      request<{ ok: boolean }>(
        `/tenants/${encodeURIComponent(tenantId)}/skills/${encodeURIComponent(skillId)}`,
        { method: "DELETE" },
        token,
      ),
    modelProviders: (tenantId: string) =>
      request<ModelProviderView[]>(`/tenants/${encodeURIComponent(tenantId)}/model-providers`),
    createModelProvider: (tenantId: string, input: ModelProviderInput, token: string | null) =>
      post<ModelProviderView>(
        `/tenants/${encodeURIComponent(tenantId)}/model-providers`,
        input,
        token,
      ),
    updateModelProvider: (id: string, patch: ModelProviderPatch, token: string | null) =>
      request<ModelProviderView>(
        `/model-providers/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
        token,
      ),
    deleteModelProvider: (id: string, token: string | null) =>
      request<{ ok: boolean }>(
        `/model-providers/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        token,
      ),
    testModelProvider: (id: string, token: string | null) =>
      post<ModelProviderTestResult>(`/model-providers/${encodeURIComponent(id)}/test`, {}, token),
    mcpConnectors: (tenantId: string) =>
      request<TenantMcpConnectorView[]>(`/tenants/${encodeURIComponent(tenantId)}/mcp-connectors`),
    createMcpConnector: (tenantId: string, input: TenantMcpConnectorInput, token: string | null) =>
      post<TenantMcpConnectorView>(
        `/tenants/${encodeURIComponent(tenantId)}/mcp-connectors`,
        input,
        token,
      ),
    updateMcpConnector: (id: string, patch: TenantMcpConnectorPatch, token: string | null) =>
      request<TenantMcpConnectorView>(
        `/mcp-connectors/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
        token,
      ),
    deleteMcpConnector: (id: string, token: string | null) =>
      request<{ ok: boolean }>(
        `/mcp-connectors/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        token,
      ),
    connectorAuthorizeUrl: (tenantId: string, connectorId: string) =>
      request<ConnectorAuthorizeResult>(
        `/tenants/${encodeURIComponent(tenantId)}/mcp-connectors/${encodeURIComponent(connectorId)}/authorize`,
      ),
    revokeConnectorAuthorization: (tenantId: string, connectorId: string, token: string | null) =>
      request<{ ok: boolean }>(
        `/tenants/${encodeURIComponent(tenantId)}/mcp-connectors/${encodeURIComponent(connectorId)}/authorization`,
        { method: "DELETE" },
        token,
      ),
    importableSkills: (tenantId: string) =>
      request<ImportableTenantSkillView[]>(
        `/tenants/${encodeURIComponent(tenantId)}/importable-skills`,
      ),
    importTenantSkill: (tenantId: string, input: TenantSkillImportInput, token: string | null) =>
      post<ImportedTenantSkill>(
        `/tenants/${encodeURIComponent(tenantId)}/skills/import`,
        input,
        token,
      ),
  };
}
