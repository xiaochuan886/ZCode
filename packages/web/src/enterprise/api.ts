import type {
  ConnectorAuthorizeResult,
  CreatedTenantUser,
  Customer,
  CustomerDraft,
  EnterpriseBootstrap,
  ImportableTenantSkillView,
  ImportedTenantSkill,
  ModelProviderInput,
  ModelProviderPatch,
  ModelProviderTestResult,
  EnterpriseModelMetadata,
  ModelProviderView,
  TenantCustomerAccessInput,
  TenantCustomerAccessUpdateResult,
  TenantMcpConnectorInput,
  TenantMcpConnectorPatch,
  TenantMcpConnectorView,
  TenantSkillImportInput,
  TenantSkillView,
  TenantUserInput,
  TenantUserPatch,
  TenantUserView,
} from "./api-types.js";

export * from "./api-types.js";

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
    /** 工作台就绪信号(成员可读):供应商目录列表是管理员专属,门控只看 ready。 */
    modelStatus: (tenantId: string) =>
      request<{ ready: boolean }>(`/tenants/${encodeURIComponent(tenantId)}/model-status`),
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
    tenantUsers: (tenantId: string) =>
      request<TenantUserView[]>(`/tenants/${encodeURIComponent(tenantId)}/users`),
    createTenantUser: (tenantId: string, input: TenantUserInput, token: string | null) =>
      post<CreatedTenantUser>(
        `/tenants/${encodeURIComponent(tenantId)}/users`,
        {
          email: input.email.trim(),
          ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
          // 空密码不下发:已有邮箱加入无需密码,新建与加入由后端判断。
          ...(input.password ? { password: input.password } : {}),
          role: input.role,
        },
        token,
      ),
    updateTenantUser: (
      tenantId: string,
      userId: string,
      patch: TenantUserPatch,
      token: string | null,
    ) =>
      request<TenantUserView>(
        `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          // 空密码表示保留当前密码:undefined 在 JSON 序列化时被剔除,服务端保留原值。
          body: JSON.stringify({ ...patch, password: patch.password || undefined }),
        },
        token,
      ),
    deleteTenantUser: (tenantId: string, userId: string, token: string | null) =>
      request<{ ok: boolean }>(
        `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
        token,
      ),
    setTenantUserCustomerAccess: (
      tenantId: string,
      userId: string,
      access: TenantCustomerAccessInput,
      token: string | null,
    ) =>
      request<TenantCustomerAccessUpdateResult>(
        `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/customer-access`,
        { method: "PUT", body: JSON.stringify(access) },
        token,
      ),
  };
}
