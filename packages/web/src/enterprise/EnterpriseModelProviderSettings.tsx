import { useCallback, useEffect, useState } from "react";
import { Button, ProviderTemplatePicker, TooltipProvider, ZCodeIntlProvider } from "@zcode/ui";
import {
  createEnterpriseClient,
  type ModelApiType,
  type ModelProviderPatch,
  type ModelProviderView,
} from "./api.js";
import { badge, chip, zh } from "./presentation.js";
import {
  EnterpriseModelProviderForm,
  type ModelProviderFormPrefill,
  type ModelProviderFormValue,
} from "./EnterpriseModelProviderForm.js";
import {
  enterprisePickerTemplates,
  enterpriseTemplatePrefill,
} from "./model-provider-templates.js";

const api = createEnterpriseClient();

/** 模板清单是静态数据,模块级生成一次即可,避免每次渲染重建选择器视图模型。 */
const pickerTemplates = enterprisePickerTemplates();

const apiTypeLabels: Record<ModelApiType, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-chat-completions": "OpenAI Chat Completions",
};

type ProviderFormTarget =
  | { mode: "create"; prefill: ModelProviderFormPrefill | null }
  | { mode: "edit"; provider: ModelProviderView };

interface ProviderTestState {
  running: boolean;
  ok?: boolean;
  models?: string[];
  error?: string;
}

function baseUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 模型设置 tab = 供应商目录管理(管理员专属页面内的分区):
 * 增删改、设默认、启停与连接测试;成员根本进不了企业设置,无需只读形态。
 * 视图三态:目录列表 → 原生模板选择器 → 表单,与原生设置页「添加供应商」动线一致。
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
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<ProviderFormTarget | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
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
      })
      .catch(() => setFailed(true));
  }, [tenantId]);

  useEffect(() => {
    // 切换租户时目录、选择器、表单与测试结果一并重置,避免残留上一租户的数据。
    setForm(null);
    setPickerOpen(false);
    setTests({});
    reload();
  }, [reload]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function submitProvider(value: ModelProviderFormValue) {
    void run(async () => {
      if (form?.mode === "edit") {
        // 编辑时空密钥不下发,由服务端保留原值;设默认/启停等标记直接随表单提交。
        const patch: ModelProviderPatch = {
          displayName: value.displayName,
          apiType: value.apiType,
          baseUrl: value.baseUrl,
          models: value.models,
          ...(value.defaultModel ? { defaultModel: value.defaultModel } : {}),
          isDefault: value.isDefault,
          enabled: value.enabled,
          ...(value.apiKey ? { apiKey: value.apiKey } : {}),
        };
        await api.updateModelProvider(form.provider.id, patch, csrfToken);
      } else {
        await api.createModelProvider(
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
        );
      }
      setForm(null);
      reload();
    });
  }

  /** 模板创建在本地完成预填,不落库;真正的创建发生在表单提交。 */
  function createFromTemplate(templateId: string): Promise<void> {
    const template = enterpriseTemplatePrefill(templateId);
    setForm({
      mode: "create",
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
    setForm({
      mode: "create",
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

  function markDefault(provider: ModelProviderView) {
    void run(async () => {
      await api.updateModelProvider(provider.id, { isDefault: true }, csrfToken);
      reload();
    });
  }

  function toggleEnabled(provider: ModelProviderView) {
    void run(async () => {
      await api.updateModelProvider(provider.id, { enabled: !provider.enabled }, csrfToken);
      reload();
    });
  }

  function removeProvider(provider: ModelProviderView) {
    if (!window.confirm(t.deleteProviderConfirm.replace("{name}", provider.displayName))) return;
    void run(async () => {
      await api.deleteModelProvider(provider.id, csrfToken);
      reload();
    });
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
          [provider.id]: {
            running: false,
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        })),
      );
  }

  return (
    // 企业设置浮层渲染在全局 ZCodeIntlProvider 之外(main.tsx 只给原生 Root 挂了 Provider),
    // 而原生展示组件(ProviderTemplatePicker/ApiKeyInput)内部调用 useZCodeIntl,缺省会抛错。
    // 这里以无服务形态就近补一层:语言按本地偏好/浏览器语言解析,不引入任何服务 hook。
    <ZCodeIntlProvider>
      {/* TooltipProvider 同样缺省:模板卡片内的 ControlHintTooltip 依赖它,
          原生只在 Root 内挂载,这里与 IntlProvider 一起就地补齐。 */}
      <TooltipProvider>
        <section className="flex flex-col gap-4">
          <h1 className="text-ui-xl font-medium">{t.modelSettings}</h1>
          <p className="max-w-2xl text-ui-sm text-foreground-subtle">{t.modelProviderHint}</p>
          {failed ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {t.loadFailed}
            </p>
          ) : null}
          {error ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {form ? (
            <EnterpriseModelProviderForm
              key={form.mode === "edit" ? form.provider.id : "create"}
              t={t}
              initial={form.mode === "edit" ? form.provider : null}
              prefill={form.mode === "create" ? form.prefill : null}
              busy={busy}
              onSubmit={submitProvider}
              onCancel={() => setForm(null)}
            />
          ) : pickerOpen ? (
            <ProviderTemplatePicker
              templates={pickerTemplates}
              creating={busy}
              onBack={() => setPickerOpen(false)}
              onCreateFromTemplate={createFromTemplate}
              onCreateCustom={createCustom}
            />
          ) : (
            <>
              <div>
                <Button type="button" onClick={() => setPickerOpen(true)}>
                  {t.newModelProvider}
                </Button>
              </div>
              {providers.length === 0 && !failed ? (
                <p className="text-ui-sm text-foreground-subtle">{t.noModelProviders}</p>
              ) : (
                <ul
                  className="flex flex-col gap-2"
                  data-testid="enterprise-settings-model-providers"
                >
                  {providers.map((provider) => {
                    const test = tests[provider.id];
                    return (
                      <li
                        key={provider.id}
                        className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-ui-sm font-medium">{provider.displayName}</strong>
                          <code className={chip}>{provider.providerKey}</code>
                          <span className={badge}>{apiTypeLabels[provider.apiType]}</span>
                          {provider.isDefault ? (
                            <span className={`${badge} border-primary text-foreground`}>
                              {t.defaultBadge}
                            </span>
                          ) : null}
                          <span className={badge}>
                            {provider.enabled ? t.enabledOn : t.enabledOff}
                          </span>
                        </div>
                        <div className="text-ui-xs text-foreground-subtle">
                          {baseUrlHost(provider.baseUrl)} · ••••{provider.apiKeyLast4}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {provider.models.length === 0 ? (
                            <span className="text-ui-xs text-foreground-subtle">
                              {t.noProviderModels}
                            </span>
                          ) : (
                            provider.models.map((model) => (
                              <code
                                key={model}
                                className={
                                  model === provider.defaultModel
                                    ? `${chip} border-primary text-foreground`
                                    : chip
                                }
                              >
                                {model}
                              </code>
                            ))
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => setForm({ mode: "edit", provider })}
                          >
                            {t.edit}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy || provider.isDefault}
                            onClick={() => markDefault(provider)}
                          >
                            {t.setDefaultAction}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => toggleEnabled(provider)}
                          >
                            {provider.enabled ? t.disableAction : t.enableAction}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={test?.running}
                            onClick={() => testProvider(provider)}
                          >
                            {test?.running ? t.testing : t.testConnection}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => removeProvider(provider)}
                          >
                            {t.deleteAction}
                          </Button>
                        </div>
                        {test && !test.running ? (
                          test.ok ? (
                            <p className="text-ui-xs text-foreground-subtle" role="status">
                              {t.testOkSummary.replace("{count}", String(test.models?.length ?? 0))}
                              {test.models?.length ? ` · ${test.models.join(", ")}` : ""}
                            </p>
                          ) : (
                            <p className="text-ui-xs text-destructive" role="alert">
                              {test.error ? `${t.testFailed} · ${test.error}` : t.testFailed}
                            </p>
                          )
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </section>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
