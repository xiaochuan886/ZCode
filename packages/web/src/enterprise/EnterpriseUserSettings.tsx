import { useCallback, useEffect, useState } from "react";
import {
  createEnterpriseClient,
  type Customer,
  type TenantCustomerAccessInput,
  type TenantUserView,
} from "./api.js";
import { badge, button, zh } from "./presentation.js";
import {
  EnterpriseCustomerAccessEditor,
  EnterpriseUserCreateForm,
  EnterpriseUserEditForm,
  type NewUserFormValue,
  type UserEditFormValue,
} from "./EnterpriseUserForm.js";

const api = createEnterpriseClient();

/** 卡片内联面板:编辑资料或客户可见性,同一时刻只展开一个。 */
type OpenPanel = { userId: string; panel: "edit" | "access" } | null;

/**
 * 用户 tab(仅管理员):成员是全局身份,此处做租户内的成员管理。新建按邮箱区分
 * 「创建账号」与「加入已有账号」并内联提示;编辑/禁用/移除与客户可见性按卡片展开。
 * 409 守卫(最后一个管理员/自禁自降)由后端裁决,消息原文内联展示。
 */
export function EnterpriseUserSettings({
  t,
  tenantId,
  csrfToken,
  customers,
}: {
  t: typeof zh;
  tenantId: string;
  csrfToken: string | null;
  customers: Customer[];
}) {
  const [users, setUsers] = useState<TenantUserView[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; joined: boolean } | null>(null);
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const [createFormNonce, setCreateFormNonce] = useState(0);

  const reload = useCallback(() => {
    if (!tenantId) return;
    api
      .tenantUsers(tenantId)
      .then((items) => {
        setUsers(items);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [tenantId]);

  useEffect(() => {
    // 切换租户时列表、展开面板与创建提示一并重置,避免残留上一租户的数据。
    setOpenPanel(null);
    setCreated(null);
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

  function createUser(value: NewUserFormValue) {
    if (!tenantId) return;
    void run(async () => {
      const result = await api.createTenantUser(tenantId, value, csrfToken);
      // 后端返回扁平投影 + joined;区分「加入已有账号」与「新建账号」,
      // 成功后内联提示并刷新列表。
      setCreated({ email: result.email, joined: result.joined });
      setCreateFormNonce((nonce) => nonce + 1);
      reload();
    });
  }

  function saveUser(user: TenantUserView, value: UserEditFormValue) {
    if (!tenantId) return;
    void run(async () => {
      // 空密码由 api 包装层剔除,表示保留当前密码。
      await api.updateTenantUser(
        tenantId,
        user.id,
        {
          displayName: value.displayName,
          role: value.role,
          password: value.password,
          status: value.status,
        },
        csrfToken,
      );
      setOpenPanel(null);
      reload();
    });
  }

  function saveCustomerAccess(user: TenantUserView, access: TenantCustomerAccessInput) {
    if (!tenantId) return;
    void run(async () => {
      await api.setTenantUserCustomerAccess(tenantId, user.id, access, csrfToken);
      setOpenPanel(null);
      reload();
    });
  }

  function removeUser(user: TenantUserView) {
    if (!tenantId) return;
    if (!window.confirm(t.removeUserConfirm.replace("{name}", user.displayName || user.email))) {
      return;
    }
    void run(async () => {
      await api.deleteTenantUser(tenantId, user.id, csrfToken);
      // 成员移除后其 socket 被网关销毁、运行时停止,本会话 socket 自愈,无需额外处理。
      reload();
    });
  }

  function customerAccessSummary(user: TenantUserView): string {
    return user.customerAccess?.mode === "selected"
      ? t.customerAccessSummaryCount.replace(
          "{count}",
          String(user.customerAccess.customerIds.length),
        )
      : t.customerAccessSummaryAll;
  }

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-ui-xl font-medium">{t.users}</h1>
      <p className="max-w-2xl text-ui-sm text-foreground-subtle">{t.usersHint}</p>
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
      <EnterpriseUserCreateForm key={createFormNonce} t={t} busy={busy} onSubmit={createUser} />
      {created ? (
        <p className="text-ui-sm text-foreground-subtle" role="status">
          {(created.joined ? t.userJoinedNotice : t.userCreatedNotice).replace(
            "{email}",
            created.email,
          )}
        </p>
      ) : null}
      {users.length === 0 && !failed ? (
        <p className="text-ui-sm text-foreground-subtle">{t.noUsers}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="enterprise-settings-users">
          {users.map((user) => {
            const panelOpen = openPanel?.userId === user.id ? openPanel.panel : null;
            return (
              <li
                key={user.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-ui-sm font-medium">
                    {user.displayName || user.email}
                  </strong>
                  {user.displayName && user.displayName !== user.email ? (
                    <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
                      {user.email}
                    </span>
                  ) : null}
                  <span
                    className={
                      user.role === "admin" ? `${badge} border-primary text-foreground` : badge
                    }
                  >
                    {user.role === "admin" ? t.roleAdmin : t.roleMember}
                  </span>
                  <span
                    className={
                      user.status === "disabled"
                        ? `${badge} border-destructive text-destructive`
                        : badge
                    }
                  >
                    {user.status === "disabled" ? t.userStatusDisabled : t.userStatusActive}
                  </span>
                  <span className={badge}>{customerAccessSummary(user)}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      setOpenPanel(panelOpen === "edit" ? null : { userId: user.id, panel: "edit" })
                    }
                  >
                    {t.edit}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      setOpenPanel(
                        panelOpen === "access" ? null : { userId: user.id, panel: "access" },
                      )
                    }
                  >
                    {t.customerAccess}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => removeUser(user)}
                  >
                    {t.removeUser}
                  </button>
                </div>
                {panelOpen === "edit" ? (
                  <EnterpriseUserEditForm
                    key={user.id}
                    t={t}
                    user={user}
                    busy={busy}
                    onSubmit={(value) => saveUser(user, value)}
                    onCancel={() => setOpenPanel(null)}
                  />
                ) : null}
                {panelOpen === "access" ? (
                  <EnterpriseCustomerAccessEditor
                    key={user.id}
                    t={t}
                    user={user}
                    customers={customers}
                    busy={busy}
                    onSubmit={(access) => saveCustomerAccess(user, access)}
                    onCancel={() => setOpenPanel(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
