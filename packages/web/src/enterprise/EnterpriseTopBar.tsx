import type { EnterpriseUser, Tenant } from "./api.js";
import { button, field, zh } from "./presentation.js";

export function EnterpriseTopBar({
  t,
  user,
  tenants,
  tenantId,
  busy,
  tenantLocked,
  onTenantChange,
  onLogout,
}: {
  t: typeof zh;
  user: EnterpriseUser | null;
  tenants: Tenant[];
  tenantId: string;
  busy: boolean;
  tenantLocked: boolean;
  onTenantChange: (tenantId: string) => void;
  onLogout: () => void;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-header px-3 py-2 sm:px-4">
      <strong className="text-ui-lg">ZCode</strong>
      <span className="text-ui-caption text-foreground-subtle">Enterprise</span>
      {user ? (
        <label className="flex min-w-0 items-center gap-2 text-ui-caption text-foreground-subtle">
          <span className="sr-only">{t.tenant}</span>
          <select
            aria-label={t.tenant}
            className={`${field} max-w-48 px-2 py-1.5`}
            value={tenantId}
            onChange={(event) => onTenantChange(event.target.value)}
            disabled={busy || tenantLocked}
          >
            <option value="">{t.select}</option>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {user ? (
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden max-w-48 truncate text-ui-caption text-foreground-subtle sm:inline">
            {user.displayName || user.email}
          </span>
          <button type="button" className={button} disabled={busy} onClick={onLogout}>
            {t.logout}
          </button>
        </div>
      ) : null}
    </header>
  );
}
