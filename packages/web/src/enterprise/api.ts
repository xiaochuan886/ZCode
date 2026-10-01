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
export interface ModelCredentialInput {
  providerName?: string;
  apiType: ModelApiType;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}
export function isCompleteModelCredentialInput(input: ModelCredentialInput): boolean {
  return Boolean(
    (input.apiType === "anthropic-messages" || input.apiType === "openai-chat-completions") &&
    input.baseUrl.trim() &&
    input.modelId.trim() &&
    input.apiKey.trim(),
  );
}
export interface ModelCredentialStatus {
  tenantId: string;
  providerFamily: "custom";
  /** Metadata is optional for rows created before the generic provider migration. */
  providerName?: string;
  apiType?: ModelApiType;
  baseUrl?: string;
  modelId?: string;
  status: "configured" | "revoked";
  configured: boolean;
  lastFour: string | null;
  updatedAt: string;
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
    modelCredentials: (tenantId: string) =>
      request<ModelCredentialStatus[]>(
        `/tenants/${encodeURIComponent(tenantId)}/model-credentials`,
      ),
    saveModelCredential: (tenantId: string, input: ModelCredentialInput, token: string | null) =>
      request<ModelCredentialStatus>(
        `/tenants/${encodeURIComponent(tenantId)}/model-credentials/custom`,
        { method: "PUT", body: JSON.stringify(input) },
        token,
      ),
    revokeModelCredential: (tenantId: string, token: string | null) =>
      request<ModelCredentialStatus>(
        `/tenants/${encodeURIComponent(tenantId)}/model-credentials/custom`,
        { method: "DELETE" },
        token,
      ),
  };
}
