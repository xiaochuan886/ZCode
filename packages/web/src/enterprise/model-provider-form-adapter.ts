import type { ComponentProps } from "react";
import {
  InlineEditableProviderCard,
  ServiceProvider,
  type ProviderSettingsFormModel,
  type ProviderSettingsFormProvider,
} from "@zcode/ui";
import type { EnterpriseModelMetadata, ModelProviderPatch, ModelProviderView } from "./api.js";
import { ENTERPRISE_PROVIDER_TEMPLATES } from "./model-provider-templates.js";

/**
 * 企业模型 tab 的适配层:网关目录行(ModelProviderView) ↔ 原生表单形态
 * (ProviderSettingsFormProvider / ProviderSettingsFormModel)的双向映射,
 * 以及 InlineEditableProviderCard 每个模型回调 → 目录 PATCH 的路由。
 *
 * 元数据策略:企业目录是浏览器侧唯一的元数据事实(专家 runtime 用自己的内置
 * 规则另行解析,分发只依赖 id 与 enabled)。因此「推荐基线」由模板清单(官方
 * modelConfigRules 离线烘焙)按模型 id 精确匹配 + 官方默认 `.*` 规则兜底构成;
 * 保存时把「推荐基线 + 个人覆盖」的合成结果整条烘焙进目录,徽标数据不回退。
 */

type CardProps = ComponentProps<typeof InlineEditableProviderCard>;
/** 网关客户端的最小结构面:适配层只做 update;create/delete/test 由 Settings 直接调用。 */
export interface EnterpriseCardGateway {
  updateModelProvider: (
    id: string,
    patch: ModelProviderPatch,
    token: string | null,
  ) => Promise<unknown>;
}
type PersonalModelConfig = ProviderSettingsFormModel["personalConfig"];
type ModelProperties = NonNullable<PersonalModelConfig["properties"]>;
type ServiceProviderServices = ComponentProps<typeof ServiceProvider>["services"];
type ResolveModelConfigInput = Parameters<
  NonNullable<ServiceProviderServices["providerSettingsService"]["resolveModelConfig"]>
>[0];
type ModelConfigResolution = Awaited<
  ReturnType<NonNullable<ServiceProviderServices["providerSettingsService"]["resolveModelConfig"]>>
>;

/** 模板 baseUrl 与供应商 baseUrl 是否同源(按 host 比较,容忍路径差异)。 */
function sameTemplateOrigin(templateBaseUrl: string, providerBaseUrl: string): boolean {
  try {
    return new URL(templateBaseUrl).host === new URL(providerBaseUrl).host;
  } catch {
    return templateBaseUrl === providerBaseUrl;
  }
}

/**
 * 模板清单按模型 id 匹配,匹配次序 = 同 baseUrl 模板(精确 → 大小写不敏感)→
 * 全部模板(精确 → 大小写不敏感)。裸 id 全局匹配会跨供应商串值:同名模型在
 * 聚合类模板(如 opencode)的站点值与官方直连值不同(例:glm-5.3-flash 在
 * opencode 为 1M 上下文,在 bigmodel 直连为 200K),必须先锁定同源模板。
 */
function templateMetadataFor(modelId: string, baseUrl?: string): EnterpriseModelMetadata | null {
  const scopes = baseUrl
    ? [
        ENTERPRISE_PROVIDER_TEMPLATES.filter((template) =>
          sameTemplateOrigin(template.baseUrl, baseUrl),
        ),
        ENTERPRISE_PROVIDER_TEMPLATES,
      ]
    : [ENTERPRISE_PROVIDER_TEMPLATES];
  for (const scope of scopes) {
    const exact = scope
      .map((template) => template.models.find((model) => model.id === modelId))
      .find(Boolean);
    if (exact) return exact;
    const loose = scope
      .map((template) =>
        template.models.find((model) => model.id.toLowerCase() === modelId.toLowerCase()),
      )
      .find(Boolean);
    if (loose) return loose;
  }
  return null;
}

/** 官方内置 catalog 默认 `.*` 规则(config/provider/zcode-builtin.json modelRules[0])。 */
const DEFAULT_REASONING_LEVEL = { values: ["disabled", "enabled"] as readonly string[], map: "{}" };

function recommendedModelConfig(modelId: string, baseUrl?: string): PersonalModelConfig {
  const meta = templateMetadataFor(modelId, baseUrl);
  return {
    enabled: true,
    properties: {
      contextWindow: meta?.contextWindow ?? 200000,
      inputFormat: {
        supportsText: true,
        supportsImage: meta?.inputFormat?.supportsImage ?? false,
        supportsVideo: meta?.inputFormat?.supportsVideo ?? false,
        supportsAudio: meta?.inputFormat?.supportsAudio ?? false,
        supportsPdf: meta?.inputFormat?.supportsPdf ?? false,
      },
      outputFormat: { supportsText: meta?.outputFormat?.supportsText ?? true },
      supportsToolCall: meta?.supportsToolCall ?? true,
      supportsJsonSchemaOutput: meta?.supportsJsonSchemaOutput ?? false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
      requiresMfjsToolSchema: false,
    },
    // 官方规则的参数规格(推理等级 values/map、最大输出)已烘焙进模板:同源模板的
    // 真实规格优先,模板缺失才回落默认 .* 规则——编辑弹窗默认值与原生一致。
    optionSpecs: {
      maxOutputTokens: meta?.optionSpecs?.maxOutputTokens ?? { max: 32000 },
      reasoningLevel: meta?.optionSpecs?.reasoningLevel ?? DEFAULT_REASONING_LEVEL,
    },
  };
}

/** 个人草稿只携带稀疏覆盖(manual-model-config 的可编辑叶子),按叶子合成有效配置。 */
function overlayModelConfig(
  base: PersonalModelConfig,
  overlay: PersonalModelConfig | undefined,
): PersonalModelConfig {
  if (!overlay) return base;
  return {
    ...base,
    ...overlay,
    properties: {
      ...base.properties,
      ...overlay.properties,
      inputFormat: {
        ...base.properties?.inputFormat,
        ...overlay.properties?.inputFormat,
      },
    } as ModelProperties,
    optionSpecs: {
      ...base.optionSpecs,
      ...overlay.optionSpecs,
      reasoningLevel: {
        ...base.optionSpecs?.reasoningLevel,
        ...overlay.optionSpecs?.reasoningLevel,
      },
      maxOutputTokens: {
        ...base.optionSpecs?.maxOutputTokens,
        ...overlay.optionSpecs?.maxOutputTokens,
      },
    },
  };
}

/**
 * 目录条目 → 原生模型行。config 与 personalConfig 同源:企业目录里的元数据就是
 * 管理员的显式配置(浏览器侧没有 builtin 基线),徽标读 config、编辑弹窗读 personalConfig。
 * 迁移而来的存量行(v10 前的纯 id)没有元数据:用同源模板的推荐基线补齐展示,
 * 否则行徽标会显示 "Context window: 0";管理员一旦保存,合成结果整条烘焙回目录。
 */
function catalogModelToFormModel(
  entry: EnterpriseModelMetadata,
  baseUrl: string,
): ProviderSettingsFormModel {
  const baseline = recommendedModelConfig(entry.id, baseUrl);
  // 目录值优先、缺失叶子由推荐基线补齐:原生每次编辑都跑规则引擎,等价做法是
  // 让每个模型行(含旧模板创建、只存了部分元数据的存量行)都带上同源模板的
  // 默认参数规格——否则弹窗的推理等级/参数映射/最大输出是空的,需要手填。
  // personalConfig 是编辑弹窗的真实输入源,必须完整;保存时整条烘焙回目录。
  const config: PersonalModelConfig = {
    ...baseline,
    ...(entry.enabled === false ? { enabled: false } : {}),
    properties: {
      ...baseline.properties,
      ...(entry.contextWindow != null ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.inputFormat != null ? { inputFormat: entry.inputFormat } : {}),
      ...(entry.outputFormat != null ? { outputFormat: entry.outputFormat } : {}),
      ...(entry.supportsToolCall != null ? { supportsToolCall: entry.supportsToolCall } : {}),
      ...(entry.supportsJsonSchemaOutput != null
        ? { supportsJsonSchemaOutput: entry.supportsJsonSchemaOutput }
        : {}),
    },
    optionSpecs: entry.optionSpecs ?? baseline.optionSpecs,
  };
  return {
    kind: "candidate",
    modelId: entry.id,
    builtin: false,
    personalConfig: config,
    useRecommendedConfig: true,
    config,
    hasPersonalConfig: true,
    executable: entry.enabled !== false,
    selectable: entry.enabled !== false,
  };
}

export function providerViewToFormProvider(view: ModelProviderView): ProviderSettingsFormProvider {
  return {
    providerId: view.id,
    providerName: view.displayName,
    enabled: view.enabled,
    // 网关目录必然带 baseUrl 与密钥密文,启用即可用;状态点只消费 enabled/executable。
    executable: view.enabled && view.baseUrl.trim() !== "",
    hasPersonalConfig: true,
    personalConfig: {},
    config: {
      api: { type: view.apiType, baseUrl: view.baseUrl },
      // 后端只回 last4,密钥框初始为空表示「不改密钥」;输入新值才随保存下发。
      access: { type: "api-key" },
    },
    models: view.models.map((entry) => catalogModelToFormModel(entry, view.baseUrl)),
  };
}

/**
 * onSave(config) 的目录映射:卡片传入的 config 是「连接草稿合成后的完整形态」,
 * 与目录基线逐叶对比后才下发;密钥只在草稿真正改过(非空)时下发,服务端保留密文。
 */
export function providerDraftToPatch(
  view: ModelProviderView,
  next: ProviderSettingsFormProvider,
): ModelProviderPatch {
  const access = next.config.access;
  const apiKey = access && "apiKey" in access ? access.apiKey : undefined;
  const api = next.config.api;
  return {
    ...(next.providerNameUpdate && next.providerNameUpdate !== view.displayName
      ? { displayName: next.providerNameUpdate }
      : {}),
    ...(api?.type && api.type !== view.apiType ? { apiType: api.type } : {}),
    ...(api?.baseUrl && api.baseUrl !== view.baseUrl ? { baseUrl: api.baseUrl } : {}),
    ...(apiKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(next.enabledUpdate !== undefined ? { enabled: next.enabledUpdate } : {}),
  };
}

/** 原生 optionSpecs(readonly/可空)→ 目录存储形状(无空值、可变数组)。 */
function normalizeOptionSpecs(
  specs:
    | PersonalModelConfig["optionSpecs"]
    | EnterpriseModelMetadata["optionSpecs"]
    | null
    | undefined,
): EnterpriseModelMetadata["optionSpecs"] | undefined {
  if (!specs) return undefined;
  const out: EnterpriseModelMetadata["optionSpecs"] = {};
  if (specs.maxOutputTokens) {
    const { max, map } = specs.maxOutputTokens;
    if (max != null || map != null)
      out.maxOutputTokens = {
        ...(max != null ? { max } : {}),
        ...(map != null ? { map } : {}),
      };
  }
  if (specs.reasoningLevel) {
    const { values, map } = specs.reasoningLevel;
    if ((values != null && values.length > 0) || map != null)
      out.reasoningLevel = {
        ...(values != null && values.length > 0 ? { values: [...values] } : {}),
        ...(map != null ? { map } : {}),
      };
  }
  return out.maxOutputTokens != null || out.reasoningLevel != null ? out : undefined;
}

/**
 * 模型草稿(推荐基线 + 稀疏个人覆盖)→ 目录元数据条目。
 * 编辑弹窗不可编辑的叶子(outputFormat/supportsToolCall、输入格式的 text/audio)
 * 优先保留目录旧值、其次推荐基线;可编辑叶子取合成有效值。
 */
function catalogEntryFromDraft(params: {
  modelId: string;
  personalConfig: PersonalModelConfig;
  preserved?: EnterpriseModelMetadata;
  /** 供应商 baseUrl:推荐基线优先取同源模板的元数据,避免跨供应商串值。 */
  baseUrl?: string;
}): EnterpriseModelMetadata {
  const { modelId, personalConfig, preserved, baseUrl } = params;
  const recommended = recommendedModelConfig(modelId, baseUrl);
  const effective = overlayModelConfig(recommended, personalConfig);
  const props = effective.properties;
  const rec = recommended.properties;
  const input = personalConfig.properties?.inputFormat;
  const toolCall = preserved?.supportsToolCall ?? rec?.supportsToolCall;
  // 参数规格不在弹窗可编辑范围:目录旧值优先,否则用推荐基线烘焙(原生同源规则)。
  const optionSpecs = normalizeOptionSpecs(preserved?.optionSpecs ?? effective.optionSpecs);
  const jsonSchema = props?.supportsJsonSchemaOutput ?? rec?.supportsJsonSchemaOutput;
  // 目录 outputFormat 是完整形状(仅 supportsText),推荐基线的稀疏值在此归一。
  const outputText =
    preserved?.outputFormat?.supportsText ?? rec?.outputFormat?.supportsText ?? undefined;
  return {
    id: modelId,
    ...(effective.enabled === false ? { enabled: false } : {}),
    ...(props?.contextWindow != null ? { contextWindow: props.contextWindow } : {}),
    ...(outputText != null ? { outputFormat: { supportsText: outputText } } : {}),
    inputFormat: {
      supportsText: true,
      supportsImage:
        input?.supportsImage ??
        rec?.inputFormat?.supportsImage ??
        preserved?.inputFormat?.supportsImage ??
        false,
      supportsVideo:
        input?.supportsVideo ??
        rec?.inputFormat?.supportsVideo ??
        preserved?.inputFormat?.supportsVideo ??
        false,
      supportsPdf:
        input?.supportsPdf ??
        rec?.inputFormat?.supportsPdf ??
        preserved?.inputFormat?.supportsPdf ??
        false,
      // audio 与 text 一样不经弹窗编辑:目录旧值优先于推荐基线(?? 不会穿透 false)。
      supportsAudio:
        preserved?.inputFormat?.supportsAudio ?? rec?.inputFormat?.supportsAudio ?? false,
    },
    ...(toolCall != null ? { supportsToolCall: toolCall } : {}),
    ...(jsonSchema != null ? { supportsJsonSchemaOutput: jsonSchema } : {}),
    ...(optionSpecs != null &&
    (optionSpecs.maxOutputTokens != null || optionSpecs.reasoningLevel != null)
      ? { optionSpecs }
      : {}),
  };
}

/** 服务端 enabled 约定:只有显式 false 才落键;启用时移除键以保持存储形状一致。 */
function withEnabled(entry: EnterpriseModelMetadata, enabled: boolean): EnterpriseModelMetadata {
  if (!enabled) return { ...entry, enabled: false };
  const { enabled: _omit, ...rest } = entry;
  return rest;
}

/**
 * 构造 models PATCH 的兜底 defaultModel:服务端 resolveModels 对「默认模型不在
 * 新列表且非空」直接 400(并非静默回退),因此改名/删除默认模型时前端必须显式
 * 重定向默认模型——改名跟随新 id(redirect),删除回落到新列表首项。
 */
function modelsPatchFor(
  view: ModelProviderView,
  models: EnterpriseModelMetadata[],
  redirect?: string,
): ModelProviderPatch {
  const current = view.defaultModel ?? "";
  const ids = models.map((entry) => entry.id);
  if (!current || ids.includes(current)) return { models };
  const fallback = redirect && ids.includes(redirect) ? redirect : (ids[0] ?? "");
  if (!fallback) return { models };
  return { models, defaultModel: fallback };
}

/** InlineEditableProviderCard 的模型回调族:全部收敛为「基于当前目录行的 models PATCH」。 */
export interface EnterpriseCardCallbacks {
  onSave: CardProps["onSave"];
  onAddPersonalModel: NonNullable<CardProps["onAddPersonalModel"]>;
  onSavePersonalModelDraft: NonNullable<CardProps["onSavePersonalModelDraft"]>;
  onSetPersonalModelEnabled: NonNullable<CardProps["onSetPersonalModelEnabled"]>;
  onDeletePersonalModel: NonNullable<CardProps["onDeletePersonalModel"]>;
  onReorderModelIds: NonNullable<CardProps["onReorderModelIds"]>;
}

export function createEnterpriseCardCallbacks(params: {
  view: ModelProviderView;
  gateway: EnterpriseCardGateway;
  csrfToken: string | null;
  reload: () => void;
}): EnterpriseCardCallbacks {
  const { view, gateway, csrfToken, reload } = params;
  // 失败必须 reject:卡片自身的失败横幅/重试账本依赖回调抛错;同时重读目录恢复事实。
  async function patchCatalog(patch: ModelProviderPatch): Promise<void> {
    try {
      await gateway.updateModelProvider(view.id, patch, csrfToken);
    } catch (cause) {
      reload();
      throw cause;
    }
    reload();
  }
  return {
    onSave: (config) => patchCatalog(providerDraftToPatch(view, config)),
    onAddPersonalModel: async (_providerId, modelId, config) => {
      const entry = catalogEntryFromDraft({
        modelId,
        personalConfig: config,
        baseUrl: view.baseUrl,
      });
      await patchCatalog(modelsPatchFor(view, [...view.models, entry]));
    },
    onSavePersonalModelDraft: async (input) => {
      const preserved = view.models.find((entry) => entry.id === input.originalModelId);
      const entry = catalogEntryFromDraft({
        modelId: input.nextModelId,
        personalConfig: input.personalConfig,
        ...(preserved ? { preserved } : {}),
        baseUrl: view.baseUrl,
      });
      const models = view.models.map((item) => (item.id === input.originalModelId ? entry : item));
      await patchCatalog(modelsPatchFor(view, models, input.nextModelId));
    },
    onSetPersonalModelEnabled: async (_providerId, modelId, enabled) => {
      const models = view.models.map((entry) =>
        entry.id === modelId ? withEnabled(entry, enabled) : entry,
      );
      await patchCatalog(modelsPatchFor(view, models));
    },
    onDeletePersonalModel: async (_providerId, modelId) => {
      const models = view.models.filter((entry) => entry.id !== modelId);
      await patchCatalog(modelsPatchFor(view, models));
    },
    onReorderModelIds: async (modelIds) => {
      const byId = new Map(view.models.map((entry) => [entry.id, entry]));
      const ordered = modelIds.flatMap((id) => {
        const entry = byId.get(id);
        byId.delete(id);
        return entry ? [entry] : [];
      });
      // 回调未覆盖的条目按原顺序追加:调序不静默丢模型。
      await patchCatalog(modelsPatchFor(view, [...ordered, ...byId.values()]));
    },
  };
}

/**
 * 原生卡片的模型区块(ProviderModelsSection)在渲染期调用 useServices() 并只消费
 * providerSettingsService.resolveModelConfig 一个服务面;企业侧没有原生运行时服务,
 * 就近注入这一份纯浏览器实现(推荐基线 = 模板离线元数据 + 默认规则),其余服务
 * 一概不绑定。类型断言把部分桩收窄成完整 IServiceAccessor,消费面仅此一处。
 */
export function enterpriseProviderSettingsServicesFor(baseUrl: string): ServiceProviderServices {
  return {
    providerSettingsService: {
      resolveModelConfig: async (
        input: ResolveModelConfigInput,
      ): Promise<ModelConfigResolution> => {
        const inherited = recommendedModelConfig(input.modelId.trim(), baseUrl);
        const personal = "personalConfig" in input ? input.personalConfig : undefined;
        return {
          inheritedConfig: inherited,
          effectiveConfig: overlayModelConfig(inherited, personal),
          issues: [],
        };
      },
    },
  } as unknown as ServiceProviderServices;
}

export function baseUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
