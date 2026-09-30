import { useEffect, useState } from "react";
import { createEnterpriseClient, type ModelCredentialStatus } from "./api.js";
import { button, field, primary } from "./presentation.js";

const client = createEnterpriseClient();
type Provider = ModelCredentialStatus["providerFamily"];
const providers: { id: Provider; label: string }[] = [
  { id: "zai-api", label: "Z.ai Coding Plan" },
  { id: "bigmodel-api", label: "智谱 Coding Plan" },
];

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
  const [provider, setProvider] = useState<Provider>("zai-api");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<ModelCredentialStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isZh = /^zh\b/i.test(navigator.language);

  useEffect(() => {
    let stale = false;
    setError("");
    void client
      .modelCredentials(tenantId)
      .then((items) => {
        if (!stale) setStatus(items);
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [tenantId]);

  const selectedStatus = status.find((item) => item.providerFamily === provider);
  async function save() {
    if (!apiKey.trim() || loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await client.saveModelCredential(tenantId, provider, apiKey.trim(), csrfToken);
      setStatus((items) => [...items.filter((item) => item.providerFamily !== provider), next]);
      setApiKey("");
      setNotice(
        isZh ? "已保存。现在可以打开案例进入聊天。" : "Saved. Open a case to start chatting.",
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
      const next = await client.revokeModelCredential(tenantId, provider, csrfToken);
      setStatus((items) => [...items.filter((item) => item.providerFamily !== provider), next]);
      setApiKey("");
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
            {isZh ? "返回案例" : "Back to cases"}
          </button>
          <p className="mt-6 text-ui-caption text-foreground-subtle">{tenantName}</p>
          <h1 className="text-ui-xl font-medium">{isZh ? "模型设置" : "Model settings"}</h1>
          <p className="mt-2 text-ui-sm text-foreground-subtle">
            {isZh
              ? "在这里配置租户的模型 API Key。保存后，该租户的案例都可以使用对应模型。"
              : "Configure a model API key for this tenant. Its cases can then use the model."}
          </p>
        </div>

        <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
          <label className="flex flex-col gap-2 text-ui-sm font-medium">
            {isZh ? "模型服务" : "Model provider"}
            <select
              className={field}
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as Provider);
                setApiKey("");
                setNotice("");
              }}
              disabled={loading}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
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
                API Key
                <input
                  type="password"
                  name="apiKey"
                  autoComplete="off"
                  spellCheck={false}
                  className={field}
                  placeholder={isZh ? "粘贴 API Key" : "Paste API key"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={loading}
                />
              </label>
              <p className="mt-2 text-ui-xs text-foreground-subtle">
                {isZh
                  ? "保存后只显示尾号。请勿把密钥发到聊天消息里。"
                  : "Only the last four characters are shown after saving. Do not send the key in chat."}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primary}
                  onClick={() => void save()}
                  disabled={loading || !apiKey.trim()}
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
