import { useEffect, useState } from "react";
import {
  createEnterpriseClient,
  isCompleteModelCredentialInput,
  type ModelApiType,
  type ModelCredentialInput,
  type ModelCredentialStatus,
} from "./api.js";
import { button, field, primary } from "./presentation.js";

const client = createEnterpriseClient();
const provider = "custom" as const;
const defaultDraft: ModelCredentialInput = {
  providerName: "自定义供应商",
  apiType: "anthropic-messages",
  baseUrl: "",
  modelId: "",
  apiKey: "",
};

function draftFromStatus(status: ModelCredentialStatus): ModelCredentialInput {
  return {
    providerName: status.providerName ?? defaultDraft.providerName,
    apiType: status.apiType ?? defaultDraft.apiType,
    baseUrl: status.baseUrl ?? defaultDraft.baseUrl,
    modelId: status.modelId ?? defaultDraft.modelId,
    apiKey: "",
  };
}

export function EnterpriseModelSettings({
  tenantId,
  tenantName,
  role,
  csrfToken,
  onBack,
  onSaved,
}: {
  tenantId: string;
  tenantName: string;
  role: "admin" | "member";
  csrfToken: string | null;
  onBack: () => void;
  onSaved?: () => void;
}) {
  const [draft, setDraft] = useState<ModelCredentialInput>(defaultDraft);
  const [status, setStatus] = useState<ModelCredentialStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isZh = /^zh\b/i.test(navigator.language);

  useEffect(() => {
    let stale = false;
    setError("");
    setNotice("");
    setStatus([]);
    setDraft(defaultDraft);
    void client
      .modelCredentials(tenantId)
      .then((items) => {
        if (stale) return;
        setStatus(items);
        const configured = items.find((item) => item.providerFamily === provider);
        if (configured) setDraft(draftFromStatus(configured));
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [tenantId]);

  const selectedStatus = status.find((item) => item.providerFamily === provider);
  const updateDraft = <K extends keyof ModelCredentialInput>(
    key: K,
    value: ModelCredentialInput[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  async function save() {
    if (!isCompleteModelCredentialInput(draft) || loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const providerName = draft.providerName?.trim();
      const next = await client.saveModelCredential(
        tenantId,
        {
          ...(providerName ? { providerName } : {}),
          apiType: draft.apiType,
          baseUrl: draft.baseUrl.trim(),
          modelId: draft.modelId.trim(),
          apiKey: draft.apiKey.trim(),
        },
        csrfToken,
      );
      setStatus((items) => [...items.filter((item) => item.providerFamily !== provider), next]);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setNotice(
        isZh
          ? "已保存。现在可以打开客户工作区。"
          : "Saved. Open a customer workspace to start chatting.",
      );
      onSaved?.();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }

  async function revoke() {
    if (loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await client.revokeModelCredential(tenantId, csrfToken);
      setStatus((items) => [...items.filter((item) => item.providerFamily !== provider), next]);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setNotice(isZh ? "已移除此模型连接。" : "Model connection removed.");
      onSaved?.();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div>
          <button type="button" className={button} onClick={onBack}>
            {isZh ? "返回客户" : "Back to customers"}
          </button>
          <p className="mt-6 text-ui-caption text-foreground-subtle">{tenantName}</p>
          <h1 className="text-ui-xl font-medium">{isZh ? "模型设置" : "Model settings"}</h1>
          <p className="mt-2 text-ui-sm text-foreground-subtle">
            {isZh
              ? "在这里配置租户级自定义供应商。保存后，该租户的客户工作区可以共用这条连接。"
              : "Configure one custom provider for this tenant. Its customer workspaces can share the connection."}
          </p>
        </div>

        <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
          <p className="text-ui-sm font-medium">{isZh ? "自定义供应商" : "Custom provider"}</p>
          <p className="mt-3 text-ui-sm text-foreground-subtle">
            {selectedStatus?.configured
              ? isZh
                ? `已配置 · 尾号 ${selectedStatus.lastFour ?? "****"}`
                : `Configured · ending ${selectedStatus.lastFour ?? "****"}`
              : isZh
                ? "尚未配置"
                : "Not configured"}
          </p>
          {role === "admin" ? (
            <>
              <label className="mt-5 flex flex-col gap-2 text-ui-sm font-medium">
                {isZh ? "供应商名称（可选）" : "Provider name (optional)"}
                <input
                  className={field}
                  name="providerName"
                  autoComplete="off"
                  value={draft.providerName}
                  onChange={(event) => updateDraft("providerName", event.target.value)}
                  disabled={loading}
                />
              </label>
              <label className="mt-4 flex flex-col gap-2 text-ui-sm font-medium">
                {isZh ? "API 协议" : "API protocol"}
                <select
                  className={field}
                  name="apiType"
                  value={draft.apiType}
                  onChange={(event) => updateDraft("apiType", event.target.value as ModelApiType)}
                  disabled={loading}
                >
                  <option value="anthropic-messages">Anthropic Messages</option>
                  <option value="openai-chat-completions">OpenAI Chat Completions</option>
                </select>
              </label>
              <label className="mt-4 flex flex-col gap-2 text-ui-sm font-medium">
                Base URL
                <input
                  className={field}
                  name="baseUrl"
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://api.example.com/v1"
                  value={draft.baseUrl}
                  onChange={(event) => updateDraft("baseUrl", event.target.value)}
                  disabled={loading}
                />
              </label>
              <label className="mt-4 flex flex-col gap-2 text-ui-sm font-medium">
                {isZh ? "模型 ID" : "Model ID"}
                <input
                  className={field}
                  name="modelId"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="gpt-4o"
                  value={draft.modelId}
                  onChange={(event) => updateDraft("modelId", event.target.value)}
                  disabled={loading}
                />
              </label>
              <label className="mt-5 flex flex-col gap-2 text-ui-sm font-medium">
                API Key
                <input
                  type="password"
                  name="apiKey"
                  autoComplete="off"
                  spellCheck={false}
                  className={field}
                  placeholder={
                    selectedStatus?.configured
                      ? isZh
                        ? "重新输入以保存连接"
                        : "Enter again to save"
                      : isZh
                        ? "粘贴 API Key"
                        : "Paste API key"
                  }
                  value={draft.apiKey}
                  onChange={(event) => updateDraft("apiKey", event.target.value)}
                  disabled={loading}
                />
              </label>
              <p className="mt-2 text-ui-xs text-foreground-subtle">
                {isZh
                  ? "API Key 仅在服务端加密保存，只显示尾号；不会写入客户 workspace 或聊天内容。保存已配置连接时需要重新输入密钥。"
                  : "The API key is encrypted server-side and only its last four characters are shown. It is not written to the customer workspace or chat. Re-enter it when saving an existing connection."}
              </p>
              <p className="mt-2 text-ui-xs text-foreground-subtle">
                {isZh
                  ? "Base URL 必须使用 HTTPS 公网地址。"
                  : "Base URL must be a public HTTPS address."}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primary}
                  onClick={() => void save()}
                  disabled={loading || !isCompleteModelCredentialInput(draft)}
                >
                  {loading
                    ? isZh
                      ? "保存中…"
                      : "Saving…"
                    : isZh
                      ? "保存模型连接"
                      : "Save connection"}
                </button>
                {selectedStatus?.configured ? (
                  <button
                    type="button"
                    className={button}
                    onClick={() => void revoke()}
                    disabled={loading}
                  >
                    {isZh ? "移除连接" : "Remove connection"}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="mt-5 text-ui-sm text-foreground-subtle">
              {isZh ? "请联系租户管理员配置模型。" : "Ask your tenant admin to configure a model."}
            </p>
          )}
          {error ? (
            <p role="alert" className="mt-4 text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mt-4 text-ui-sm text-foreground">
              {notice}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
