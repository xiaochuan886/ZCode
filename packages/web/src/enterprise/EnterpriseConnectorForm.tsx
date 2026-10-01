import { useState } from "react";
import type { TenantMcpConnectorAuthMode, TenantMcpConnectorView } from "./api.js";
import { button, field, primary, zh } from "./presentation.js";

const defaultHeaderName = "Authorization";

export interface ConnectorFormValue {
  connectorKey: string;
  displayName: string;
  url: string;
  headerName: string;
  secretEnv: string;
  authMode: TenantMcpConnectorAuthMode;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

/**
 * 新增/编辑连接器共用表单:connectorKey 创建后不可变;shared 模式编辑 secretEnv,
 * 留空表示保留现有密钥引用;user-oauth 模式填写 OAuth 客户端配置,clientSecret
 * 留空表示保留当前值(公共客户端可为空)。通过外层 key 重挂载来重置草稿,
 * 组件内部不监听 initial 变化。
 */
export function EnterpriseConnectorForm({
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
  const [authMode, setAuthMode] = useState<TenantMcpConnectorAuthMode>(
    initial?.authMode ?? "shared",
  );
  const [secretEnv, setSecretEnv] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState("");
  const isOauth = authMode === "user-oauth";
  const complete =
    (editing || /^[a-z0-9][a-z0-9-]*$/.test(connectorKey.trim())) &&
    displayName.trim() !== "" &&
    (editing || url.trim().startsWith("https://")) &&
    headerName.trim() !== "" &&
    (isOauth
      ? (editing || authorizeUrl.trim().startsWith("https://")) &&
        (editing || tokenUrl.trim().startsWith("https://")) &&
        (editing || clientId.trim() !== "")
      : editing || secretEnv.trim() !== "");

  function submit() {
    if (!complete || busy) return;
    onSubmit({
      connectorKey: connectorKey.trim(),
      displayName: displayName.trim(),
      url: url.trim(),
      headerName: headerName.trim(),
      secretEnv: secretEnv.trim(),
      authMode,
      authorizeUrl: authorizeUrl.trim(),
      tokenUrl: tokenUrl.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes: scopes.trim(),
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
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.connectorAuthMode}
          <select
            className={field}
            value={authMode}
            disabled={busy}
            onChange={(event) =>
              setAuthMode(event.target.value === "user-oauth" ? "user-oauth" : "shared")
            }
          >
            <option value="shared">{t.authModeShared}</option>
            <option value="user-oauth">{t.authModeUserOauth}</option>
          </select>
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
        {isOauth ? null : (
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
        )}
      </div>
      {isOauth ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
              {t.connectorAuthorizeUrl}
              <input
                className={field}
                type="url"
                placeholder="https://provider.example.com/authorize"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={authorizeUrl}
                onChange={(event) => setAuthorizeUrl(event.target.value)}
              />
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
              {t.connectorTokenUrl}
              <input
                className={field}
                type="url"
                placeholder="https://provider.example.com/token"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={tokenUrl}
                onChange={(event) => setTokenUrl(event.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
              {t.connectorClientId}
              <input
                className={field}
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
              {t.connectorClientSecret}
              <input
                className={field}
                type="password"
                value={clientSecret}
                autoComplete="new-password"
                disabled={busy}
                onChange={(event) => setClientSecret(event.target.value)}
              />
              <span className="text-ui-xs text-foreground-subtle">
                {t.connectorClientSecretKeepHint}
              </span>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-ui-sm">
            {t.connectorScopes}
            <input
              className={field}
              value={scopes}
              placeholder="mcp.read mcp.write"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setScopes(event.target.value)}
            />
          </label>
        </div>
      ) : null}
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
