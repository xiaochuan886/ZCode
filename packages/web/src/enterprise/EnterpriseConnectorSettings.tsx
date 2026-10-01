import { useCallback, useEffect, useState } from "react";
import {
  createEnterpriseClient,
  type TenantMcpConnectorPatch,
  type TenantMcpConnectorView,
} from "./api.js";
import { badge, button, chip, field, primary, zh } from "./presentation.js";

const api = createEnterpriseClient();
const defaultHeaderName = "Authorization";

interface ConnectorFormValue {
  connectorKey: string;
  displayName: string;
  url: string;
  headerName: string;
  secretEnv: string;
}

type ConnectorFormTarget = { mode: "create" } | { mode: "edit"; connector: TenantMcpConnectorView };

/**
 * 连接器表单:connectorKey 创建后不可变;secretEnv 编辑时留空表示保留现有密钥引用。
 * 通过外层 key 重挂载来重置草稿,组件内部不监听 initial 变化。
 */
function ConnectorForm({
  t,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  t: typeof zh;
  initial: TenantMcpConnectorView | null;
  busy: boolean;
  onSubmit: (value: ConnectorFormValue) => void;
  onCancel: () => void;
}) {
  const editing = initial !== null;
  const [connectorKey, setConnectorKey] = useState(initial?.connectorKey ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  // 投影只返回 endpointHost,不含完整 URL;编辑时留空表示保留当前地址。
  const [url, setUrl] = useState("");
  const [headerName, setHeaderName] = useState(initial?.headerName || defaultHeaderName);
  const [secretEnv, setSecretEnv] = useState("");
  const complete =
    (editing || /^[a-z0-9][a-z0-9-]*$/.test(connectorKey.trim())) &&
    displayName.trim() !== "" &&
    (editing || url.trim().startsWith("https://")) &&
    headerName.trim() !== "" &&
    (editing || secretEnv.trim() !== "");

  function submit() {
    if (!complete || busy) return;
    onSubmit({
      connectorKey: connectorKey.trim(),
      displayName: displayName.trim(),
      url: url.trim(),
      headerName: headerName.trim(),
      secretEnv: secretEnv.trim(),
    });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="enterprise-connector-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.connectorKey}
          <input
            className={field}
            value={connectorKey}
            placeholder="my-connector"
            autoComplete="off"
            spellCheck={false}
            disabled={editing || busy}
            onChange={(event) => setConnectorKey(event.target.value)}
          />
          <span className="text-ui-xs text-foreground-subtle">{t.connectorKeyHint}</span>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.connectorDisplayName}
          <input
            className={field}
            value={displayName}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-ui-sm">
        {t.connectorUrl}
        <input
          className={field}
          type="url"
          placeholder={editing ? initial?.endpointHost : "https://mcp.example.com/sse"}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.connectorHeaderName}
          <input
            className={field}
            value={headerName}
            placeholder={defaultHeaderName}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setHeaderName(event.target.value)}
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.connectorSecretEnv}
          <input
            className={`${field} font-mono text-ui-sm`}
            value={secretEnv}
            placeholder="ZCODE_ENTERPRISE_MCP_SECRET_…"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setSecretEnv(event.target.value)}
          />
          <span className="text-ui-xs text-foreground-subtle">{t.connectorSecretEnvHint}</span>
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

/**
 * 连接器 tab:租户级 MCP 系统连接器目录。管理员增删改与启停;
 * 成员只读(后端对非管理员变更返回 403,这里直接隐藏表单并给出提示)。
 */
export function EnterpriseConnectorSettings({
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
  const [connectors, setConnectors] = useState<TenantMcpConnectorView[]>([]);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<ConnectorFormTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!tenantId) return;
    api
      .mcpConnectors(tenantId)
      .then((items) => {
        setConnectors(items);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [tenantId]);

  useEffect(() => {
    // 切换租户时目录与表单一并重置,避免残留上一租户的数据。
    setForm(null);
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

  function submitConnector(value: ConnectorFormValue) {
    void run(async () => {
      if (form?.mode === "edit") {
        // 编辑时空 secretEnv / 空 URL 不下发,由服务端保留原值。
        const patch: TenantMcpConnectorPatch = {
          displayName: value.displayName,
          ...(value.url ? { url: value.url } : {}),
          headerName: value.headerName,
          ...(value.secretEnv ? { secretEnv: value.secretEnv } : {}),
        };
        await api.updateMcpConnector(form.connector.id, patch, csrfToken);
      } else {
        await api.createMcpConnector(
          tenantId,
          {
            connectorKey: value.connectorKey,
            displayName: value.displayName,
            url: value.url,
            headerName: value.headerName,
            secretEnv: value.secretEnv,
          },
          csrfToken,
        );
      }
      setForm(null);
      reload();
    });
  }

  function toggleEnabled(connector: TenantMcpConnectorView) {
    void run(async () => {
      await api.updateMcpConnector(connector.id, { enabled: !connector.enabled }, csrfToken);
      reload();
    });
  }

  function removeConnector(connector: TenantMcpConnectorView) {
    if (!window.confirm(t.deleteConnectorConfirm.replace("{name}", connector.displayName))) return;
    void run(async () => {
      await api.deleteMcpConnector(connector.id, csrfToken);
      reload();
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-ui-xl font-medium">{t.connectors}</h1>
      <p className="max-w-2xl text-ui-sm text-foreground-subtle">
        {isAdmin ? t.connectorHint : t.connectorMemberHint}
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
            {t.newConnector}
          </button>
        </div>
      ) : null}
      {isAdmin && form ? (
        <ConnectorForm
          key={form.mode === "edit" ? form.connector.id : "create"}
          t={t}
          initial={form.mode === "edit" ? form.connector : null}
          busy={busy}
          onSubmit={submitConnector}
          onCancel={() => setForm(null)}
        />
      ) : null}
      {connectors.length === 0 && !failed ? (
        <p className="text-ui-sm text-foreground-subtle">{t.noConnectors}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="enterprise-settings-connectors">
          {connectors.map((connector) => (
            <li
              key={connector.id}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-ui-sm font-medium">{connector.displayName}</strong>
                <code className={chip}>{connector.connectorKey}</code>
                <span className={`${badge} border-primary text-foreground`}>
                  {t.systemConnectorBadge}
                </span>
                <span
                  className={
                    connector.secretConfigured
                      ? badge
                      : `${badge} border-destructive text-destructive`
                  }
                >
                  {connector.secretConfigured ? t.secretConfigured : t.secretNotConfigured}
                </span>
                <span className={badge}>{connector.enabled ? t.enabledOn : t.enabledOff}</span>
              </div>
              <div className="text-ui-xs text-foreground-subtle">
                {connector.endpointHost} · {connector.headerName}
              </div>
              {isAdmin ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => setForm({ mode: "edit", connector })}
                  >
                    {t.edit}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => toggleEnabled(connector)}
                  >
                    {connector.enabled ? t.disableAction : t.enableAction}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => removeConnector(connector)}
                  >
                    {t.deleteAction}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
