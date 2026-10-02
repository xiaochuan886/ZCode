import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  InlineEditableProviderCard,
  ModelProviderSectionNavigation,
  ProviderTemplatePicker,
  ServiceProvider,
  TooltipProvider,
  ZCodeIntlProvider,
  type ModelProviderNavGroup,
} from "@zcode/ui";
import { createEnterpriseClient, type ModelProviderView } from "./api.js";
import { badge, chip, zh } from "./presentation.js";
import { modelTabStrings } from "./model-tab-strings.js";
import {
  EnterpriseModelProviderForm,
  type ModelProviderFormPrefill,
  type ModelProviderFormValue,
} from "./EnterpriseModelProviderForm.js";
import {
  enterprisePickerTemplates,
  enterpriseTemplatePrefill,
} from "./model-provider-templates.js";
import {
  baseUrlHost,
  createEnterpriseCardCallbacks,
  enterpriseProviderSettingsServicesFor,
  providerViewToFormProvider,
} from "./model-provider-form-adapter.js";

const api = createEnterpriseClient();

/** 模板清单是静态数据,模块级生成一次即可,避免每次渲染重建选择器视图模型。 */
const pickerTemplates = enterprisePickerTemplates();

/** 网关目录没有供应商排序接口:空集让导航项渲染为普通按钮,不出现拖拽手柄。 */
const NON_REORDERABLE_PROVIDERS: ReadonlySet<string> = new Set<string>();

type ProviderTestState = { running: boolean; ok?: boolean; models?: string[]; error?: string };

/** 新建动线状态:picker → 预填草稿(模板)或空草稿(自定义)。 */
type ProviderCreateDraft = { prefill: ModelProviderFormPrefill | null };

/**
 * 模型设置 tab = 供应商目录管理(管理员专属),镜像原生 ModelProviderSection 的
 * 「左导航 + 右详情编辑器」形态:左侧 ModelProviderSectionNavigation(单「租户供应商」
 * 分组),右侧 InlineEditableProviderCard 负责改名/协议/Base URL/密钥/模型行编辑,
 * 全部回调经 model-provider-form-adapter 路由到网关目录 API。目录级动作
 * (设为默认、连接测试、删除)留在详情头部——卡片不管租户默认语义。
 */
export function EnterpriseModelProviderSettings({
  t,
  tenantId,
  csrfToken,
}: {
  t: typeof zh;
  tenantId: string;
  csrfToken: string | null;
}) {
  const s = t === zh ? modelTabStrings.zh : modelTabStrings.en;
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 供卡片草稿并发守卫(settingsRevision):每次目录回读递增,而非用列表长度。
  const [revision, setRevision] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<ProviderCreateDraft | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTestState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!tenantId) return;
    api
      .modelProviders(tenantId)
      .then((items) => {
        setProviders(items);
        setFailed(false);
        setLoading(false);
        setRevision((current) => current + 1);
        // 保持当前选中;目录里已不存在(如删除)时回落到首项,与原生导航一致。
        setSelectedId((current) =>
          current && items.some((provider) => provider.id === current)
            ? current
            : (items[0]?.id ?? null),
        );
      })
      .catch(() => {
        setFailed(true);
        setLoading(false);
      });
  }, [tenantId]);

  useEffect(() => {
    // 切换租户时目录、选择器、草稿与测试结果一并重置,避免残留上一租户的数据。
    setSelectedId(null);
    setPickerOpen(false);
    setCreateDraft(null);
    setTests({});
    setLoading(true);
    reload();
  }, [reload]);

  const selected = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId],
  );
  const navigationGroups = useMemo<ModelProviderNavGroup[]>(
    () => [
      {
        id: "custom",
        title: s.navGroupTitle,
        items: providers.map((provider) => ({
          key: `custom:${provider.id}`,
          type: "custom" as const,
          label: provider.displayName || provider.providerKey,
          provider: providerViewToFormProvider(provider),
          statusActive: provider.enabled,
        })),
      },
    ],
    [providers, s.navGroupTitle],
  );

  function describeFailure(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  /** 模板创建在本地完成预填,不落库;真正的创建发生在表单提交。 */
  function createFromTemplate(templateId: string): Promise<void> {
    const template = enterpriseTemplatePrefill(templateId);
    setCreateDraft({
      // providerKey 直接采用模板 id(小写连字符,满足目录 key 约束),未收录 id 退回空表单。
      prefill: template
        ? {
            providerKey: template.templateId,
            displayName: t === zh ? template.nameZh : template.nameEn,
            apiType: template.apiType,
            baseUrl: template.baseUrl,
            models: template.models,
            ...(template.apiKeyManagementUrl
              ? { apiKeyManagementUrl: template.apiKeyManagementUrl }
              : {}),
          }
        : null,
    });
    setPickerOpen(false);
    return Promise.resolve();
  }

  /** 自定义创建:选择器把本地化的默认名称作为 label 传入,仅预填显示名。 */
  function createCustom(label: string): Promise<void> {
    setCreateDraft({
      prefill: {
        providerKey: "",
        displayName: label,
        apiType: "anthropic-messages",
        baseUrl: "",
        models: [],
      },
    });
    setPickerOpen(false);
    return Promise.resolve();
  }

  function submitCreate(value: ModelProviderFormValue) {
    setBusy(true);
    setError(null);
    api
      .createModelProvider(
        tenantId,
        {
          providerKey: value.providerKey,
          displayName: value.displayName,
          apiType: value.apiType,
          baseUrl: value.baseUrl,
          apiKey: value.apiKey,
          models: value.models,
          ...(value.defaultModel ? { defaultModel: value.defaultModel } : {}),
          isDefault: value.isDefault,
          enabled: value.enabled,
        },
        csrfToken,
      )
      .then((created) => {
        // 新建提交后直接选中新建项,管理员可以立刻补配模型元数据。
        setCreateDraft(null);
        setSelectedId(created.id);
        reload();
      })
      .catch((cause: unknown) => setError(describeFailure(cause)))
      .finally(() => setBusy(false));
  }

  function markDefault(provider: ModelProviderView) {
    void api
      .updateModelProvider(provider.id, { isDefault: true }, csrfToken)
      .then(reload)
      .catch((cause: unknown) => setError(describeFailure(cause)));
  }

  function removeProvider(provider: ModelProviderView) {
    if (!window.confirm(t.deleteProviderConfirm.replace("{name}", provider.displayName))) return;
    api
      .deleteModelProvider(provider.id, csrfToken)
      .then(reload)
      .catch((cause: unknown) => setError(describeFailure(cause)));
  }

  function testProvider(provider: ModelProviderView) {
    setTests((current) => ({ ...current, [provider.id]: { running: true } }));
    void api
      .testModelProvider(provider.id, csrfToken)
      .then((result) =>
        setTests((current) => ({
          ...current,
          [provider.id]: {
            running: false,
            ok: result.ok,
            models: result.models,
            error: result.error,
          },
        })),
      )
      .catch((cause: unknown) =>
        setTests((current) => ({
          ...current,
          [provider.id]: { running: false, ok: false, error: describeFailure(cause) },
        })),
      );
  }

  /**
   * 连接测试的上游 /models 清单是模型 id 的权威事实;模板清单是官方展示形态
   * (如 GLM-5.3 大写),上游 API 实际接受的是小写。大小写不一致时调用会 404,
   * 这里按上游清单逐条修正目录 id(元数据/顺序保留,默认模型跟随改名)。
   */
  function fixModelIdsFromUpstream(provider: ModelProviderView, upstream: string[]) {
    const authoritative = new Map(upstream.map((id) => [id.toLowerCase(), id] as const));
    const models = provider.models.map((entry) => {
      const fixed = authoritative.get(entry.id.toLowerCase());
      return fixed && fixed !== entry.id ? { ...entry, id: fixed } : entry;
    });
    const defaultModel = provider.defaultModel
      ? (authoritative.get(provider.defaultModel.toLowerCase()) ?? provider.defaultModel)
      : null;
    void api
      .updateModelProvider(provider.id, { models, defaultModel }, csrfToken)
      .then(reload)
      .catch((cause: unknown) => setError(describeFailure(cause)));
  }

  function renderDetail() {
    if (!selected) {
      return (
        <div className="flex min-h-48 flex-col justify-center gap-2 text-ui-sm text-foreground-subtle">
          {providers.length === 0 && !failed ? <p>{t.noModelProviders}</p> : null}
          <p>{s.emptyDetailHint}</p>
        </div>
      );
    }
    const test = tests[selected.id];
    // 与上游清单大小写不一致的条目(仅统计能一一对应上的,避免误报)。
    const caseFixes =
      test?.ok && test.models?.length
        ? selected.models.flatMap((entry) => {
            const upstream = test.models!.find(
              (id) => id.toLowerCase() === entry.id.toLowerCase() && id !== entry.id,
            );
            return upstream ? [{ from: entry.id, sample: `${entry.id} → ${upstream}` }] : [];
          })
        : [];
    // 模板控制台地址按 providerKey 反查(创建时 providerKey 即模板 id),供密钥区外链。
    const apiKeyManagementUrl = enterpriseTemplatePrefill(
      selected.providerKey,
    )?.apiKeyManagementUrl;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className={chip}>{selected.providerKey}</code>
          {selected.isDefault ? (
            <span className={`${badge} border-primary text-foreground`}>{t.defaultBadge}</span>
          ) : null}
          <span className="text-ui-xs text-foreground-subtle">
            {baseUrlHost(selected.baseUrl)}
            {selected.apiKeyLast4 ? ` · ••••${selected.apiKeyLast4}` : ""}
            {selected.defaultModel ? ` · ${t.providerDefaultModel}: ${selected.defaultModel}` : ""}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selected.isDefault}
              onClick={() => markDefault(selected)}
            >
              {t.setDefaultAction}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={test?.running}
              onClick={() => testProvider(selected)}
            >
              {test?.running ? t.testing : t.testConnection}
            </Button>
          </div>
        </div>
        {selected.apiType === "anthropic-messages" && !/anthropic/i.test(selected.baseUrl) ? (
          <p className="text-ui-xs text-foreground-subtle" role="alert">
            {s.anthropicUrlWarning}
          </p>
        ) : null}
        {test && !test.running ? (
          test.ok ? (
            <div className="flex flex-col gap-2">
              <p className="text-ui-xs text-foreground-subtle" role="status">
                {t.testOkSummary.replace("{count}", String(test.models?.length ?? 0))}
                {test.models?.length ? ` · ${test.models.join(", ")}` : ""}
              </p>
              {caseFixes.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-ui-xs text-foreground-subtle" role="status">
                    {s.modelIdCaseFixHint
                      .replace("{count}", String(caseFixes.length))
                      .replace("{sample}", caseFixes[0]!.sample)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fixModelIdsFromUpstream(selected, test.models ?? [])}
                  >
                    {s.modelIdCaseFixAction}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-ui-xs text-destructive" role="alert">
              {test.error ? `${t.testFailed} · ${test.error}` : t.testFailed}
            </p>
          )
        ) : null}
        {/* ServiceProvider 注入适配层的 resolveModelConfig 桩(见 adapter 注释):
            原生模型区块在渲染期读取这一个服务面,企业侧无原生运行时服务。 */}
        <ServiceProvider services={enterpriseProviderSettingsServicesFor(selected.baseUrl)}>
          <InlineEditableProviderCard
            key={selected.id}
            provider={providerViewToFormProvider(selected)}
            settingsRevision={revision}
            onDelete={() => removeProvider(selected)}
            {...(apiKeyManagementUrl
              ? {
                  presetApiKeyUrl: apiKeyManagementUrl,
                  onOpenPresetApiKey: () =>
                    window.open(apiKeyManagementUrl, "_blank", "noopener,noreferrer"),
                }
              : {})}
            {...createEnterpriseCardCallbacks({
              view: selected,
              gateway: api,
              csrfToken,
              reload,
            })}
          />
        </ServiceProvider>
      </div>
    );
  }

  const detail = renderDetail();

  return (
    // 企业设置浮层渲染在全局 ZCodeIntlProvider 之外(main.tsx 只给原生 Root 挂了 Provider),
    // 而原生编辑组件(卡片/导航/选择器)内部调用 useZCodeIntl,缺省会抛错。
    // 这里以无服务形态就近补一层:语言按本地偏好/浏览器语言解析,不引入任何服务 hook。
    <ZCodeIntlProvider>
      {/* TooltipProvider 同样缺省:原生组件内的 ControlHintTooltip 依赖它,
          原生只在 Root 内挂载,这里与 IntlProvider 一起就地补齐。 */}
      <TooltipProvider>
        <section className="flex flex-col gap-4">
          <h1 className="text-ui-xl font-medium">{t.modelSettings}</h1>
          {failed ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {t.loadFailed}
            </p>
          ) : null}
          {error ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {s.catalogErrorTitle} · {error}
            </p>
          ) : null}
          {pickerOpen ? (
            <ProviderTemplatePicker
              templates={pickerTemplates}
              creating={busy}
              onBack={() => setPickerOpen(false)}
              onCreateFromTemplate={createFromTemplate}
              onCreateCustom={createCustom}
            />
          ) : createDraft ? (
            <EnterpriseModelProviderForm
              key={createDraft.prefill?.providerKey || "create-custom"}
              t={t}
              initial={null}
              prefill={createDraft.prefill}
              busy={busy}
              onSubmit={submitCreate}
              onCancel={() => setCreateDraft(null)}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="max-w-2xl text-ui-sm text-foreground-subtle">{t.modelProviderHint}</p>
                <Button type="button" onClick={() => setPickerOpen(true)}>
                  {t.newModelProvider}
                </Button>
              </div>
              {/* 镜像原生 SectionLayout 的分栏结构;data-testid 覆盖导航+详情整体。 */}
              <div className="overflow-clip rounded-xl border border-border bg-card">
                <div
                  className="grid min-h-[36rem] grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]"
                  data-testid="enterprise-settings-model-providers"
                >
                  <div className="min-w-0 border-r border-border">
                    <ModelProviderSectionNavigation
                      navigationGroups={navigationGroups}
                      selectedNodeKey={selected ? `custom:${selected.id}` : null}
                      presetLoading={false}
                      customLoading={loading}
                      onSelectNavItem={(item) => {
                        if (item.type === "custom") setSelectedId(item.provider.providerId);
                      }}
                      reorderableProviderIds={NON_REORDERABLE_PROVIDERS}
                    />
                  </div>
                  <div className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24">{detail}</div>
                </div>
              </div>
            </>
          )}
        </section>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
