import type { ReactNode } from "react";
import { EnterpriseCustomerForm } from "./EnterpriseCustomerForm.js";
import { EnterpriseLogin } from "./EnterpriseLogin.js";
import { EnterpriseTopBar } from "./EnterpriseTopBar.js";
import type { CustomerDraft, EnterpriseUser, Tenant } from "./api.js";
import { button, zh } from "./presentation.js";

export function EnterpriseAppLayout({
  t,
  user,
  tenants,
  tenantId,
  busy,
  modelSettingsOpen,
  workspaceOpen,
  error,
  workspace,
  modelSettings,
  customerDialogOpen,
  customerDraft,
  setCustomerDraft,
  onTenantChange,
  onLogout,
  onLogin,
  onCreateCustomer,
  onCancelCustomer,
}: {
  t: typeof zh;
  user: EnterpriseUser | null;
  tenants: Tenant[];
  tenantId: string;
  busy: boolean;
  modelSettingsOpen: boolean;
  workspaceOpen: boolean;
  error: string;
  workspace: ReactNode;
  modelSettings: ReactNode;
  customerDialogOpen: boolean;
  customerDraft: CustomerDraft;
  setCustomerDraft: (draft: CustomerDraft) => void;
  onTenantChange: (tenantId: string) => void;
  onLogout: () => void;
  onLogin: (email: string, password: string) => void;
  onCreateCustomer: (draft: CustomerDraft) => void;
  onCancelCustomer: () => void;
}) {
  return (
    <div className="flex h-dvh min-h-dvh flex-col bg-background text-ui-base text-foreground">
      {!workspaceOpen ? (
        <EnterpriseTopBar
          t={t}
          user={user}
          tenants={tenants}
          tenantId={tenantId}
          busy={busy}
          tenantLocked={modelSettingsOpen}
          onTenantChange={onTenantChange}
          onLogout={onLogout}
        />
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-destructive bg-card px-3 py-2 text-ui-caption text-destructive sm:px-4"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className={button} onClick={() => location.reload()}>
            {t.retry}
          </button>
        </div>
      ) : null}
      {!user ? (
        <EnterpriseLogin t={t} busy={busy} onLogin={onLogin} />
      ) : (
        (modelSettings ?? workspace)
      )}
      {user && customerDialogOpen ? (
        <EnterpriseCustomerForm
          t={t}
          draft={customerDraft}
          setDraft={setCustomerDraft}
          busy={busy}
          onCreate={onCreateCustomer}
          onCancel={onCancelCustomer}
        />
      ) : null}
    </div>
  );
}
