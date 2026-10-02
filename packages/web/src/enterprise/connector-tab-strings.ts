import { zh } from "./presentation.js";

/**
 * 连接器 tab 复用原生 McpServerList/McpServerForm 后的企业专属文案:表单页头、
 * 通道约定提示,以及 connector-form-adapter 映射失败时回显的本地校验文案。
 * 原生组件自带 i18n(行/表单控件文案走 useZCodeIntl),这里只收容 presentation.ts
 * 不存在的 key;已有 key 继续走传入的 t,不改 presentation.ts。
 */

/** 适配层错误 key(见 connector-form-adapter.ts):组件用 s[error] 回显,中英必须成对。 */
export interface ConnectorFormErrors {
  errorTypeHttp: string;
  errorKeyPattern: string;
  errorUrlHttps: string;
  errorHeadersShape: string;
  errorSecretPrefix: string;
  errorSecretRequired: string;
  errorOauthFields: string;
  errorAuthChannels: string;
}

// 与 presentation.ts 相同的写法:zh 推断出 key 集合,en 用 satisfies 对齐且不收窄为字面量。
// 错误文案单独立成 ConnectorFormErrors 类型对象再并入,避免 satisfies 触发多余属性检查。
const zhConnectorErrors: ConnectorFormErrors = {
  errorTypeHttp: "连接器仅支持 HTTP 类型;请把类型切回 HTTP。",
  errorKeyPattern: "名称即连接器 Key,仅限小写字母、数字与连字符,且以字母或数字开头。",
  errorUrlHttps: "Endpoint URL 需以 https:// 开头并位于租户允许清单内。",
  errorHeadersShape: 'Headers 需为恰好一条 {"Header 名称": "密钥环境变量名"} 的 JSON 对象。',
  errorSecretPrefix: "共享密钥的值需为 ZCODE_ENTERPRISE_MCP_SECRET_ 开头的环境变量名。",
  errorSecretRequired: "共享密钥连接器必须在 Headers 中提供密钥环境变量引用。",
  errorOauthFields: "oauth 对象需包含 https:// 的 authorizeUrl、tokenUrl 与非空 clientId。",
  errorAuthChannels: "Headers 密钥与 oauth 授权配置不能同时填写。",
};

const zhConnectorTabStrings = {
  listEmptyDescription: "连接器由网关统一鉴权与转发;启用后写入各专家运行时。",
  formCreateTitle: "新增连接器",
  formEditTitle: "编辑连接器",
  formCreateHint: "新建租户级 MCP 连接器;启用后写入各专家运行时。",
  formEditHint: "修改连接器配置;各专家运行时会在下次打开时更新。",
  editorModeFormLabel: "表单",
  editorModeJsonLabel: "JSON",
  /** 视图只回显端点主机名(完整 URL 不出服务端),表单里的 URL 是主机名占位而非事实。 */
  formUrlHostHint: "目录只回显端点主机名;未修改 URL 直接保存时保留当前地址。",
  /** 原生表单没有密钥引用字段,共享密钥经「Headers(可选)」JSON 通道携带。 */
  formSharedSecretHint:
    '共享密钥连接器:展开「Headers(可选)」填写单条 {"Header 名称": "ZCODE_ENTERPRISE_MCP_SECRET_… 环境变量名"};留空表示保留现有密钥引用。',
  /** 原生表单没有 OAuth 客户端字段,用户授权配置经 JSON 模式的 oauth 对象携带。 */
  formOauthJsonHint:
    "用户授权 (OAuth) 连接器:切换 JSON 模式,在配置中添加 oauth 对象(authorizeUrl/tokenUrl/clientId,可选 clientSecret 与 scope);已有配置不回显,留空即保留。",
  ...zhConnectorErrors,
};

export const connectorTabStrings = {
  zh: zhConnectorTabStrings,
  en: {
    listEmptyDescription:
      "Connectors are authenticated and proxied by the gateway; enabled connectors are written into expert runtimes.",
    formCreateTitle: "New connector",
    formEditTitle: "Edit connector",
    formCreateHint:
      "Create a tenant MCP connector; enabled connectors are written into expert runtimes.",
    formEditHint: "Update the connector; expert runtimes refresh on next open.",
    editorModeFormLabel: "Form",
    editorModeJsonLabel: "JSON",
    formUrlHostHint:
      "The catalog only echoes the endpoint host; saving without editing the URL keeps the current address.",
    formSharedSecretHint:
      'Shared-secret connectors: expand "Headers (optional)" and provide one entry {"header name": "ZCODE_ENTERPRISE_MCP_SECRET_… environment variable name"}; leave blank to keep the current secret reference.',
    formOauthJsonHint:
      "User-authorized (OAuth) connectors: switch to JSON mode and add an oauth object (authorizeUrl/tokenUrl/clientId, optional clientSecret and scope); stored values are never echoed — leave blank to keep them.",
    errorTypeHttp: "Connectors only support the HTTP type; switch the type back to HTTP.",
    errorKeyPattern:
      "The name doubles as the connector key: lowercase letters, digits and hyphens only, starting with a letter or digit.",
    errorUrlHttps: "The endpoint URL must start with https:// and be in the tenant allowlist.",
    errorHeadersShape:
      'Headers must be a JSON object with exactly one entry {"header name": "secret environment variable name"}.',
    errorSecretPrefix:
      "The shared secret value must be an environment variable name starting with ZCODE_ENTERPRISE_MCP_SECRET_.",
    errorSecretRequired:
      "A shared-secret connector requires the secret environment variable reference in Headers.",
    errorOauthFields:
      "The oauth object needs https:// authorizeUrl and tokenUrl plus a non-empty clientId.",
    errorAuthChannels: "Provide either the Headers secret or the oauth configuration, not both.",
  } satisfies Record<keyof typeof zhConnectorTabStrings, string>,
};

export type ConnectorTabStrings = typeof zhConnectorTabStrings;

/**
 * EnterpriseApp 只会把 presentation.ts 的 zh/en 之一作为 t 传下来,
 * 按引用即可判定语言,不引入第二套 locale 探测。
 */
export function resolveConnectorTabStrings(t: typeof zh): ConnectorTabStrings {
  return t === zh ? connectorTabStrings.zh : connectorTabStrings.en;
}
