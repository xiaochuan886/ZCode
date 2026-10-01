import { join } from "node:path";
import type { EnterpriseApiRequest } from "./gateway-types.js";
import type { EnterpriseSession, TenantModelProviderDistribution } from "./types.js";
import { EnterpriseError, expertRuntimeId } from "./types.js";
import { isTenantMcpEndpointAllowed, isTenantMcpSecretRef } from "./mcp-policy.js";
import { listImportableSkills, readImportableSkill } from "./skill-import.js";
import type { TenantModelProviderInput, TenantModelProviderPatch } from "./provider-format.js";
import type {
  TenantMcpConnectorInput,
  TenantMcpConnectorPatch,
} from "./connector-store-support.js";

const connectionTestTimeoutMs = 8_000;
const personalSkillNamePattern = /^[a-z0-9][a-z0-9-_./]{0,120}$/;
const maxPersonalSkillBytes = 1024 * 1024;

/** Body fields may be absent; present values must have the declared primitive shape. */
function text(value: unknown): string {
  if (typeof value !== "string") throw new EnterpriseError("validation");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new EnterpriseError("validation");
  return value;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new EnterpriseError("validation");
  return value as string[];
}

function requireAdmin(
  options: EnterpriseApiRequest["options"],
  session: EnterpriseSession,
  tenantId: string,
): void {
  if (options.store.getMembership(session.userId, tenantId).role !== "admin")
    throw new EnterpriseError("forbidden");
}

/** 个人 Skill 名只允许受限字符集,且拒绝绝对路径与 '.'/'..' 段,防目录穿越。 */
function validatePersonalSkillName(value: string): string {
  if (!personalSkillNamePattern.test(value)) throw new EnterpriseError("validation");
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..")
      throw new EnterpriseError("validation");
  }
  return value;
}

function parseModelList(body: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const data = (value as { data?: unknown }).data;
    if (!Array.isArray(data)) return undefined;
    const models = data.map((entry) =>
      entry && typeof entry === "object" ? (entry as { id?: unknown }).id : entry,
    );
    return models.every((model) => typeof model === "string") ? (models as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 连接测试:服务端直连供应商 models 端点,8s 超时;ok = HTTP < 400。
 * API key 只进请求头,绝不进日志或响应。
 */
async function testProviderConnection(
  provider: TenantModelProviderDistribution,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), connectionTestTimeoutMs);
  try {
    const url =
      provider.apiType === "anthropic-messages"
        ? `${provider.baseUrl}/v1/models`
        : `${provider.baseUrl}/models`;
    const headers =
      provider.apiType === "anthropic-messages"
        ? { "x-api-key": provider.apiKey }
        : { authorization: `Bearer ${provider.apiKey}` };
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (response.status >= 400)
      return { ok: false, error: `upstream responded with HTTP ${response.status}` };
    const models = parseModelList(await response.text());
    return { ok: true, ...(models === undefined ? {} : { models }) };
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted ? "connection test timed out" : "connection test failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** 租户目录 API:模型供应商目录、系统连接器与个人 Skill 导入。 */

/** 个人 Skill 导入的工作区清单只覆盖该成员可见的客户(allowlist)。 */
function visibleWorkspaces(
  store: EnterpriseApiRequest["options"]["store"],
  actorId: string,
  tenantId: string,
): Array<{ id: string; name: string; workspacePath: string }> {
  const visible = new Set(store.visibleCustomerIdsFor(actorId, tenantId));
  return store
    .listCustomers(actorId, tenantId)
    .filter((customer) => visible.has(customer.id))
    .map((customer) => ({
      id: customer.id,
      name: customer.name,
      workspacePath: customer.workspacePath,
    }));
}

export async function handleTenantCatalogApiRequest(
  dependencies: EnterpriseApiRequest,
  session: EnterpriseSession,
): Promise<boolean> {
  const { options, request, response, path, method, stopRuntime } = dependencies;
  const { send, jsonBody, str, runtimeTargetsForTenant } = dependencies.helpers;
  const stopTenantRuntimes = async (tenantId: string): Promise<void> => {
    // 目录变更影响所有专家 runtime 的分发内容:先停,下次打开时重新物化。
    const affected = runtimeTargetsForTenant(options.store, session.userId, tenantId);
    await Promise.all(affected.map((target) => stopRuntime(target)));
  };

  const providerList = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/model-providers$/);
  if (providerList && method === "GET") {
    send(response, 200, options.store.listTenantModelProviders(session.userId, providerList[1]!));
    return true;
  }
  if (providerList && method === "POST") {
    const tenantId = providerList[1]!;
    requireAdmin(options, session, tenantId);
    const body = await jsonBody(request);
    const input: TenantModelProviderInput = {
      providerKey: str(body.providerKey),
      displayName: str(body.displayName),
      apiType: str(body.apiType),
      baseUrl: str(body.baseUrl),
      apiKey: str(body.apiKey),
      ...(body.models === undefined ? {} : { models: optionalStringArray(body.models)! }),
      ...(body.defaultModel === undefined ? {} : { defaultModel: optionalText(body.defaultModel) }),
      ...(body.isDefault === undefined ? {} : { isDefault: optionalBoolean(body.isDefault)! }),
      ...(body.enabled === undefined ? {} : { enabled: optionalBoolean(body.enabled)! }),
    };
    await stopTenantRuntimes(tenantId);
    send(response, 201, options.store.createTenantModelProvider(session.userId, tenantId, input));
    return true;
  }
  const providerItem = path.match(/^\/api\/enterprise\/model-providers\/([^/]+)$/);
  if (providerItem && method === "PATCH") {
    const current = options.store.getTenantModelProvider(session.userId, providerItem[1]!);
    requireAdmin(options, session, current.tenantId);
    const body = await jsonBody(request);
    const patch: TenantModelProviderPatch = {
      ...(body.displayName === undefined ? {} : { displayName: optionalText(body.displayName) }),
      ...(body.apiType === undefined ? {} : { apiType: optionalText(body.apiType) }),
      ...(body.baseUrl === undefined ? {} : { baseUrl: optionalText(body.baseUrl) }),
      ...(body.apiKey === undefined ? {} : { apiKey: optionalText(body.apiKey) }),
      ...(body.models === undefined ? {} : { models: optionalStringArray(body.models) }),
      ...(body.defaultModel === undefined ? {} : { defaultModel: optionalText(body.defaultModel) }),
      ...(body.isDefault === undefined ? {} : { isDefault: optionalBoolean(body.isDefault)! }),
      ...(body.enabled === undefined ? {} : { enabled: optionalBoolean(body.enabled)! }),
    };
    await stopTenantRuntimes(current.tenantId);
    send(
      response,
      200,
      options.store.updateTenantModelProvider(session.userId, providerItem[1]!, patch),
    );
    return true;
  }
  if (providerItem && method === "DELETE") {
    const current = options.store.getTenantModelProvider(session.userId, providerItem[1]!);
    requireAdmin(options, session, current.tenantId);
    await stopTenantRuntimes(current.tenantId);
    options.store.deleteTenantModelProvider(session.userId, providerItem[1]!);
    send(response, 200, { ok: true });
    return true;
  }
  const providerTest = path.match(/^\/api\/enterprise\/model-providers\/([^/]+)\/test$/);
  if (providerTest && method === "POST") {
    requireAdmin(
      options,
      session,
      options.store.getTenantModelProvider(session.userId, providerTest[1]!).tenantId,
    );
    const provider = options.store.tenantModelProviderForConnectionTest(
      session.userId,
      providerTest[1]!,
    );
    send(response, 200, await testProviderConnection(provider, options.fetchImpl ?? fetch));
    return true;
  }

  const connectorList = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/mcp-connectors$/);
  if (connectorList && method === "GET") {
    send(response, 200, options.store.listTenantMcpConnectors(session.userId, connectorList[1]!));
    return true;
  }
  if (connectorList && method === "POST") {
    const tenantId = connectorList[1]!;
    requireAdmin(options, session, tenantId);
    const body = await jsonBody(request);
    const url = str(body.url);
    if (!isTenantMcpEndpointAllowed(tenantId, url)) throw new EnterpriseError("validation");
    const authMode = body.authMode === undefined ? "shared" : text(body.authMode);
    if (authMode !== "shared" && authMode !== "user-oauth") throw new EnterpriseError("validation");
    const secretEnv = body.secretEnv === undefined ? undefined : text(body.secretEnv);
    if (authMode === "shared") {
      // shared 模式仍要求租户前缀 secret 引用;user-oauth 模式由 store 侧拒绝 secretEnv。
      if (!secretEnv || !isTenantMcpSecretRef(secretEnv, tenantId))
        throw new EnterpriseError("validation");
    }
    const input: TenantMcpConnectorInput = {
      connectorKey: str(body.connectorKey),
      displayName: str(body.displayName),
      url,
      ...(body.headerName === undefined ? {} : { headerName: optionalText(body.headerName) }),
      ...(secretEnv === undefined ? {} : { secretEnv }),
      ...(body.enabled === undefined ? {} : { enabled: optionalBoolean(body.enabled)! }),
      ...(body.authMode === undefined ? {} : { authMode }),
      ...(body.authorizeUrl === undefined ? {} : { authorizeUrl: optionalText(body.authorizeUrl) }),
      ...(body.tokenUrl === undefined ? {} : { tokenUrl: optionalText(body.tokenUrl) }),
      ...(body.clientId === undefined ? {} : { clientId: optionalText(body.clientId) }),
      ...(body.clientSecret === undefined ? {} : { clientSecret: optionalText(body.clientSecret) }),
      ...(body.scopes === undefined ? {} : { scopes: optionalText(body.scopes) }),
    };
    await stopTenantRuntimes(tenantId);
    send(response, 201, options.store.createTenantMcpConnector(session.userId, tenantId, input));
    return true;
  }
  const connectorItem = path.match(/^\/api\/enterprise\/mcp-connectors\/([^/]+)$/);
  if (connectorItem && method === "PATCH") {
    const current = options.store.getTenantMcpConnector(session.userId, connectorItem[1]!);
    requireAdmin(options, session, current.tenantId);
    const body = await jsonBody(request);
    if (body.url !== undefined && !isTenantMcpEndpointAllowed(current.tenantId, text(body.url)))
      throw new EnterpriseError("validation");
    const authMode = body.authMode === undefined ? undefined : text(body.authMode);
    if (authMode !== undefined && authMode !== "shared" && authMode !== "user-oauth")
      throw new EnterpriseError("validation");
    const secretEnv = body.secretEnv === undefined ? undefined : text(body.secretEnv);
    // 显式切换到 shared 时必须携带合法 secret 引用;保持 shared 现状且未改动时,
    // 存量引用已在写入时校验过,无需重复检查。
    if (authMode === "shared" && secretEnv !== undefined) {
      if (!isTenantMcpSecretRef(secretEnv, current.tenantId))
        throw new EnterpriseError("validation");
    }
    const patch: TenantMcpConnectorPatch = {
      ...(body.displayName === undefined ? {} : { displayName: optionalText(body.displayName) }),
      ...(body.url === undefined ? {} : { url: text(body.url) }),
      ...(body.headerName === undefined ? {} : { headerName: optionalText(body.headerName) }),
      ...(secretEnv === undefined ? {} : { secretEnv }),
      ...(body.enabled === undefined ? {} : { enabled: optionalBoolean(body.enabled)! }),
      ...(authMode === undefined ? {} : { authMode }),
      ...(body.authorizeUrl === undefined ? {} : { authorizeUrl: optionalText(body.authorizeUrl) }),
      ...(body.tokenUrl === undefined ? {} : { tokenUrl: optionalText(body.tokenUrl) }),
      ...(body.clientId === undefined ? {} : { clientId: optionalText(body.clientId) }),
      ...(body.clientSecret === undefined ? {} : { clientSecret: optionalText(body.clientSecret) }),
      ...(body.scopes === undefined ? {} : { scopes: optionalText(body.scopes) }),
    };
    await stopTenantRuntimes(current.tenantId);
    send(
      response,
      200,
      options.store.updateTenantMcpConnector(session.userId, connectorItem[1]!, patch),
    );
    return true;
  }
  if (connectorItem && method === "DELETE") {
    const current = options.store.getTenantMcpConnector(session.userId, connectorItem[1]!);
    requireAdmin(options, session, current.tenantId);
    await stopTenantRuntimes(current.tenantId);
    options.store.deleteTenantMcpConnector(session.userId, connectorItem[1]!);
    send(response, 200, { ok: true });
    return true;
  }

  const importableSkills = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/importable-skills$/);
  if (importableSkills && method === "GET") {
    const tenantId = importableSkills[1]!;
    requireAdmin(options, session, tenantId);
    const importedNames = new Set(
      options.store.listTenantSkills(session.userId, tenantId).map((skill) => skill.name),
    );
    // 无数据根(process 模式)时 HOME 不存在,清单为空而不是报错。
    const listing = options.modelRuntimeDataRoot
      ? await listImportableSkills({
          runtimeHome: join(
            options.modelRuntimeDataRoot,
            expertRuntimeId(session.userId, tenantId),
          ),
          workspaces: visibleWorkspaces(options.store, session.userId, tenantId),
          importedNames,
          maxBytes: maxPersonalSkillBytes,
        })
      : [];
    send(response, 200, listing);
    return true;
  }

  const skillImport = path.match(/^\/api\/enterprise\/tenants\/([^/]+)\/skills\/import$/);
  if (skillImport && method === "POST") {
    const tenantId = skillImport[1]!;
    requireAdmin(options, session, tenantId);
    const body = await jsonBody(request);
    const name = validatePersonalSkillName(str(body.name));
    if (body.origin !== "home" && body.origin !== "workspace")
      throw new EnterpriseError("validation");
    if (!options.modelRuntimeDataRoot)
      throw new Error("Expert runtime data root is not configured");
    const workspaces = visibleWorkspaces(options.store, session.userId, tenantId);
    // 原生 skill-creator 默认把新 Skill 建在项目级(客户 workspace),因此导入
    // 必须覆盖 HOME 与工作区两个来源,`.zcode/skills` 优先与原生发现一致。
    const content = await readImportableSkill({
      name,
      origin: body.origin,
      workspaceId: body.workspaceId === undefined ? undefined : str(body.workspaceId),
      runtimeHome: join(options.modelRuntimeDataRoot, expertRuntimeId(session.userId, tenantId)),
      workspaces,
      maxBytes: maxPersonalSkillBytes,
    });
    await stopTenantRuntimes(tenantId);
    const skill = options.store.createTenantSkill(session.userId, tenantId, { name, content });
    send(response, 201, { ok: true, skill: { id: skill.id, name: skill.name } });
    return true;
  }
  return false;
}
