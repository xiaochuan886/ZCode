import type { Dispatch, SetStateAction } from "react";
import { isCompleteCaseDraft, type CaseDraft, type ServiceObject } from "./api.js";
import { field, primary, zh } from "./presentation.js";

export function EnterpriseCaseForm({
  t,
  spaceId,
  objects,
  draft,
  setDraft,
  busy,
  onCreate,
}: {
  t: typeof zh;
  spaceId: string;
  objects: ServiceObject[];
  draft: CaseDraft;
  setDraft: Dispatch<SetStateAction<CaseDraft>>;
  busy: boolean;
  onCreate: (draft: CaseDraft) => void;
}) {
  if (!spaceId) return null;
  const submittedDraft = { ...draft, serviceSpaceId: spaceId };
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-border bg-panel p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (isCompleteCaseDraft(submittedDraft)) onCreate(submittedDraft);
      }}
    >
      <strong className="text-ui-caption">{t.newCase}</strong>
      <select
        aria-label={t.object}
        className={field}
        required
        value={draft.serviceObjectId}
        onChange={(event) =>
          setDraft({ ...draft, serviceSpaceId: spaceId, serviceObjectId: event.target.value })
        }
      >
        <option value="">{t.object}</option>
        {objects.map((object) => (
          <option key={object.id} value={object.id}>
            {object.name}
          </option>
        ))}
      </select>
      <input
        aria-label={t.title}
        className={field}
        required
        value={draft.title}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        placeholder={t.title}
      />
      <input
        aria-label={t.category}
        className={field}
        required
        value={draft.category}
        onChange={(event) => setDraft({ ...draft, category: event.target.value })}
        placeholder={t.category}
      />
      <button className={primary} disabled={busy || !isCompleteCaseDraft(submittedDraft)}>
        {t.create}
      </button>
    </form>
  );
}
