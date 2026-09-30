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
export interface ModelCredentialStatus {
  tenantId: string;
  providerFamily: "zai-api" | "bigmodel-api";
  status: "configured" | "revoked";
  configured: boolean;
  lastFour: string | null;
  updatedAt: string;
}
export interface ServiceSpace {
  id: string;
  tenantId: string;
  name: string;
}
export interface ServiceObject {
  id: string;
  serviceSpaceId: string;
  name: string;
  type: string;
}
export interface EnterpriseCase {
  id: string;
  title: string;
  category: string;
  status: string;
  serviceSpaceId: string;
  serviceObject: { id: string; name: string; type: string };
  workspacePath: string;
  sessionId?: string;
}
export interface EnterpriseBootstrap {
  enabled: true;
  user: EnterpriseUser | null;
  tenants: Tenant[];
  activeCase: EnterpriseCase | null;
  csrfToken: string | null;
}
export interface CaseDraft {
  serviceSpaceId: string;
  serviceObjectId: string;
  title: string;
  category: string;
}
export class EnterpriseApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EnterpriseApiError";
    this.status = status;
  }
}
export function isCompleteCaseDraft(draft: CaseDraft): boolean {
  return Boolean(
    draft.serviceSpaceId.trim() &&
    draft.serviceObjectId.trim() &&
    draft.title.trim() &&
    draft.category.trim(),
  );
}
export function statusChoices(status: string): string[] {
  const next: Record<string, string[]> = {
    open: ["in_progress"],
    in_progress: ["resolved"],
    resolved: ["closed", "in_progress"],
    closed: ["in_progress"],
  };
  return [status, ...(next[status] ?? [])];
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function records<T>(value: T[] | { items: T[] }): T[] {
  return Array.isArray(value) ? value : value.items;
}
function normalizeCase(
  value: EnterpriseCase & {
    serviceObjectId?: string;
    objectSnapshot?: { name: string; type: string };
    nativeSessionId?: string | null;
  },
): EnterpriseCase {
  if (value.serviceObject) return value;
  return {
    ...value,
    serviceObject: {
      id: value.serviceObjectId ?? "",
      name: value.objectSnapshot?.name ?? "",
      type: value.objectSnapshot?.type ?? "",
    },
    ...(value.nativeSessionId ? { sessionId: value.nativeSessionId } : {}),
  };
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
      return { ...body, activeCase: body.activeCase ? normalizeCase(body.activeCase) : null };
    },
    login: (email: string, password: string, token: string | null) =>
      post<void>("/login", { email, password }, token),
    logout: (token: string | null) => post<void>("/logout", {}, token),
    spaces: async (tenantId: string) =>
      records(
        await request<ServiceSpace[] | { items: ServiceSpace[] }>(
          `/spaces?tenantId=${encodeURIComponent(tenantId)}`,
        ),
      ),
    createSpace: (tenantId: string, name: string, token: string | null) =>
      post<ServiceSpace>("/spaces", { tenantId, name }, token),
    objects: async (serviceSpaceId: string) =>
      records(
        await request<ServiceObject[] | { items: ServiceObject[] }>(
          `/objects?serviceSpaceId=${encodeURIComponent(serviceSpaceId)}`,
        ),
      ),
    createObject: (serviceSpaceId: string, name: string, type: string, token: string | null) =>
      post<ServiceObject>("/objects", { serviceSpaceId, name, type, metadata: {} }, token),
    cases: async (serviceSpaceId: string) =>
      records(
        await request<EnterpriseCase[] | { items: EnterpriseCase[] }>(
          `/cases?serviceSpaceId=${encodeURIComponent(serviceSpaceId)}`,
        ),
      ).map(normalizeCase),
    createCase: (draft: CaseDraft, token: string | null) =>
      post<EnterpriseCase>("/cases", { ...draft, contextSnapshot: {} }, token),
    activateCase: (id: string, token: string | null) =>
      post<void>(`/cases/${encodeURIComponent(id)}/activate`, {}, token),
    modelCredentials: (tenantId: string) =>
      request<ModelCredentialStatus[]>(
        `/tenants/${encodeURIComponent(tenantId)}/model-credentials`,
      ),
    saveModelCredential: (
      tenantId: string,
      providerFamily: ModelCredentialStatus["providerFamily"],
      apiKey: string,
      token: string | null,
    ) =>
      request<ModelCredentialStatus>(
        `/tenants/${encodeURIComponent(tenantId)}/model-credentials/${providerFamily}`,
        { method: "PUT", body: JSON.stringify({ apiKey }) },
        token,
      ),
    revokeModelCredential: (
      tenantId: string,
      providerFamily: ModelCredentialStatus["providerFamily"],
      token: string | null,
    ) =>
      request<ModelCredentialStatus>(
        `/tenants/${encodeURIComponent(tenantId)}/model-credentials/${providerFamily}`,
        { method: "DELETE" },
        token,
      ),
    bindSession: (id: string, sessionId: string, token: string | null, signal?: AbortSignal) =>
      request<void>(
        `/cases/${encodeURIComponent(id)}/session`,
        { method: "POST", body: JSON.stringify({ sessionId }), signal },
        token,
      ),
    updateCaseStatus: (id: string, status: string, token: string | null) =>
      request<EnterpriseCase>(
        `/cases/${encodeURIComponent(id)}/status`,
        { method: "PATCH", body: JSON.stringify({ status }) },
        token,
      ),
  };
}
