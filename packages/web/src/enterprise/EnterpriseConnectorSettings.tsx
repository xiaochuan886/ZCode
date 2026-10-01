import { useCallback, useEffect, useState } from "react";
import { createEnterpriseClient, type TenantMcpConnectorPatch, type TenantMcpConnectorView } from "./api.js";
import { badge, button, chip, primary, zh } from "./presentation.js";
import {
  EnterpriseConnectorForm,
  type ConnectorFormValue,
} from "./EnterpriseConnectorForm.js";

const api = createEnterpriseClient();

type ConnectorFormTarget = { mode: "create" } | { mode: "edit"; connector: TenantMcpConnectorView };

/**
 * 连接器 tab:租户级 MCP 连接器目录。管理员增删改与启停;成员只读目录,但可以
 * 连接/断开自己的 user-oauth 授权(后端对非管理员变更返回 403,表单对成员隐藏)。
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
        // 编辑时空 secretEnv / 空 URL / 空 OAuth 字段不下发,由服务端保留原值。
        const patch: TenantMcpConnectorPatch = {
          displayName: value.displayName,
          ...(value.url ? { url: value.url } : {}),
          headerName: value.headerName,
          authMode: value.authMode,
          ...(value.secretEnv ? { secretEnv: value.secretEnv } : {}),
          ...(value.authorizeUrl ? { authorizeUrl: value.authorizeUrl } : {}),
          ...(value.tokenUrl ? { tokenUrl: value.tokenUrl } : {}),
          ...(value.clientId ? { clientId: value.clientId } : {}),
          ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
          ...(value.scopes ? { scopes: value.scopes } : {}),
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
            ...(value.authMode === "user-oauth"
              ? {
                  authMode: value.authMode,
                  authorizeUrl: value.authorizeUrl,
                  tokenUrl: value.tokenUrl,
                  clientId: value.clientId,
                  ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
                  ...(value.scopes ? { scopes: value.scopes } : {}),
                }
              : { secretEnv: value.secretEnv }),
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

  /** 连接自己的账号:取带签名 state 的授权地址后整体跳转,由供应商回跳网关回调。 */
  function connectConnector(connector: TenantMcpConnectorView) {
    void run(async () => {
      const { authorizeUrl } = await api.connectorAuthorizeUrl(tenantId, connector.id);
      if (authorizeUrl) window.location.href = authorizeUrl;
    });
  }

  function disconnectConnector(connector: TenantMcpConnectorView) {
    void run(async () => {
      await api.revokeConnectorAuthorization(tenantId, connector.id, csrfToken);
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
        <EnterpriseConnectorForm
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
                  {connector.authMode === "user-oauth"
                    ? t.userConnectorBadge
                    : t.systemConnectorBadge}
                </span>
                {connector.authMode === "user-oauth" ? (
                  <span
                    className={
                      connector.authorized
                        ? badge
                        : `${badge} border-destructive text-destructive`
                    }
                  >
                    {connector.authorized ? t.connectorConnected : t.connectorNotConnected}
                  </span>
                ) : (
                  <span
                    className={
                      connector.secretConfigured
                        ? badge
                        : `${badge} border-destructive text-destructive`
                    }
                  >
                    {connector.secretConfigured ? t.secretConfigured : t.secretNotConfigured}
                  </span>
                )}
                <span className={badge}>{connector.enabled ? t.enabledOn : t.enabledOff}</span>
              </div>
              <div className="text-ui-xs text-foreground-subtle">
                {connector.endpointHost} · {connector.headerName}
                {connector.authMode === "user-oauth" ? ` · ${t.connectorUserAuthHint}` : ""}
              </div>
              {connector.authMode === "user-oauth" ? (
                <div className="flex flex-wrap gap-2">
                  {connector.authorized ? (
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => disconnectConnector(connector)}
                    >
                      {t.connectorDisconnect}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={primary}
                      disabled={busy}
                      onClick={() => connectConnector(connector)}
                    >
                      {t.connectorConnect}
                    </button>
                  )}
                </div>
              ) : null}
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
