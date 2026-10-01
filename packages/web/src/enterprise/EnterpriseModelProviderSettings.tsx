import { useCallback, useEffect, useState } from "react";
import {
  createEnterpriseClient,
  type ModelApiType,
  type ModelProviderPatch,
  type ModelProviderView,
} from "./api.js";
import { badge, button, chip, primary, zh } from "./presentation.js";
import {
  EnterpriseModelProviderForm,
  type ModelProviderFormValue,
} from "./EnterpriseModelProviderForm.js";

const api = createEnterpriseClient();

const apiTypeLabels: Record<ModelApiType, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-chat-completions": "OpenAI Chat Completions",
};

type ProviderFormTarget = { mode: "create" } | { mode: "edit"; provider: ModelProviderView };

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
 * 模型设置 tab = 供应商目录管理。管理员增删改、设默认、启停与连接测试;
 * 成员只读(后端对非管理员变更返回 403,这里直接隐藏表单并给出提示)。
 */
export function EnterpriseModelProviderSettings({
  t,
  tenantId,
  role,
  csrfToken,
}: {
  t: typeof zh;
  tenantId: string;
  role: "admin" | "member";
  csrfToken: string | null;
}) {
  const isAdmin = role === "admin";
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<ProviderFormTarget | null>(null);
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
    // 切换租户时目录、表单与测试结果一并重置,避免残留上一租户的数据。
    setForm(null);
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
    <section className="flex flex-col gap-4">
      <h1 className="text-ui-xl font-medium">{t.modelSettings}</h1>
      <p className="max-w-2xl text-ui-sm text-foreground-subtle">
        {isAdmin ? t.modelProviderHint : t.modelProviderMemberHint}
      </p>
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
      {isAdmin && !form ? (
        <div>
          <button type="button" className={primary} onClick={() => setForm({ mode: "create" })}>
            {t.newModelProvider}
          </button>
        </div>
      ) : null}
      {isAdmin && form ? (
        <EnterpriseModelProviderForm
          key={form.mode === "edit" ? form.provider.id : "create"}
          t={t}
          initial={form.mode === "edit" ? form.provider : null}
          busy={busy}
          onSubmit={submitProvider}
          onCancel={() => setForm(null)}
        />
      ) : null}
      {providers.length === 0 && !failed ? (
        <p className="text-ui-sm text-foreground-subtle">{t.noModelProviders}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="enterprise-settings-model-providers">
          {providers.map((provider) => {
            const test = tests[provider.id];
            return (
              <li
                key={provider.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2"
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
                  <span className={badge}>{provider.enabled ? t.enabledOn : t.enabledOff}</span>
                </div>
                <div className="text-ui-xs text-foreground-subtle">
                  {baseUrlHost(provider.baseUrl)} · ••••{provider.apiKeyLast4}
                </div>
                <div className="flex flex-wrap gap-1">
                  {provider.models.length === 0 ? (
                    <span className="text-ui-xs text-foreground-subtle">{t.noProviderModels}</span>
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
                {isAdmin ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => setForm({ mode: "edit", provider })}
                    >
                      {t.edit}
                    </button>
                    <button
                      type="button"
                      className={button}
                      disabled={busy || provider.isDefault}
                      onClick={() => markDefault(provider)}
                    >
                      {t.setDefaultAction}
                    </button>
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => toggleEnabled(provider)}
                    >
                      {provider.enabled ? t.disableAction : t.enableAction}
                    </button>
                    <button
                      type="button"
                      className={button}
                      disabled={test?.running}
                      onClick={() => testProvider(provider)}
                    >
                      {test?.running ? t.testing : t.testConnection}
                    </button>
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => removeProvider(provider)}
                    >
                      {t.deleteAction}
                    </button>
                  </div>
                ) : null}
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
    </section>
  );
}
