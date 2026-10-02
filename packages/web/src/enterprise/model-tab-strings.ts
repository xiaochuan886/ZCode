/**
 * 企业设置「模型」tab 换用原生展示组件后的自有新文案。
 * 既有 key 继续走 presentation.ts 的 t;只有原生组件没有覆盖的新增文案放这里,
 * 组件里按 t === zh 选取语言,避免改动 presentation.ts(它同时服务其他 tab)。
 */
const zhStrings = {
  /** 从模板预填后提示用户剩余动作:只需要补齐 API Key。 */
  templatePrefillHint: "已按模板预填基本信息，补充 API Key 后保存。",
  /** 模板自带控制台地址时展示的「获取 API Key」链接文案。 */
  getApiKeyLink: "获取 API Key",
  /** 左侧导航分组标题:企业域只有一种供应商——租户目录里的自定义供应商。 */
  navGroupTitle: "租户供应商",
  /** 详情区空态(目录为空或未选中)的引导文案。 */
  emptyDetailHint: "从左侧选择一个供应商，或点击「新增供应商」开始配置。",
  /** 目录级操作失败时兜底横幅的标题(卡片内置横幅在企业浮层不可见,见适配层注释)。 */
  catalogErrorTitle: "操作失败",
  /** 连接测试后发现目录模型 id 与上游大小写不一致的提示。 */
  modelIdCaseFixHint:
    "检测到 {count} 个模型 id 与上游大小写不一致（如 {sample}）。模板清单是官方展示形态，上游 API 以其 /models 返回为准，不修正会导致调用 404。",
  /** 一键按上游清单修正模型 id 的按钮文案。 */
  modelIdCaseFixAction: "按上游修正模型 id",
  /** Anthropic 协议与 Base URL 形态不匹配的警示。 */
  anthropicUrlWarning:
    "当前协议为 Anthropic Messages，但 Base URL 不含 anthropic 端点。多数供应商的 Anthropic 兼容端点是独立地址（如 …/anthropic），协议与地址不匹配时请求会 404。",
};

const enStrings: typeof zhStrings = {
  templatePrefillHint: "Prefilled from the template — add your API key and save.",
  getApiKeyLink: "Get an API key",
  navGroupTitle: "Tenant providers",
  emptyDetailHint: "Select a provider on the left, or click “New provider” to add one.",
  catalogErrorTitle: "Action failed",
  modelIdCaseFixHint:
    "{count} model id(s) differ from the upstream list by case (e.g. {sample}). Template lists use the official display form; the upstream /models response is authoritative — calls will 404 until fixed.",
  modelIdCaseFixAction: "Fix model ids from upstream",
  anthropicUrlWarning:
    "Protocol is Anthropic Messages but the base URL has no anthropic endpoint path. Most providers expose a dedicated Anthropic-compatible address (e.g. …/anthropic); a protocol/URL mismatch returns 404.",
};

export const modelTabStrings = { zh: zhStrings, en: enStrings };
export type ModelTabStrings = typeof zhStrings;
