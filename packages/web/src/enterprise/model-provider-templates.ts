import type { ProviderSettingsTemplateView } from "@zcode/ui";
import type { ModelApiType } from "./api.js";

/**
 * 企业租户模型目录的新建模板(精选自官方内置 catalog 的 api-key 模板;
 * zcode-builtin.json 是运行时磁盘数据,浏览器侧无法静态取得,故企业侧维护这份清单)。
 * 原生 ProviderTemplatePicker 只读取 templateId 与 templateNameMap,
 * 预填字段(apiType/baseUrl/models)由本清单按 templateId 提供。
 * 升级提示:跟随官方内置 catalog 变化同步维护。
 */
export interface EnterpriseProviderTemplate {
  templateId: string;
  nameZh: string;
  nameEn: string;
  apiType: ModelApiType;
  baseUrl: string;
  models: string[];
  apiKeyManagementUrl?: string;
}

/**
 * 模型清单以 CSV 常量承载:oxfmt 会把超长数组字面量逐行展开,18 个模板的全量清单
 * 展开后超过仓库 max-lines(400) 上限;字符串字面量不会被展开,清单内容与
 * ENTERPRISE_PROVIDER_TEMPLATES 的导出形状(models: string[])保持不变。
 */
function csvModels(csv: string): string[] {
  return csv
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export const ENTERPRISE_PROVIDER_TEMPLATES: EnterpriseProviderTemplate[] = [
  {
    templateId: "zai-standard-api",
    nameZh: "Z.ai API",
    nameEn: "Z.ai API",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: csvModels(
      "GLM-5.3, GLM-5.3-Flash, GLM-5V-Turbo, GLM-5.1, GLM-5.1-Highspeed, GLM-5, GLM-5-Turbo, GLM-4.7, GLM-4.7-FlashX, GLM-4.7-Flash, GLM-4.6, GLM-4.5-Air, GLM-4.5, GLM-4.6V, GLM-4.6V-Flash, GLM-4.6V-FlashX, GLM-4.1V-Thinking-FlashX, GLM-4.1V-Thinking-Flash, GLM-4-FlashX-250414, GLM-4-Flash-250414, GLM-4V-Flash, codegeex-4, charglm-4, emohaa",
    ),
    apiKeyManagementUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    templateId: "bigmodel-standard-api",
    nameZh: "BigModel API",
    nameEn: "BigModel API",
    apiType: "openai-chat-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: csvModels(
      "GLM-5.3, GLM-5.3-Flash, GLM-5V-Turbo, GLM-5.1, GLM-5.1-Highspeed, GLM-5, GLM-5-Turbo, GLM-4.7, GLM-4.7-FlashX, GLM-4.7-Flash, GLM-4.6, GLM-4.5-Air, GLM-4.5, GLM-4.6V, GLM-4.6V-Flash, GLM-4.6V-FlashX, GLM-4.1V-Thinking-FlashX, GLM-4.1V-Thinking-Flash, GLM-4-FlashX-250414, GLM-4-Flash-250414, GLM-4V-Flash, codegeex-4, charglm-4, emohaa",
    ),
    apiKeyManagementUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    templateId: "moonshot-kimi",
    nameZh: "Kimi",
    nameEn: "Kimi",
    apiType: "anthropic-messages",
    baseUrl: "https://api.moonshot.cn/anthropic",
    models: csvModels("kimi-k3, kimi-k2.7-code, kimi-k2.6, kimi-k2.7-code-highspeed, k3, k3-256k"),
    apiKeyManagementUrl: "https://platform.kimi.com/console/api-keys",
  },
  {
    templateId: "minimax",
    nameZh: "MiniMax",
    nameEn: "MiniMax",
    apiType: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    models: csvModels(
      "MiniMax-M3, MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5, MiniMax-M2.5-highspeed, MiniMax-M2.1, MiniMax-M2.1-highspeed, MiniMax-M2",
    ),
    apiKeyManagementUrl: "https://platform.minimaxi.com/console/access?tab=api-keys",
  },
  {
    templateId: "deepseek",
    nameZh: "DeepSeek",
    nameEn: "DeepSeek",
    apiType: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    models: csvModels("deepseek-flash, deepseek-v4-pro"),
    apiKeyManagementUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    templateId: "qwen-alibaba-model-studio-cn",
    nameZh: "阿里云百炼（中国）",
    nameEn: "Alibaba Cloud (China)",
    apiType: "anthropic-messages",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    models: csvModels(
      "qwen3.8-max, qwen3.8-flash, qwen3.7-max, qwen3.7-plus, qwen3.7-flash, qwen3.6-plus, qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen-plus, qwen-flash, qwen3-vl-plus",
    ),
    apiKeyManagementUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=model",
  },
  {
    templateId: "qwen-alibaba-model-studio-intl",
    nameZh: "阿里云百炼（国际）",
    nameEn: "Alibaba Cloud (Global)",
    apiType: "openai-chat-completions",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: csvModels(
      "qwen3.8-max, qwen3.8-flash, qwen3.8-omni-flash, qwen3.7-max, qwen3.7-plus, qwen3.7-flash, qwen3.6-plus, qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen-plus, qwen-flash, qwen3-vl-plus",
    ),
    apiKeyManagementUrl: "https://modelstudio.console.aliyun.com/ap-southeast-1?tab=dashboard",
  },
  {
    templateId: "xiaomi-mimo",
    nameZh: "Xiaomi MiMo",
    nameEn: "Xiaomi MiMo",
    apiType: "anthropic-messages",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    models: csvModels("mimo-v2.5-pro, mimo-v2.5"),
    apiKeyManagementUrl: "https://platform.xiaomimimo.com/",
  },
  {
    templateId: "openai",
    nameZh: "OpenAI",
    nameEn: "OpenAI",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.openai.com/v1",
    models: csvModels(
      "gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.6, gpt-5.4, gpt-5.4-pro, gpt-5.4-mini, gpt-5.4-nano, gpt-5.3-codex",
    ),
    apiKeyManagementUrl: "https://platform.openai.com/api-keys",
  },
  {
    templateId: "anthropic",
    nameZh: "Anthropic",
    nameEn: "Anthropic",
    apiType: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    models: csvModels(
      "claude-fable-5-1, claude-fable-5, claude-opus-5, claude-sonnet-5, claude-haiku-4-5-20251001",
    ),
    apiKeyManagementUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    templateId: "xai",
    nameZh: "xAI",
    nameEn: "xAI",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.x.ai/v1",
    models: csvModels("grok-4.6, grok-build-0.1, grok-4.3"),
    apiKeyManagementUrl: "https://console.x.ai",
  },
  {
    templateId: "openrouter",
    nameZh: "OpenRouter",
    nameEn: "OpenRouter",
    apiType: "anthropic-messages",
    baseUrl: "https://openrouter.ai/api",
    models: csvModels(
      "anthropic/claude-fable-5.1, openai/gpt-6-astra, openai/gpt-5.6-sol, anthropic/claude-opus-5, deepseek/deepseek-v4-pro, moonshotai/kimi-k3, z-ai/glm-5.3, qwen/qwen3.8-max, minimax/minimax-m3, xiaomi/mimo-v2.5-pro, x-ai/grok-4.6, deepseek/deepseek-v4.1-flash, qwen/qwen3.8-max-0902, openai/gpt-5.6-terra, openai/gpt-5.6-luna, openai/gpt-5.6, openai/gpt-5.4, openai/gpt-5.4-pro, openai/gpt-5.4-mini, openai/gpt-5.4-nano, openai/gpt-5.3-codex, anthropic/claude-sonnet-5, anthropic/claude-haiku-4.5, anthropic/claude-opus-4.8, anthropic/claude-opus-4.7, anthropic/claude-opus-4.6, anthropic/claude-opus-4.5, anthropic/claude-sonnet-4.6, anthropic/claude-sonnet-4.5, deepseek/deepseek-v4-flash, moonshotai/kimi-k2.7-code, moonshotai/kimi-k2.6, moonshotai/kimi-k2.5, z-ai/glm-5.3-flash, z-ai/glm-5.2, z-ai/glm-5.1, z-ai/glm-5v-turbo, z-ai/glm-5, z-ai/glm-5-turbo, z-ai/glm-4.7, z-ai/glm-4.7-flash, z-ai/glm-4.6, z-ai/glm-4.6v, z-ai/glm-4.5-air, z-ai/glm-4.5, qwen/qwen3.8-flash, qwen/qwen3.7-max, qwen/qwen3.7-plus, qwen/qwen3.7-flash, qwen/qwen3.6-plus, qwen/qwen3.6-flash, qwen/qwen3.5-plus-20260420, qwen/qwen3-vl-plus, qwen/qwen3-vl-flash, minimax/minimax-m2.7, minimax/minimax-m2.5, xiaomi/mimo-v2.5, x-ai/grok-build-0.1, x-ai/grok-4.3",
    ),
    apiKeyManagementUrl: "https://openrouter.ai/keys",
  },
  {
    templateId: "opencode-go-chat",
    nameZh: "OpenCode Go (Chat)",
    nameEn: "OpenCode Go (Chat)",
    apiType: "openai-chat-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: csvModels(
      "glm-5.3-flash, glm-5.3, kimi-k3, kimi-k2.7-code, deepseek-v4.1-flash, deepseek-v4-pro, mimo-v2.5, mimo-v2.5-pro, glm-5.2, glm-5.1, kimi-k2.6, deepseek-v4-flash, deepseek-v4-flash-vision-exp, hy4-preview, hy3",
    ),
    apiKeyManagementUrl: "https://opencode.ai/auth",
  },
  {
    templateId: "opencode-go-messages",
    nameZh: "OpenCode Go (Anthropic)",
    nameEn: "OpenCode Go (Anthropic)",
    apiType: "anthropic-messages",
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: csvModels(
      "minimax-m3, qwen3.8-max, qwen3.8-flash, minimax-m2.7, minimax-m2.5, qwen3.7-max, qwen3.7-plus, qwen3.6-plus",
    ),
    apiKeyManagementUrl: "https://opencode.ai/auth",
  },
  {
    templateId: "opencode-go-responses",
    nameZh: "OpenCode Go (Responses)",
    nameEn: "OpenCode Go (Responses)",
    apiType: "openai-chat-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: csvModels("gpt-5.6-luna, grok-4.6"),
    apiKeyManagementUrl: "https://opencode.ai/auth",
  },
  {
    templateId: "opencode-zen-responses",
    nameZh: "OpenCode Zen (Responses)",
    nameEn: "OpenCode Zen (Responses)",
    apiType: "openai-chat-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    models: csvModels(
      "gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-pro, gpt-5.4-mini, gpt-5.4-nano, gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.2, gpt-5.1",
    ),
    apiKeyManagementUrl: "https://opencode.ai/auth",
  },
  {
    templateId: "opencode-zen-messages",
    nameZh: "OpenCode Zen (Anthropic)",
    nameEn: "OpenCode Zen (Anthropic)",
    apiType: "anthropic-messages",
    baseUrl: "https://opencode.ai/zen/v1",
    models: csvModels(
      "claude-fable-5-1, claude-fable-5, qwen3.7-max, qwen3.6-plus, qwen3.5-plus, claude-opus-5, claude-sonnet-5, claude-haiku-4-5, claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-opus-4-5, claude-sonnet-4-6, claude-sonnet-4-5, qwen3.7-plus",
    ),
    apiKeyManagementUrl: "https://opencode.ai/auth",
  },
  {
    templateId: "opencode-zen-chat",
    nameZh: "OpenCode Zen (Chat)",
    nameEn: "OpenCode Zen (Chat)",
    apiType: "openai-chat-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    models: csvModels(
      "kimi-k3, minimax-m3, deepseek-v4-pro, glm-5.2, big-pickle, mimo-v2.5-free, hy3-free, ling-3.0-flash-fin-free, nemotron-3-ultra-free, muse-spark-1.2-contributor-free, minimax-m2.7, deepseek-v4-flash, glm-5.1, nemotron-3.5-lightning-free",
    ),
    apiKeyManagementUrl: "https://opencode.ai/auth",
  },
];

/** 喂给原生 ProviderTemplatePicker 的视图:config 不被选择器消费,留空对象即可。 */
export function enterprisePickerTemplates(): ProviderSettingsTemplateView[] {
  return ENTERPRISE_PROVIDER_TEMPLATES.map((template) => ({
    templateId: template.templateId,
    templateNameMap: { "zh-CN": template.nameZh, "en-US": template.nameEn },
    config: {},
  }));
}

/** 按模板 id 取预填字段;未收录的 id 返回 null(走自定义表单)。 */
export function enterpriseTemplatePrefill(templateId: string): EnterpriseProviderTemplate | null {
  return ENTERPRISE_PROVIDER_TEMPLATES.find((item) => item.templateId === templateId) ?? null;
}
