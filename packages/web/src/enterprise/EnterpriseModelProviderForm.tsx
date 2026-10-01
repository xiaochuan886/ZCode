import { useState } from "react";
import type { ModelApiType, ModelProviderView } from "./api.js";
import { button, field, primary, zh } from "./presentation.js";

export interface ModelProviderFormValue {
  providerKey: string;
  displayName: string;
  apiType: ModelApiType;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string | null;
  isDefault: boolean;
  enabled: boolean;
}

/** 模型列表输入支持逗号(含中文逗号)或换行分隔,解析时统一去重保序。 */
export function parseModelListText(text: string): string[] {
  const seen = new Set<string>();
  for (const item of text.split(/[\n,，]/)) {
    const model = item.trim();
    if (model) seen.add(model);
  }
  return [...seen];
}

/**
 * 新增/编辑供应商共用表单:providerKey 创建后不可变;编辑时 apiKey 留空表示保留现有密钥。
 * 通过外层 key 重挂载来重置草稿,组件内部不监听 initial 变化。
 */
export function EnterpriseModelProviderForm({
  t,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  t: typeof zh;
  initial: ModelProviderView | null;
  busy: boolean;
  onSubmit: (value: ModelProviderFormValue) => void;
  onCancel: () => void;
}) {
  const editing = initial !== null;
  const [providerKey, setProviderKey] = useState(initial?.providerKey ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [apiType, setApiType] = useState<ModelApiType>(initial?.apiType ?? "anthropic-messages");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState(initial?.models.join("\n") ?? "");
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const models = parseModelListText(modelsText);
  const selectedDefault = models.includes(defaultModel) ? defaultModel : "";
  const complete =
    (editing || /^[a-z0-9][a-z0-9-]*$/.test(providerKey.trim())) &&
    displayName.trim() !== "" &&
    baseUrl.trim().startsWith("https://") &&
    models.length > 0 &&
    (editing || apiKey.trim() !== "");

  function submit() {
    if (!complete || busy) return;
    onSubmit({
      providerKey: providerKey.trim(),
      displayName: displayName.trim(),
      apiType,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      models,
      defaultModel: selectedDefault || null,
      isDefault,
      enabled,
    });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="enterprise-provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerKey}
          <input
            className={field}
            value={providerKey}
            placeholder="my-provider"
            autoComplete="off"
            spellCheck={false}
            disabled={editing || busy}
            onChange={(event) => setProviderKey(event.target.value)}
          />
          <span className="text-ui-xs text-foreground-subtle">{t.providerKeyHint}</span>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerDisplayName}
          <input
            className={field}
            value={displayName}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerApiType}
          <select
            className={field}
            value={apiType}
            disabled={busy}
            onChange={(event) => setApiType(event.target.value as ModelApiType)}
          >
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="openai-chat-completions">OpenAI Chat Completions</option>
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerBaseUrl}
          <input
            className={field}
            type="url"
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
            value={baseUrl}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-ui-sm">
        {t.providerApiKey}
        <input
          className={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          value={apiKey}
          placeholder={editing ? `••••${initial?.apiKeyLast4 ?? ""}` : t.providerApiKeyPlaceholder}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {editing ? (
          <span className="text-ui-xs text-foreground-subtle">{t.providerApiKeyKeepHint}</span>
        ) : null}
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerModels}
          <textarea
            className={`${field} min-h-20 font-mono text-ui-sm`}
            value={modelsText}
            placeholder={t.providerModelsPlaceholder}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setModelsText(event.target.value)}
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerDefaultModel}
          <select
            className={field}
            value={selectedDefault}
            disabled={busy}
            onChange={(event) => setDefaultModel(event.target.value)}
          >
            <option value="">{t.providerDefaultModelUnset}</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-ui-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isDefault}
            disabled={busy}
            onChange={(event) => setIsDefault(event.target.checked)}
          />
          {t.providerIsDefault}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t.providerEnabled}
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel} disabled={busy}>
          {t.cancel}
        </button>
        <button type="submit" className={primary} disabled={busy || !complete}>
          {editing ? t.save : t.create}
        </button>
      </div>
    </form>
  );
}
