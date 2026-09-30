import type { EnterpriseCase } from "./api.js";
import { statusChoices } from "./api.js";
import { button, field, primary, zh } from "./presentation.js";

export function EnterpriseCaseHeader({
  activeCase,
  cases,
  t,
  busy,
  onBack,
  onNewCase,
  onSelectCase,
  onStatusChange,
  onOpenModelSettings,
}: {
  activeCase: EnterpriseCase;
  cases: EnterpriseCase[];
  t: typeof zh;
  busy: boolean;
  onBack: () => void;
  onNewCase: () => void;
  onSelectCase: (caseId: string) => void;
  onStatusChange: (status: string) => void;
  onOpenModelSettings: () => void;
}) {
  const switcherCases = cases.some((item) => item.id === activeCase.id)
    ? cases
    : [activeCase, ...cases];
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2 sm:px-4">
      <button type="button" className={button} onClick={onBack} disabled={busy}>
        {t.backToCases}
      </button>
      <div className="min-w-0 flex-1 basis-48">
        <label className="sr-only" htmlFor="enterprise-case-switcher">
          {t.switchCase}
        </label>
        <select
          id="enterprise-case-switcher"
          className="max-w-full truncate rounded-lg border border-input-border bg-input px-2 py-1.5 text-ui-base font-medium text-foreground focus:border-input-border-focused focus:bg-input-focused"
          value={activeCase.id}
          onChange={(event) => onSelectCase(event.target.value)}
          disabled={busy}
        >
          {switcherCases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <p className="mt-1 truncate text-ui-xs text-foreground-subtle">
          {activeCase.serviceObject.name} · {activeCase.serviceObject.type}
        </p>
      </div>
      <div className="flex w-full items-center gap-2 overflow-x-auto sm:w-auto">
        <label className="flex shrink-0 items-center gap-1 text-ui-xs text-foreground-subtle">
          {t.status}
          <select
            className={`${field} px-2 py-1 text-ui-sm`}
            value={activeCase.status}
            disabled={busy}
            onChange={(event) => onStatusChange(event.target.value)}
          >
            {statusChoices(activeCase.status).map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`${button} shrink-0`}
          onClick={onOpenModelSettings}
          disabled={busy}
        >
          {t.modelSettings}
        </button>
        <button type="button" className={`${primary} shrink-0`} onClick={onNewCase} disabled={busy}>
          {t.newCase}
        </button>
      </div>
    </header>
  );
}
