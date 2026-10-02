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
};

const enStrings: typeof zhStrings = {
  templatePrefillHint: "Prefilled from the template — add your API key and save.",
  getApiKeyLink: "Get an API key",
  navGroupTitle: "Tenant providers",
  emptyDetailHint: "Select a provider on the left, or click “New provider” to add one.",
  catalogErrorTitle: "Action failed",
};

export const modelTabStrings = { zh: zhStrings, en: enStrings };
export type ModelTabStrings = typeof zhStrings;
