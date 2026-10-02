import { zh } from "./presentation.js";

/**
 * 连接器 tab 对齐原生 MCP 表单后新增的企业文案。原生 @zcode/ui 组件自带 i18n,
 * 这里只收容 presentation.ts 尚不存在的 key;已有 key 继续走传入的 t,不改 presentation.ts。
 */
// 与 presentation.ts 相同的写法:zh 推断出 key 集合,en 用 satisfies 对齐且不收窄为字面量。
const zhConnectorTabStrings = {
  formCreateTitle: "新增连接器",
  formEditTitle: "编辑连接器",
  formCreateHint: "新建租户级 MCP 连接器;启用后写入各专家运行时。",
  formEditHint: "修改连接器配置;各专家运行时会在下次打开时更新。",
  urlKeepHint: "编辑时留空表示保留当前地址。",
  secretEnvKeepHint: "编辑时留空表示保留当前密钥引用。",
};

export const connectorTabStrings = {
  zh: zhConnectorTabStrings,
  en: {
    formCreateTitle: "New connector",
    formEditTitle: "Edit connector",
    formCreateHint:
      "Create a tenant MCP connector; enabled connectors are written into expert runtimes.",
    formEditHint: "Update the connector; expert runtimes refresh on next open.",
    urlKeepHint: "Leave blank while editing to keep the current URL.",
    secretEnvKeepHint: "Leave blank while editing to keep the current secret reference.",
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
