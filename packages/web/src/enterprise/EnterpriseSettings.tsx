import { useState } from "react";
import type { Customer, EnterpriseUser, Tenant } from "./api.js";
import { createEnterpriseClient } from "./api.js";
import { EnterpriseConnectorSettings } from "./EnterpriseConnectorSettings.js";
import { EnterpriseModelProviderSettings } from "./EnterpriseModelProviderSettings.js";
import { EnterpriseSkillSettings } from "./EnterpriseSkillSettings.js";
import { EnterpriseUserSettings } from "./EnterpriseUserSettings.js";
import { button, field, primary, zh } from "./presentation.js";

const api = createEnterpriseClient();

/**
 * 企业设置页(壳层):客户目录、共享 Skill 与连接器/模型供应商目录按角色分区,
 * 管理类变更仅租户管理员可见;专家日常入口在原生侧边栏,不经过此页。
 */
export function EnterpriseSettings({
  t,
  bootstrap,
  tenantId,
  tenantName,
  role,
  csrfToken,
  busy,
  customers,
  onCustomersChange,
  onClose,
  onLogout,
  onTenantChange,
}: {
  t: typeof zh;
  bootstrap: { user: EnterpriseUser | null; tenants: Tenant[] };
  tenantId: string;
  tenantName: string;
  role: "admin" | "member";
  csrfToken: string | null;
  busy: boolean;
  customers: Customer[];
  onCustomersChange: (updater: (current: Customer[]) => Customer[]) => void;
  onClose: () => void;
  onLogout: () => void;
  onTenantChange: (tenantId: string) => void;
}) {
  const isAdmin = role === "admin";
  const [view, setView] = useState<
    "overview" | "customers" | "users" | "skills" | "model" | "connectors"
  >("overview");
  const [customerName, setCustomerName] = useState("");
  const [customerType, setCustomerType] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  async function runAction(action: () => Promise<void>) {
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setActionBusy(false);
    }
  }

  function createCustomer() {
    if (!tenantId || !customerName.trim()) return;
    void runAction(async () => {
      const created = await api.createCustomer(
        { tenantId, name: customerName.trim(), type: customerType.trim() },
        csrfToken,
      );
      onCustomersChange((current) => [
        ...current.filter((item) => item.id !== created.id),
        created,
      ]);
      setCustomerName("");
      setCustomerType("");
    });
  }

  function renameCustomer(customer: Customer) {
    const next = window.prompt(t.customerName, customer.name);
    if (!next?.trim() || next.trim() === customer.name) return;
    void runAction(async () => {
      const updated = await api.updateCustomer(customer.id, { name: next.trim() }, csrfToken);
      onCustomersChange((current) =>
        current.map((item) => (item.id === updated.id ? { ...item, name: updated.name } : item)),
      );
    });
  }

  function deleteCustomer(customer: Customer) {
    if (!window.confirm(t.deleteCustomerConfirm.replace("{name}", customer.name))) return;
    void runAction(async () => {
      await api.deleteCustomer(customer.id, csrfToken);
      onCustomersChange((current) => current.filter((item) => item.id !== customer.id));
    });
  }

  const tabs: Array<{ id: typeof view; label: string; adminOnly?: boolean }> = [
    { id: "overview", label: t.settingsOverview },
    { id: "customers", label: t.customers, adminOnly: true },
    { id: "users", label: t.users, adminOnly: true },
    { id: "skills", label: t.sharedSkills, adminOnly: true },
    { id: "model", label: t.modelSettings },
    { id: "connectors", label: t.connectors },
  ];

  return (
    <div className="absolute inset-0 z-40 flex min-h-0 flex-col bg-background animate-in fade-in duration-200">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-header px-3 py-2 sm:px-4">
        <strong className="text-ui-lg">ZCode</strong>
        <span className="text-ui-caption text-foreground-subtle">Enterprise</span>
        {bootstrap.user ? (
          <label className="flex min-w-0 items-center gap-2 text-ui-caption text-foreground-subtle">
            <span className="sr-only">{t.tenant}</span>
            <select
              aria-label={t.tenant}
              className={`${field} max-w-48 px-2 py-1.5`}
              value={tenantId}
              onChange={(event) => onTenantChange(event.target.value)}
              disabled={busy || actionBusy}
            >
              {bootstrap.tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden max-w-48 truncate text-ui-caption text-foreground-subtle sm:inline">
            {bootstrap.user?.displayName || bootstrap.user?.email} ·{" "}
            {isAdmin ? t.roleAdmin : t.roleMember}
          </span>
          <button type="button" className={button} onClick={onLogout} disabled={busy}>
            {t.logout}
          </button>
          <button type="button" className={primary} onClick={onClose}>
            {t.backToWorkspace}
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-border p-2">
          {tabs
            .filter((tab) => !tab.adminOnly || isAdmin)
            .map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={
                  view === tab.id
                    ? "rounded-lg bg-selected px-3 py-2 text-left text-ui-base text-foreground"
                    : "rounded-lg px-3 py-2 text-left text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                }
                onClick={() => setView(tab.id)}
              >
                {tab.label}
              </button>
            ))}
        </nav>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {actionError ? (
            <p
              className="mb-3 rounded-lg border border-destructive bg-card px-3 py-2 text-ui-sm text-destructive"
              role="alert"
            >
              {actionError}
            </p>
          ) : null}
          {view === "overview" ? (
            <section className="flex flex-col gap-2">
              <h1 className="text-ui-xl font-medium">{t.settingsTitle}</h1>
              <p className="max-w-2xl text-ui-sm text-foreground-subtle">
                {tenantName} · {customers.length} {t.customerCount}
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {customers.map((customer) => (
                  <li key={customer.id} className="text-ui-sm text-foreground-subtle">
                    · {customer.name}
                    {customer.type ? `（${customer.type}）` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {view === "customers" && isAdmin ? (
            <section className="flex flex-col gap-4">
              <h1 className="text-ui-xl font-medium">{t.customers}</h1>
              <p className="max-w-2xl text-ui-sm text-foreground-subtle">{t.customerAdminHint}</p>
              <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3">
                <label className="flex flex-col gap-1 text-ui-sm">
                  {t.customerName}
                  <input
                    className={field}
                    value={customerName}
                    placeholder={t.customerNamePlaceholder}
                    onChange={(event) => setCustomerName(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-ui-sm">
                  {t.customerType}
                  <input
                    className={field}
                    value={customerType}
                    placeholder={t.customerTypePlaceholder}
                    onChange={(event) => setCustomerType(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={primary}
                  disabled={actionBusy || !customerName.trim()}
                  onClick={createCustomer}
                >
                  {t.newCustomer}
                </button>
              </div>
              <ul className="flex flex-col gap-2" data-testid="enterprise-settings-customers">
                {customers.map((customer) => (
                  <li
                    key={customer.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <div className="min-w-0">
                      <strong className="block truncate text-ui-sm font-medium">
                        {customer.name}
                      </strong>
                      <span className="block truncate text-ui-xs text-foreground-subtle">
                        {customer.type || t.customerDefaultType}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        className={button}
                        onClick={() => renameCustomer(customer)}
                      >
                        {t.rename}
                      </button>
                      <button
                        type="button"
                        className={button}
                        onClick={() => deleteCustomer(customer)}
                      >
                        {t.deleteCustomer}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {view === "skills" && isAdmin ? (
            <EnterpriseSkillSettings t={t} tenantId={tenantId} csrfToken={csrfToken} />
          ) : null}
          {view === "users" && isAdmin ? (
            <EnterpriseUserSettings
              t={t}
              tenantId={tenantId}
              csrfToken={csrfToken}
              customers={customers}
            />
          ) : null}
          {view === "model" ? (
            <EnterpriseModelProviderSettings
              t={t}
              tenantId={tenantId}
              role={role}
              csrfToken={csrfToken}
            />
          ) : null}
          {view === "connectors" ? (
            <EnterpriseConnectorSettings
              t={t}
              tenantId={tenantId}
              role={role}
              csrfToken={csrfToken}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}
