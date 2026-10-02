import { useState } from "react";
import {
  ApiKeyInput,
  Button,
  Input,
  ProviderApiFormatSelect,
  SettingsFormActions,
  SettingsFormTextarea,
} from "@zcode/ui";
import type { EnterpriseModelMetadata, ModelApiType, ModelProviderView } from "./api.js";
import { field, zh } from "./presentation.js";
import { modelTabStrings } from "./model-tab-strings.js";

export interface ModelProviderFormValue {
  providerKey: string;
  displayName: string;
  apiType: ModelApiType;
  baseUrl: string;
  apiKey: string;
  /** 富条目:模板预填的元数据透传,手输的 id 条目以纯字符串下发(runtime 自行解析)。 */
  models: (string | EnterpriseModelMetadata)[];
  defaultModel: string | null;
  isDefault: boolean;
  enabled: boolean;
}

/** 新建时的预填草稿:模板来源带全量字段,自定义来源只带显示名。编辑模式不使用。 */
export interface ModelProviderFormPrefill {
  providerKey: string;
  displayName: string;
  apiType: ModelApiType;
  baseUrl: string;
  models: EnterpriseModelMetadata[];
  /** 模板自带的控制台地址,展示「获取 API Key」提示链接;没有则不展示。 */
  apiKeyManagementUrl?: string;
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

/*
 * API 协议是技术名称,不进翻译;三值枚举(openai-responses 已入目录契约)复用
 * 原生 ProviderApiFormatSelect,选项自带 path 提示,与详情卡片的协议选择同源。
 */

/**
 * 新增/编辑供应商共用表单:providerKey 创建后不可变;编辑时 apiKey 留空表示保留现有密钥。
 * 通过外层 key 重挂载来重置草稿,组件内部不监听 initial/prefill 变化。
 */
export function EnterpriseModelProviderForm({
  t,
  initial,
  prefill,
  busy,
  onSubmit,
  onCancel,
}: {
  t: typeof zh;
  initial: ModelProviderView | null;
  prefill: ModelProviderFormPrefill | null;
  busy: boolean;
  onSubmit: (value: ModelProviderFormValue) => void;
  onCancel: () => void;
}) {
  const s = t === zh ? modelTabStrings.zh : modelTabStrings.en;
  const editing = initial !== null;
  const [providerKey, setProviderKey] = useState(
    initial?.providerKey ?? prefill?.providerKey ?? "",
  );
  const [displayName, setDisplayName] = useState(
    initial?.displayName ?? prefill?.displayName ?? "",
  );
  const [apiType, setApiType] = useState<ModelApiType>(
    initial?.apiType ?? prefill?.apiType ?? "anthropic-messages",
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? prefill?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [modelsText, setModelsText] = useState(
    // 文本区只编辑 id;模板/目录携带的富元数据在提交时按 id 透传,不在文本区呈现。
    initial?.models.map((model) => model.id).join("\n") ??
      prefill?.models.map((model) => model.id).join("\n") ??
      "",
  );
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const modelIds = parseModelListText(modelsText);
  // id → 富条目映射(模板预填优先于目录旧值):提交时命中的 id 带元数据,其余下发纯 id。
  const metadataById = new Map<string, EnterpriseModelMetadata>();
  for (const entry of [...(prefill?.models ?? []), ...(initial?.models ?? [])]) {
    metadataById.set(entry.id, entry);
  }
  const models: (string | EnterpriseModelMetadata)[] = modelIds.map(
    (id) => metadataById.get(id) ?? id,
  );
  const selectedDefault = modelIds.includes(defaultModel) ? defaultModel : "";
  const complete =
    (editing || /^[a-z0-9][a-z0-9-]*$/.test(providerKey.trim())) &&
    displayName.trim() !== "" &&
    baseUrl.trim().startsWith("https://") &&
    modelIds.length > 0 &&
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
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
      data-testid="enterprise-provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerKey}
          <Input
            className="h-9"
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
          <Input
            className="h-9"
            value={displayName}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerApiType}
          {/* 原生选择控件不提供 disabled,忙碌态用包裹层截断交互并保持视觉一致。 */}
          <div className={busy ? "pointer-events-none opacity-50" : undefined}>
            <ProviderApiFormatSelect value={apiType} onChange={setApiType} />
          </div>
        </div>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerBaseUrl}
          <Input
            className="h-9"
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
      <div className="flex flex-col gap-1 text-ui-sm">
        <div className="flex items-center justify-between gap-2">
          <label>{t.providerApiKey}</label>
          {prefill?.apiKeyManagementUrl && !editing ? (
            <a
              href={prefill.apiKeyManagementUrl}
              target="_blank"
              rel="noreferrer"
              className="text-ui-sm text-primary underline-offset-4 hover:underline"
            >
              {s.getApiKeyLink}
            </a>
          ) : null}
        </div>
        <ApiKeyInput
          value={apiKey}
          visible={apiKeyVisible}
          onChange={setApiKey}
          onBlur={() => setApiKey((current) => current.trim())}
          onToggleVisibility={() => setApiKeyVisible((current) => !current)}
        />
        {editing ? (
          <span className="text-ui-xs text-foreground-subtle">{t.providerApiKeyKeepHint}</span>
        ) : prefill?.apiKeyManagementUrl ? (
          <span className="text-ui-xs text-foreground-subtle">{s.templatePrefillHint}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.providerModels}
          <SettingsFormTextarea
            className="min-h-20 font-mono text-ui-sm"
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
            className={`${field} h-9 px-3 py-0`}
            value={selectedDefault}
            disabled={busy}
            onChange={(event) => setDefaultModel(event.target.value)}
          >
            <option value="">{t.providerDefaultModelUnset}</option>
            {modelIds.map((model) => (
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
      <SettingsFormActions>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={busy || !complete}>
          {editing ? t.save : t.create}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
