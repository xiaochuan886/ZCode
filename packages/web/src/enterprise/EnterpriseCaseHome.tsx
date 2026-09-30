import type { EnterpriseCase, ServiceSpace } from "./api.js";
import { button, primary, zh } from "./presentation.js";

export function EnterpriseCaseHome({
  t,
  tenantName,
  spaces,
  spaceId,
  cases,
  activeCaseId,
  busy,
  onSpaceChange,
  onOpenCase,
  onNewCase,
  onOpenModelSettings,
}: {
  t: typeof zh;
  tenantName: string;
  spaces: ServiceSpace[];
  spaceId: string;
  cases: EnterpriseCase[];
  activeCaseId?: string;
  busy: boolean;
  onSpaceChange: (spaceId: string) => void;
  onOpenCase: (item: EnterpriseCase) => void;
  onNewCase: () => void;
  onOpenModelSettings: () => void;
}) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-ui-caption text-foreground-subtle">{tenantName}</p>
            <h1 className="text-ui-xl font-medium">{t.caseHome}</h1>
            <p className="mt-1 max-w-2xl text-ui-sm text-foreground-subtle">{t.caseHomeHint}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-48 flex-col gap-1 text-ui-caption">
              {t.space}
              <select
                aria-label={t.space}
                className="min-w-0 rounded-lg border border-input-border bg-input px-3 py-2 text-ui-base text-foreground focus:border-input-border-focused focus:bg-input-focused"
                value={spaceId}
                onChange={(event) => onSpaceChange(event.target.value)}
                disabled={busy || spaces.length === 0}
              >
                <option value="">{spaces.length ? t.select : t.noSpace}</option>
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={button} onClick={onOpenModelSettings} disabled={busy}>
              {t.modelSettings}
            </button>
            <button type="button" className={primary} onClick={onNewCase} disabled={busy}>
              {t.newCase}
            </button>
          </div>
        </div>

        {spaces.length === 0 ? (
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-ui-lg font-medium">{t.noSpace}</h2>
            <p className="mt-2 text-ui-sm text-foreground-subtle">{t.noSpaceHint}</p>
            <button type="button" className={`${primary} mt-4`} onClick={onNewCase} disabled={busy}>
              {t.newCase}
            </button>
          </section>
        ) : cases.length === 0 ? (
          <section className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-ui-lg font-medium">{t.noCase}</h2>
            <p className="mt-2 text-ui-sm text-foreground-subtle">{t.caseHint}</p>
            <button type="button" className={`${primary} mt-4`} onClick={onNewCase} disabled={busy}>
              {t.newCase}
            </button>
          </section>
        ) : (
          <section aria-labelledby="enterprise-case-list" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="enterprise-case-list" className="text-ui-lg font-medium">
                {t.cases}
              </h2>
              <span className="text-ui-sm text-foreground-subtle">
                {cases.length} {t.caseCount}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {cases.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`flex min-h-32 flex-col items-start justify-between gap-4 rounded-xl border p-4 text-left transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60 ${
                    activeCaseId === item.id
                      ? "border-primary bg-card-selected"
                      : "border-border bg-card"
                  }`}
                  disabled={busy}
                  onClick={() => onOpenCase(item)}
                >
                  <span className="min-w-0">
                    <strong className="block truncate text-ui-base font-medium">
                      {item.title}
                    </strong>
                    <span className="mt-1 block truncate text-ui-sm text-foreground-subtle">
                      {item.serviceObject.name} · {item.serviceObject.type}
                    </span>
                  </span>
                  <span className="flex w-full items-center justify-between gap-2 text-ui-xs text-foreground-subtle">
                    <span>{item.category || "general"}</span>
                    <span>{item.status}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <p className="text-ui-sm text-foreground-subtlest">{t.caseHomeFootnote}</p>
      </div>
    </main>
  );
}
