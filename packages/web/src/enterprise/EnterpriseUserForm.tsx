import { useState } from "react";
import type {
  Customer,
  TenantCustomerAccessInput,
  TenantUserRole,
  TenantUserStatus,
  TenantUserView,
} from "./api.js";
import { button, field, primary, zh } from "./presentation.js";

export interface NewUserFormValue {
  email: string;
  displayName: string;
  password: string;
  role: TenantUserRole;
}

/**
 * 新建成员表单:email 必填;初始密码仅全新全局用户需要,已有邮箱加入时留空
 * (新建与加入由后端按邮箱判断),因此密码不做必填校验,只用提示说明语义。
 */
export function EnterpriseUserCreateForm({
  t,
  busy,
  onSubmit,
}: {
  t: typeof zh;
  busy: boolean;
  onSubmit: (value: NewUserFormValue) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<TenantUserRole>("member");
  const complete = email.trim() !== "";

  function submit() {
    if (!complete || busy) return;
    onSubmit({
      email: email.trim(),
      displayName: displayName.trim(),
      password,
      role,
    });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="enterprise-user-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.email}
          <input
            className={field}
            type="email"
            placeholder="member@example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.userDisplayName}
          <input
            className={field}
            autoComplete="off"
            disabled={busy}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.userRole}
          <select
            className={field}
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
          >
            <option value="member">{t.roleMember}</option>
            <option value="admin">{t.roleAdmin}</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-ui-sm">
        {t.userInitialPassword}
        <input
          className={field}
          type="password"
          autoComplete="new-password"
          disabled={busy}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <span className="text-ui-xs text-foreground-subtle">{t.userInitialPasswordHint}</span>
      </label>
      <div className="flex justify-end">
        <button type="submit" className={primary} disabled={busy || !complete}>
          {t.newUser}
        </button>
      </div>
    </form>
  );
}

export interface UserEditFormValue {
  displayName: string;
  role: TenantUserRole;
  password: string;
  status: TenantUserStatus;
}

/**
 * 编辑成员表单(卡片内展开):显示名称、角色、状态;重置密码留空表示保留当前密码。
 * 通过外层 key=user.id 重挂载来重置草稿,组件内部不监听 user 变化。
 * 降级/禁用等被 409 守卫拒绝时,错误由父层 run() 内联展示后端消息。
 */
export function EnterpriseUserEditForm({
  t,
  user,
  busy,
  onSubmit,
  onCancel,
}: {
  t: typeof zh;
  user: TenantUserView;
  busy: boolean;
  onSubmit: (value: UserEditFormValue) => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<TenantUserRole>(user.role);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<TenantUserStatus>(user.status);
  const complete = displayName.trim() !== "";

  function submit() {
    if (!complete || busy) return;
    onSubmit({
      displayName: displayName.trim(),
      role,
      password,
      status,
    });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="enterprise-user-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-ui-sm">
          {t.userDisplayName}
          <input
            className={field}
            autoComplete="off"
            disabled={busy}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.userRole}
          <select
            className={field}
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
          >
            <option value="member">{t.roleMember}</option>
            <option value="admin">{t.roleAdmin}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-ui-sm">
          {t.userStatus}
          <select
            className={field}
            value={status}
            disabled={busy}
            onChange={(event) =>
              setStatus(event.target.value === "disabled" ? "disabled" : "active")
            }
          >
            <option value="active">{t.userStatusActive}</option>
            <option value="disabled">{t.userStatusDisabled}</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-ui-sm">
        {t.resetPassword}
        <input
          className={field}
          type="password"
          autoComplete="new-password"
          disabled={busy}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <span className="text-ui-xs text-foreground-subtle">{t.resetPasswordKeepHint}</span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel} disabled={busy}>
          {t.cancel}
        </button>
        <button type="submit" className={primary} disabled={busy || !complete}>
          {t.save}
        </button>
      </div>
    </form>
  );
}

/**
 * 客户可见性编辑器(卡片内展开):mode all 恢复默认可见全部;selected 至少勾选
 * 一个客户,空选时禁用保存并提示(后端同样校验非空)。管理员不受限,给出说明。
 */
export function EnterpriseCustomerAccessEditor({
  t,
  user,
  customers,
  busy,
  onSubmit,
  onCancel,
}: {
  t: typeof zh;
  user: TenantUserView;
  customers: Customer[];
  busy: boolean;
  onSubmit: (access: TenantCustomerAccessInput) => void;
  onCancel: () => void;
}) {
  const initialSelected =
    user.customerAccess?.mode === "selected" ? user.customerAccess.customerIds : [];
  const [mode, setMode] = useState<"all" | "selected">(
    user.customerAccess?.mode === "selected" ? "selected" : "all",
  );
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const invalid = mode === "selected" && selected.length === 0;

  function toggle(customerId: string) {
    setSelected((current) =>
      current.includes(customerId)
        ? current.filter((item) => item !== customerId)
        : [...current, customerId],
    );
  }

  function submit() {
    if (busy || invalid) return;
    // mode all 时省略 customerIds,由服务端清空授权(切回全部可见)。
    onSubmit({
      mode,
      ...(mode === "selected" ? { customerIds: selected } : {}),
    });
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="enterprise-user-access-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-ui-xs text-foreground-subtle">{t.customerAccessHint}</p>
      {user.role === "admin" ? (
        <p className="text-ui-xs text-foreground-subtle">{t.customerAccessAdminNote}</p>
      ) : null}
      <label className="flex flex-col gap-1 text-ui-sm">
        {t.customerAccessMode}
        <select
          className={field}
          value={mode}
          disabled={busy}
          onChange={(event) => setMode(event.target.value === "selected" ? "selected" : "all")}
        >
          <option value="all">{t.customerAccessModeAll}</option>
          <option value="selected">{t.customerAccessModeSelected}</option>
        </select>
      </label>
      {mode === "selected" ? (
        <div className="flex flex-col gap-1">
          {customers.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">{t.noCustomer}</p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {customers.map((customer) => (
                <li key={customer.id}>
                  <label className="flex items-center gap-2 text-ui-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(customer.id)}
                      disabled={busy}
                      onChange={() => toggle(customer.id)}
                    />
                    <span className="min-w-0 truncate">{customer.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {invalid ? (
            <p className="text-ui-xs text-destructive" role="alert">
              {t.customerAccessEmptyInvalid}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel} disabled={busy}>
          {t.cancel}
        </button>
        <button type="submit" className={primary} disabled={busy || invalid}>
          {t.save}
        </button>
      </div>
    </form>
  );
}
