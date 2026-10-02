import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZCodeMcpServer } from "@zcode/shared";
import {
  Button,
  McpServerForm,
  McpServerList,
  SettingsSegmentedTabs,
  TooltipProvider,
  ZCodeIntlProvider,
  type McpEditorMode,
  type McpFormState,
} from "@zcode/ui";
import { createEnterpriseClient, type TenantMcpConnectorView } from "./api.js";
import { badge, chip, zh } from "./presentation.js";
import { resolveConnectorTabStrings } from "./connector-tab-strings.js";
import {
  connectorToServerView,
  createConnectorFormInitial,
  formToConnectorCreateInput,
  formToConnectorPatch,
} from "./connector-form-adapter.js";

const api = createEnterpriseClient();

type ConnectorFormTarget = { mode: "create" } | { mode: "edit"; connector: TenantMcpConnectorView };

/** 租户目录没有工作区作用域:固定 user 作用域键,空 workspace 列表让原生 Scope 菜单只剩唯一选项,等价不可切换。 */
const TENANT_SCOPE_KEY = "user";

/**
 * 连接器 tab:租户级 MCP 连接器目录(管理员专属页面内的分区),复用原生
 * McpServerList/McpServerForm 展示与表单,网关目录行经 connector-form-adapter
 * 映射为原生视图模型。增删改与启停走现有目录 API;user-oauth 的连接/断开作用于
 * 操作者本人账号,保留在编辑视图的详情区。网关是目录不持有活动连接,列表状态点
 * 一律中性(hideMetadata 同时隐藏工具数与 scope 徽标)。
 */
export function EnterpriseConnectorSettings({
  t,
  tenantId,
  csrfToken,
}: {
  t: typeof zh;
  tenantId: string;
  csrfToken: string | null;
}) {
  const s = resolveConnectorTabStrings(t);
  const [connectors, setConnectors] = useState<TenantMcpConnectorView[]>([]);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<ConnectorFormTarget | null>(null);
  // 表单/JSON 编辑模式由本组件持有(与原生 McpSettingsSection 相同的父级职责)。
  const [editorMode, setEditorMode] = useState<McpEditorMode>("form");
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
    // 切换租户时目录、表单与编辑模式一并重置,避免残留上一租户的数据。
    setForm(null);
    setEditorMode("form");
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

  const servers = useMemo(() => connectors.map(connectorToServerView), [connectors]);
  // 编辑目标优先取目录最新行:表单打开期间连接/断开会 reload,详情区徽标不能停留在旧快照。
  const editing =
    form?.mode === "edit"
      ? (connectors.find((item) => item.id === form.connector.id) ?? form.connector)
      : null;

  function openCreate() {
    setEditorMode("form");
    setForm({ mode: "create" });
  }

  function openEdit(id: string) {
    const connector = connectors.find((item) => item.id === id);
    if (!connector) return;
    setEditorMode("form");
    setForm({ mode: "edit", connector });
  }

  function closeForm() {
    setForm(null);
    setEditorMode("form");
  }

  function handleSave(next: McpFormState, prev?: ZCodeMcpServer) {
    if (busy || !form) return;
    setError(null);
    if (form.mode === "edit") {
      // 编辑必须携带初始视图模型(prev):适配层用它识别「URL 未修改」而不下发。
      if (!prev) return;
      const mapped = formToConnectorPatch(next, prev);
      if (!mapped.ok) {
        setError(s[mapped.error]);
        return;
      }
      const connectorId = form.connector.id;
      void run(async () => {
        await api.updateMcpConnector(connectorId, mapped.value, csrfToken);
        closeForm();
        reload();
      });
      return;
    }
    const mapped = formToConnectorCreateInput(next);
    if (!mapped.ok) {
      setError(s[mapped.error]);
      return;
    }
    void run(async () => {
      await api.createMcpConnector(tenantId, mapped.value, csrfToken);
      closeForm();
      reload();
    });
  }

  function toggleEnabled(id: string, enabled: boolean) {
    void run(async () => {
      await api.updateMcpConnector(id, { enabled }, csrfToken);
      reload();
    });
  }

  function removeConnector(connector: TenantMcpConnectorView) {
    if (!window.confirm(t.deleteConnectorConfirm.replace("{name}", connector.displayName))) return;
    void run(async () => {
      await api.deleteMcpConnector(connector.id, csrfToken);
      closeForm();
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

  /** 编辑视图详情区:原生行/表单不承载的企业语义(认证模式、授权状态、连接/断开)。 */
  function renderEditingContext(connector: TenantMcpConnectorView) {
    const isOauth = connector.authMode === "user-oauth";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <code className={chip}>{connector.connectorKey}</code>
        <span className={badge}>{isOauth ? t.userConnectorBadge : t.systemConnectorBadge}</span>
        <span
          className={
            (isOauth ? connector.authorized : connector.secretConfigured)
              ? badge
              : `${badge} border-destructive text-destructive`
          }
        >
          {isOauth
            ? connector.authorized
              ? t.connectorConnected
              : t.connectorNotConnected
            : connector.secretConfigured
              ? t.secretConfigured
              : t.secretNotConfigured}
        </span>
        {isOauth ? (
          connector.authorized ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => disconnectConnector(connector)}
            >
              {t.connectorDisconnect}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => connectConnector(connector)}
            >
              {t.connectorConnect}
            </Button>
          )
        ) : null}
      </div>
    );
  }

  function renderForm() {
    if (!form) return null;
    const creating = form.mode === "create";
    // 新建也传入 http 占位初始:原生空表单默认 stdio,连接器恒为 http;
    // 编辑用目录行视图模型(名称=displayName,URL=主机名占位)。
    const initial = creating ? createConnectorFormInitial() : connectorToServerView(form.connector);
    return (
      <div className="space-y-4" data-testid="enterprise-connector-form">
        {/* 页头镜像原生 McpSettingsSection 的表单视图:标题/描述居左,编辑模式切换居右。 */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {creating ? s.formCreateTitle : s.formEditTitle}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {creating ? s.formCreateHint : s.formEditHint}
            </p>
          </div>
          <div className="shrink-0 self-end">
            <SettingsSegmentedTabs
              items={[
                { value: "form", label: s.editorModeFormLabel },
                { value: "json", label: s.editorModeJsonLabel },
              ]}
              value={editorMode}
              onValueChange={(mode) => {
                // busy 期间禁止切换,避免提交中途改变字段集。
                if (!busy) setEditorMode(mode);
              }}
            />
          </div>
        </div>
        {editing ? renderEditingContext(editing) : null}
        <McpServerForm
          key={creating ? "create" : `edit:${form.connector.id}`}
          initial={initial}
          // 刻意不传 editingId:原生语义里 editingId 冻结「名称」框(server key 不可改),
          // 连接器的名称映射 displayName(可改),connectorKey 由服务端拒绝修改兜底。
          editorMode={editorMode}
          onEditorModeChange={setEditorMode}
          scopeKey={TENANT_SCOPE_KEY}
          workspaceTabs={[]}
          onScopeKeyChange={() => {
            /* 固定 user 作用域:租户目录无工作区可切换,忽略菜单回传。 */
          }}
          onSave={handleSave}
          onCancel={closeForm}
          onDelete={editing ? (server) => openDelete(server) : undefined}
        />
        {/* 通道约定提示:原生表单没有密钥引用/OAuth 客户端字段,告知管理员经由哪两个通道携带。 */}
        <div className="space-y-1">
          <p className="text-ui-sm text-foreground-subtle">{s.formUrlHostHint}</p>
          <p className="text-ui-sm text-foreground-subtle">{s.formSharedSecretHint}</p>
          <p className="text-ui-sm text-foreground-subtle">{s.formOauthJsonHint}</p>
        </div>
      </div>
    );
  }

  /** onDelete 以原生表单的初始视图模型回调,按 id 找回目录行执行删除确认。 */
  function openDelete(server: ZCodeMcpServer) {
    const connector = connectors.find((item) => item.id === server.id);
    if (connector) removeConnector(connector);
  }

  return (
    // 企业设置浮层渲染在全局 ZCodeIntlProvider 之外(main.tsx 只给原生 Root 挂了 Provider),
    // 而原生列表/表单(McpServerList/McpServerForm)内部调用 useZCodeIntl,缺省会抛错。
    // 这里以无服务形态就近补一层:语言按本地偏好/浏览器语言解析,不引入任何服务 hook。
    <ZCodeIntlProvider>
      {/* TooltipProvider 同样缺省:原生组件内的 ControlHintTooltip(状态点等)依赖它,
          原生只在 Root 内挂载,这里与 IntlProvider 一起就地补齐。 */}
      <TooltipProvider>
        <section className="flex flex-col gap-4">
          <h1 className="text-ui-xl font-medium">{t.connectors}</h1>
          <p className="max-w-2xl text-ui-sm text-foreground-subtle">{t.connectorHint}</p>
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
            renderForm()
          ) : (
            <>
              <div>
                <Button type="button" variant="outline" size="lg" onClick={openCreate}>
                  {t.newConnector}
                </Button>
              </div>
              {/* data-testid 沿用旧手写列表的钩子,供既有 E2E 定位整个列表。 */}
              <div data-testid="enterprise-settings-connectors">
                <McpServerList
                  servers={servers}
                  onCreate={openCreate}
                  onEdit={(server) => openEdit(server.id)}
                  onToggle={toggleEnabled}
                  hideMetadata
                  emptyTitle={t.noConnectors}
                  emptyDescription={s.listEmptyDescription}
                />
              </div>
            </>
          )}
        </section>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
