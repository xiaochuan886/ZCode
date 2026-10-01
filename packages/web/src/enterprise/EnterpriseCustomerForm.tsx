import type { CustomerDraft } from "./api.js";
import { button, field, primary, zh } from "./presentation.js";

export function EnterpriseCustomerForm({
  t,
  draft,
  setDraft,
  busy,
  onCreate,
  onCancel,
}: {
  t: typeof zh;
  draft: CustomerDraft;
  setDraft: (draft: CustomerDraft) => void;
  busy: boolean;
  onCreate: (draft: CustomerDraft) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/45 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="enterprise-customer-dialog-title"
        className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="enterprise-customer-dialog-title" className="text-ui-lg font-medium">
              {t.newCustomer}
            </h2>
            <p className="mt-1 text-ui-sm text-foreground-subtle">{t.customerDialogHint}</p>
          </div>
          <button type="button" className={button} onClick={onCancel} disabled={busy}>
            {t.cancel}
          </button>
        </div>
        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(draft);
          }}
        >
          <label className="flex flex-col gap-2 text-ui-sm font-medium">
            {t.customerName}
            <input
              className={field}
              name="customerName"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder={t.customerNamePlaceholder}
              autoFocus
              disabled={busy}
            />
          </label>
          <label className="flex flex-col gap-2 text-ui-sm font-medium">
            {t.customerType}
            <input
              className={field}
              name="customerType"
              value={draft.type ?? ""}
              onChange={(event) => setDraft({ ...draft, type: event.target.value })}
              placeholder={t.customerTypePlaceholder}
              disabled={busy}
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={button} onClick={onCancel} disabled={busy}>
              {t.cancel}
            </button>
            <button type="submit" className={primary} disabled={busy || !draft.name.trim()}>
              {busy ? t.creating : t.createAndOpen}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
