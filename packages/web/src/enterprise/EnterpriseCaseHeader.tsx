import type { EnterpriseCase } from "./api.js";
import { statusChoices } from "./api.js";
import { field, zh } from "./presentation.js";

export function EnterpriseCaseHeader({
  activeCase,
  t,
  busy,
  onStatusChange,
}: {
  activeCase: EnterpriseCase;
  t: typeof zh;
  busy: boolean;
  onStatusChange: (status: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-2 text-ui-caption">
      <span className="text-foreground-subtle">{t.context}</span>
      <strong>{activeCase.title}</strong>
      <span>
        {activeCase.serviceObject.name} · {activeCase.category}
      </span>
      <label className="ml-auto flex items-center gap-2">
        {t.status}
        <select
          className={field}
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
    </div>
  );
}
