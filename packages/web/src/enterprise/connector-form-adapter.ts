import type { ZCodeMcpServer } from "@zcode/shared";
import type { McpFormState } from "@zcode/ui";
import type {
  TenantMcpConnectorInput,
  TenantMcpConnectorPatch,
  TenantMcpConnectorView,
} from "./api.js";
import type { ConnectorFormErrors } from "./connector-tab-strings.js";

/**
 * 企业连接器 tab 的适配层:网关目录行(TenantMcpConnectorView) ↔ 原生
 * McpServerList/McpServerForm 视图模型(ZCodeMcpServer / McpFormState)的双向映射。
 *
 * 机密策略(与旧 EnterpriseConnectorForm 的保存语义保持等价):
 * - 视图不返回完整 URL(只有 endpointHost)、密钥引用与 OAuth 客户端配置,因此这些
 *   字段在编辑态一律不回显;保存时未提供即不下发,由服务端逐项保留原值,绝不清空。
 * - 共享密钥经原生表单的「Headers(可选)」JSON 通道携带:恰好一条
 *   {"Header 名称": "ZCODE_ENTERPRISE_MCP_SECRET_… 环境变量名"},键映射 headerName、
 *   值映射 secretEnv(网关把该环境变量的值注入上游请求头,不接受浏览器侧明文密钥)。
 * - user-oauth 的客户端配置(authorizeUrl/tokenUrl/clientId/clientSecret/scope)经
 *   JSON 模式的 oauth 对象携带;表单模式只编辑名称与 URL,连接/断开留在行级操作。
 */

/** 与网关 connector-format.ts 的 CONNECTOR_KEY_PATTERN 保持一致(浏览器侧不可导入企业后端,复制常量)。 */
const CONNECTOR_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 与网关 mcp-policy.ts 的 secretPrefix 保持一致;完整校验(租户 UUID 段)仍由 API 层执行。 */
const SECRET_REF_PREFIX = "ZCODE_ENTERPRISE_MCP_SECRET_";

export type ConnectorFormErrorKey = keyof ConnectorFormErrors;

export type ConnectorDraft<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConnectorFormErrorKey };

/**
 * 目录行 → 原生列表/表单视图模型。name 用 displayName(行标题与表单「名称」字段
 * 都是人读名);config 如实映射为网关分发的 http 形态,url 只持有视图回显的端点
 * 主机名。status 一律缺省:网关是目录不持有活动连接,原生状态点呈中性;
 * 不设 toolCount/location(hideMetadata 隐藏徽标,行可点开编辑)。
 */
export function connectorToServerView(view: TenantMcpConnectorView): ZCodeMcpServer {
  return {
    id: view.id,
    name: view.displayName,
    enabled: view.enabled,
    config: { type: "http", url: view.endpointHost },
    // 租户目录没有工作区作用域:固定 user 语义供表单 storageLevel 推导(徽标已隐藏)。
    source: "zcodeagentmcp",
    scope: "user",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 新建态初始视图模型:原生空表单默认 stdio(command/args 字段),而连接器恒为
 * http 形态——预置空 http 形态让表单直接以 HTTP 打开,避免管理员先选错类型。
 * 附带收益:initial 存在时原生 Scope 菜单天然禁用,更贴合租户固定作用域。
 */
export function createConnectorFormInitial(): ZCodeMcpServer {
  return {
    id: "create",
    name: "",
    enabled: true,
    config: { type: "http", url: "" },
    source: "zcodeagentmcp",
    scope: "user",
  };
}

/**
 * URL 通道:编辑态表单显示的是主机名占位而非完整 URL(视图不返回)。与占位一致
 * 视为「未修改」不下发(服务端保留真实地址);修改后必须是完整 https 地址,
 * 是否命中租户允许清单由 API 层终审。
 */
function resolveUrlDraft(url: string, placeholderUrl: string | undefined): ConnectorDraft<string> {
  const trimmed = url.trim();
  if (placeholderUrl && trimmed === placeholderUrl) return { ok: true, value: "" };
  if (!trimmed.startsWith("https://")) return { ok: false, error: "errorUrlHttps" };
  return { ok: true, value: trimmed };
}

interface SharedSecretDraft {
  headerName: string;
  secretEnv: string;
}

/**
 * 共享密钥通道(Headers JSON):恰好一条 {headerName: secretEnv}。留空表示未提供
 * (创建时视为缺密钥报错;编辑时保留现有引用)。
 */
function parseSharedSecretDraft(headers: string): ConnectorDraft<SharedSecretDraft | null> {
  const raw = headers.trim();
  if (!raw) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "errorHeadersShape" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "errorHeadersShape" };
  const entries = Object.entries(parsed);
  if (entries.length !== 1) return { ok: false, error: "errorHeadersShape" };
  const [headerName, secretValue] = entries[0]!;
  const secretEnv = typeof secretValue === "string" ? secretValue.trim() : "";
  if (!headerName.trim() || !secretEnv) return { ok: false, error: "errorHeadersShape" };
  // 前缀粗检挡住「把明文密钥当值填」的常见误用;租户 UUID 段由 API 层校验。
  if (!secretEnv.startsWith(SECRET_REF_PREFIX)) return { ok: false, error: "errorSecretPrefix" };
  return { ok: true, value: { headerName: headerName.trim(), secretEnv } };
}

interface OauthDraft {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

/**
 * user-oauth 客户端配置通道(oauth JSON,仅 JSON 模式可编辑):键名对齐原生
 * McpOAuthConfig(authorizeUrl/tokenUrl 为网关侧扩展键)。留空表示未提供
 * (创建时切不到 user-oauth;编辑时整组保留,绝不回显、不清空)。
 */
function parseOauthDraft(oauth: string | undefined): ConnectorDraft<OauthDraft | null> {
  const raw = oauth?.trim() ?? "";
  if (!raw) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "errorOauthFields" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "errorOauthFields" };
  const text = (key: string): string => {
    const value = parsed[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const draft: OauthDraft = {
    authorizeUrl: text("authorizeUrl"),
    tokenUrl: text("tokenUrl"),
    clientId: text("clientId"),
    clientSecret: text("clientSecret"),
    // 原生 oauth 对象的 scope 键;兼容 scopes。
    scopes: text("scope") || text("scopes"),
  };
  if (
    !draft.authorizeUrl.startsWith("https://") ||
    !draft.tokenUrl.startsWith("https://") ||
    !draft.clientId
  ) {
    return { ok: false, error: "errorOauthFields" };
  }
  return { ok: true, value: draft };
}

/** 网关分发的连接器恒为 http 形态(gateway-prepare 固定写 type: "http"),stdio/sse 无对应语义。 */
function rejectNonHttpType(form: McpFormState): ConnectorFormErrorKey | null {
  return form.type === "http" ? null : "errorTypeHttp";
}

/**
 * FormState → 创建载荷。原生表单只有一个名称字段,创建时同时充当 connectorKey 与
 * displayName(需满足 Key 字符集);认证二选一:Headers 密钥通道 → shared,
 * oauth 对象 → user-oauth。
 */
export function formToConnectorCreateInput(
  form: McpFormState,
): ConnectorDraft<TenantMcpConnectorInput> {
  const typeError = rejectNonHttpType(form);
  if (typeError) return { ok: false, error: typeError };
  const name = form.name.trim();
  if (!CONNECTOR_KEY_PATTERN.test(name)) return { ok: false, error: "errorKeyPattern" };
  const url = resolveUrlDraft(form.url, undefined);
  if (!url.ok) return url;
  const shared = parseSharedSecretDraft(form.headers);
  if (!shared.ok) return shared;
  const oauth = parseOauthDraft(form.oauth);
  if (!oauth.ok) return oauth;
  if (shared.value && oauth.value) return { ok: false, error: "errorAuthChannels" };
  if (oauth.value) {
    const client = oauth.value;
    return {
      ok: true,
      value: {
        connectorKey: name,
        displayName: name,
        url: url.value,
        authMode: "user-oauth",
        authorizeUrl: client.authorizeUrl,
        tokenUrl: client.tokenUrl,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        ...(client.scopes ? { scopes: client.scopes } : {}),
      },
    };
  }
  if (!shared.value) return { ok: false, error: "errorSecretRequired" };
  return {
    ok: true,
    value: {
      connectorKey: name,
      displayName: name,
      url: url.value,
      headerName: shared.value.headerName,
      secretEnv: shared.value.secretEnv,
    },
  };
}

/**
 * FormState → 更新载荷。名称映射 displayName(编辑态原生名称框仍可编辑,connectorKey
 * 本就不可改);URL 只在真的改过占位时下发;Headers/oauth 两个通道留空时完全不动
 * 认证字段,服务端保留密钥引用、OAuth 客户端配置与 clientSecret 密文。显式提供
 * 某一通道时同时下发 authMode,让 API 层按目标模式重新校验(等价旧表单始终提交
 * authMode 的语义;user-oauth → shared 的切换由服务端清除既有每用户授权)。
 */
export function formToConnectorPatch(
  form: McpFormState,
  prevServer: ZCodeMcpServer,
): ConnectorDraft<TenantMcpConnectorPatch> {
  const typeError = rejectNonHttpType(form);
  if (typeError) return { ok: false, error: typeError };
  const url = resolveUrlDraft(form.url, prevServer.config.url);
  if (!url.ok) return url;
  const shared = parseSharedSecretDraft(form.headers);
  if (!shared.ok) return shared;
  const oauth = parseOauthDraft(form.oauth);
  if (!oauth.ok) return oauth;
  if (shared.value && oauth.value) return { ok: false, error: "errorAuthChannels" };
  const patch: TenantMcpConnectorPatch = { displayName: form.name.trim() };
  if (url.value) patch.url = url.value;
  if (shared.value) {
    // 显式 shared + secretEnv:API 层会重新校验租户前缀引用(isTenantMcpSecretRef)。
    patch.authMode = "shared";
    patch.headerName = shared.value.headerName;
    patch.secretEnv = shared.value.secretEnv;
  } else if (oauth.value) {
    const client = oauth.value;
    patch.authMode = "user-oauth";
    patch.authorizeUrl = client.authorizeUrl;
    patch.tokenUrl = client.tokenUrl;
    patch.clientId = client.clientId;
    // 空 secret/空 scopes 不下发:前者保留现有密文(公共客户端可无 secret),
    // 后者避免空串清空既有 scope 串。
    if (client.clientSecret) patch.clientSecret = client.clientSecret;
    if (client.scopes) patch.scopes = client.scopes;
  }
  return { ok: true, value: patch };
}
