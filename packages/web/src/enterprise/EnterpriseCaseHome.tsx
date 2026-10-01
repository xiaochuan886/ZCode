import type { Customer } from "./api.js";
import { button, primary, zh } from "./presentation.js";

export function EnterpriseCaseHome({
  t,
  tenantName,
  customers,
  activeCustomerId,
  busy,
  onOpenCustomer,
  onCreateCustomer,
  onOpenModelSettings,
}: {
  t: typeof zh;
  tenantName: string;
  customers: Customer[];
  activeCustomerId?: string;
  busy: boolean;
  onOpenCustomer: (customer: Customer) => void;
  onCreateCustomer: () => void;
  onOpenModelSettings: () => void;
}) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-ui-caption text-foreground-subtle">{tenantName}</p>
            <h1 className="text-ui-xl font-medium">{t.customerHome}</h1>
            <p className="mt-1 max-w-2xl text-ui-sm text-foreground-subtle">{t.customerHomeHint}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={button} onClick={onOpenModelSettings} disabled={busy}>
              {t.modelSettings}
            </button>
            <button type="button" className={primary} onClick={onCreateCustomer} disabled={busy}>
              {t.newCustomer}
            </button>
          </div>
        </div>

        {customers.length === 0 ? (
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-ui-lg font-medium">{t.noCustomer}</h2>
            <p className="mt-2 text-ui-sm text-foreground-subtle">{t.noCustomerHint}</p>
            <button type="button" className={primary} onClick={onCreateCustomer} disabled={busy}>
              {t.newCustomer}
            </button>
          </section>
        ) : (
          <section
            aria-labelledby="enterprise-customer-list"
            className="flex flex-col gap-3"
            data-testid="enterprise-customer-list"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="enterprise-customer-list" className="text-ui-lg font-medium">
                {t.customers}
              </h2>
              <span className="text-ui-sm text-foreground-subtle">
                {customers.length} {t.customerCount}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {customers.map((customer) => (
                <article
                  key={customer.id}
                  data-testid={`enterprise-customer-card-${customer.id}`}
                  className={
                    activeCustomerId === customer.id
                      ? "flex min-h-40 flex-col gap-3 rounded-xl border border-primary bg-card-selected p-4 transition-colors"
                      : "flex min-h-40 flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors"
                  }
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                    disabled={busy}
                    data-testid={`enterprise-open-customer-${customer.id}`}
                    onClick={() => onOpenCustomer(customer)}
                  >
                    <strong className="block max-w-full truncate text-ui-base font-medium">
                      {customer.name}
                    </strong>
                    <span className="text-ui-sm text-foreground-subtle">
                      {customer.type || t.customerDefaultType}
                    </span>
                  </button>
                  <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
                    <button
                      type="button"
                      className="text-ui-xs text-primary underline-offset-2 hover:underline"
                      disabled={busy}
                      onClick={() => onOpenCustomer(customer)}
                    >
                      {t.openCustomer}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <p className="text-ui-sm text-foreground-subtlest">{t.customerHomeFootnote}</p>
      </div>
    </main>
  );
}
