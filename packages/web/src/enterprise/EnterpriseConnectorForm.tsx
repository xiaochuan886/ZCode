import { useState, type ReactNode } from "react";
import { Button, Input, SettingsFormActions, SettingsSegmentedTabs } from "@zcode/ui";
import type { TenantMcpConnectorAuthMode, TenantMcpConnectorView } from "./api.js";
import { resolveConnectorTabStrings } from "./connector-tab-strings.js";
import { zh } from "./presentation.js";

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
 * 镜像原生 McpServerForm 的字段标签样式(字号/颜色/margin),保证两处表单并排时不走样。
 */
function ConnectorFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

/** 单个字段栈:标签 + 控件 + 可选说明,间距与原生表单的 space-y-1.5 一致。 */
function ConnectorField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <ConnectorFieldLabel>{label}</ConnectorFieldLabel>
      {children}
      {hint ? <p className="text-ui-sm text-foreground-subtle">{hint}</p> : null}
    </div>
  );
}

/**
 * 新增/编辑连接器共用表单:connectorKey 创建后不可变;shared 模式编辑 secretEnv,
 * 留空表示保留现有密钥引用;user-oauth 模式填写 OAuth 客户端配置,clientSecret
 * 留空表示保留当前值(公共客户端可为空)。通过外层 key 重挂载来重置草稿,
 * 组件内部不监听 initial 变化。
 *
 * 复用方式说明:租户连接器与原生 MCP server 字段语义分叉(secretEnv 是网关侧
 * 环境变量名而非 env 键值对、OAuth 客户端四件套无对应字段、无 scope/JSON 模式),
 * 直接复用 McpServerForm 需要扭曲 FormState,因此镜像其结构(同样的分节/标签/
 * 间距/校验呈现),用原生 Input/Button/SettingsFormActions/SettingsSegmentedTabs 搭建。
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
  const strings = resolveConnectorTabStrings(t);
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
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="enterprise-connector-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* 头部行镜像原生 MCP 表单页头:标题/描述居左,认证方式分段切换居右(原生 form/json 切换的位置)。 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-ui-xl font-semibold text-foreground">
            {editing ? strings.formEditTitle : strings.formCreateTitle}
          </h3>
          <p className="text-ui-base text-foreground-subtle">
            {editing ? strings.formEditHint : strings.formCreateHint}
          </p>
        </div>
        <div className="shrink-0 self-end">
          <SettingsSegmentedTabs
            items={[
              { value: "shared", label: t.authModeShared },
              { value: "user-oauth", label: t.authModeUserOauth },
            ]}
            value={authMode}
            onValueChange={(mode) => {
              // busy 期间禁止切换,避免提交中途改变字段集。
              if (!busy) setAuthMode(mode);
            }}
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
          <ConnectorField label={t.connectorKey} hint={t.connectorKeyHint}>
            <Input
              size="lg"
              placeholder="my-connector"
              value={connectorKey}
              autoComplete="off"
              spellCheck={false}
              disabled={editing || busy}
              onChange={(event) => setConnectorKey(event.target.value)}
            />
          </ConnectorField>
          <ConnectorField label={t.connectorDisplayName}>
            <Input
              size="lg"
              value={displayName}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </ConnectorField>
        </div>

        <ConnectorField label={t.connectorUrl} hint={editing ? strings.urlKeepHint : undefined}>
          <Input
            size="lg"
            type="url"
            placeholder={editing ? initial?.endpointHost : "https://mcp.example.com/sse"}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </ConnectorField>

        <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
          <ConnectorField label={t.connectorHeaderName}>
            <Input
              size="lg"
              value={headerName}
              placeholder={defaultHeaderName}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setHeaderName(event.target.value)}
            />
          </ConnectorField>
          {isOauth ? null : (
            <ConnectorField
              label={t.connectorSecretEnv}
              hint={editing ? strings.secretEnvKeepHint : t.connectorSecretEnvHint}
            >
              <Input
                size="lg"
                className="font-mono text-ui-base"
                value={secretEnv}
                placeholder="ZCODE_ENTERPRISE_MCP_SECRET_…"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setSecretEnv(event.target.value)}
              />
            </ConnectorField>
          )}
        </div>

        {isOauth ? (
          <div className="space-y-3">
            <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
              <ConnectorField label={t.connectorAuthorizeUrl}>
                <Input
                  size="lg"
                  type="url"
                  placeholder="https://provider.example.com/authorize"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  value={authorizeUrl}
                  onChange={(event) => setAuthorizeUrl(event.target.value)}
                />
              </ConnectorField>
              <ConnectorField label={t.connectorTokenUrl}>
                <Input
                  size="lg"
                  type="url"
                  placeholder="https://provider.example.com/token"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  value={tokenUrl}
                  onChange={(event) => setTokenUrl(event.target.value)}
                />
              </ConnectorField>
            </div>
            <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
              <ConnectorField label={t.connectorClientId}>
                <Input
                  size="lg"
                  value={clientId}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </ConnectorField>
              <ConnectorField
                label={t.connectorClientSecret}
                hint={t.connectorClientSecretKeepHint}
              >
                <Input
                  size="lg"
                  type="password"
                  value={clientSecret}
                  autoComplete="new-password"
                  disabled={busy}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </ConnectorField>
            </div>
            <ConnectorField label={t.connectorScopes}>
              <Input
                size="lg"
                value={scopes}
                placeholder="mcp.read mcp.write"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setScopes(event.target.value)}
              />
            </ConnectorField>
          </div>
        ) : null}
      </div>

      {/* 校验呈现与原生一致:不逐字段报错,不满足 complete 时禁用保存。 */}
      <SettingsFormActions>
        <Button type="submit" size="lg" disabled={busy || !complete}>
          {editing ? t.save : t.create}
        </Button>
        <Button type="button" variant="ghost" size="lg" disabled={busy} onClick={onCancel}>
          {t.cancel}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
