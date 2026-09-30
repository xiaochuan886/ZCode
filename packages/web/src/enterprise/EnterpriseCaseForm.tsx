import { useState, type Dispatch, type SetStateAction } from "react";
import {
  isCompleteCaseDraft,
  type CaseDraft,
  type ServiceObject,
  type ServiceSpace,
} from "./api.js";
import { button, field, primary, zh } from "./presentation.js";

export function EnterpriseCaseForm({
  t,
  spaces,
  spaceId,
  objects,
  draft,
  setDraft,
  busy,
  onSpaceChange,
  onCreateSpace,
  onCreateObject,
  onCreate,
  onCancel,
}: {
  t: typeof zh;
  spaces: ServiceSpace[];
  spaceId: string;
  objects: ServiceObject[];
  draft: CaseDraft;
  setDraft: Dispatch<SetStateAction<CaseDraft>>;
  busy: boolean;
  onSpaceChange: (spaceId: string) => void;
  onCreateSpace: (name: string) => Promise<void>;
  onCreateObject: (name: string, type: string) => Promise<void>;
  onCreate: (draft: CaseDraft) => void;
  onCancel: () => void;
}) {
  const [spaceName, setSpaceName] = useState("");
  const [objectName, setObjectName] = useState("");
  const [objectType, setObjectType] = useState("");
  const normalizedDraft = {
    ...draft,
    serviceSpaceId: spaceId,
    category: draft.category.trim() || "general",
  };
  const canCreate = isCompleteCaseDraft(normalizedDraft);

  async function createSpace() {
    const name = spaceName.trim();
    if (!name) return;
    await onCreateSpace(name);
    setSpaceName("");
  }

  async function createObject() {
    const name = objectName.trim();
    const type = objectType.trim();
    if (!name || !type || !spaceId) return;
    await onCreateObject(name, type);
    setObjectName("");
    setObjectType("");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      role="presentation"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        aria-labelledby="enterprise-create-case-title"
        className="my-auto flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-popover-border bg-popover p-5 shadow-lg sm:p-6"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) onCreate(normalizedDraft);
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="enterprise-create-case-title" className="text-ui-xl font-medium">
              {t.newCase}
            </h2>
            <p className="mt-1 text-ui-sm text-foreground-subtle">{t.caseDialogHint}</p>
          </div>
          <button type="button" className={button} onClick={onCancel} disabled={busy}>
            {t.cancel}
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-ui-caption">
            {t.space}
            <select
              className={field}
              autoFocus={spaces.length > 0}
              value={spaceId}
              onChange={(event) => onSpaceChange(event.target.value)}
              disabled={busy}
            >
              <option value="">{spaces.length ? t.select : t.noSpace}</option>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </select>
          </label>

          {spaces.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
              <p className="text-ui-sm text-foreground-subtle">{t.createSpaceHint}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  aria-label={t.newSpace}
                  className={`${field} flex-1`}
                  autoFocus
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  placeholder={t.newSpace}
                  disabled={busy}
                />
                <button
                  type="button"
                  className={button}
                  onClick={() => void createSpace()}
                  disabled={busy || !spaceName.trim()}
                >
                  {t.createSpace}
                </button>
              </div>
            </div>
          ) : null}

          <label className="flex flex-col gap-1 text-ui-caption">
            {t.object}
            <select
              aria-label={t.object}
              className={field}
              value={draft.serviceObjectId}
              onChange={(event) =>
                setDraft((old) => ({
                  ...old,
                  serviceSpaceId: spaceId,
                  serviceObjectId: event.target.value,
                }))
              }
              disabled={busy || !spaceId}
            >
              <option value="">{spaceId ? t.selectObject : t.selectSpaceFirst}</option>
              {objects.map((object) => (
                <option key={object.id} value={object.id}>
                  {object.name} · {object.type}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            <div>
              <strong className="text-ui-caption font-medium">{t.createObjectInline}</strong>
              <p className="mt-1 text-ui-sm text-foreground-subtle">{t.createObjectHint}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                aria-label={t.newObject}
                className={field}
                value={objectName}
                onChange={(event) => setObjectName(event.target.value)}
                placeholder={t.newObject}
                disabled={busy || !spaceId}
              />
              <input
                aria-label={t.objectType}
                className={field}
                value={objectType}
                onChange={(event) => setObjectType(event.target.value)}
                placeholder={t.objectType}
                disabled={busy || !spaceId}
              />
            </div>
            <button
              type="button"
              className={`${button} self-start`}
              onClick={() => void createObject()}
              disabled={busy || !spaceId || !objectName.trim() || !objectType.trim()}
            >
              {t.createObject}
            </button>
          </div>

          <label className="flex flex-col gap-1 text-ui-caption">
            {t.title}
            <input
              className={field}
              required
              value={draft.title}
              onChange={(event) => setDraft((old) => ({ ...old, title: event.target.value }))}
              placeholder={t.titlePlaceholder}
              disabled={busy || !spaceId}
            />
          </label>

          <label className="flex flex-col gap-1 text-ui-caption">
            <span className="flex items-center gap-2">
              {t.category}
              <span className="text-ui-xs text-foreground-subtlest">{t.optional}</span>
            </span>
            <input
              className={field}
              value={draft.category}
              onChange={(event) => setDraft((old) => ({ ...old, category: event.target.value }))}
              placeholder={t.categoryPlaceholder}
              disabled={busy || !spaceId}
            />
          </label>
        </div>

        <div className="flex flex-col-reverse justify-end gap-2 border-t border-border pt-4 sm:flex-row">
          <button type="button" className={button} onClick={onCancel} disabled={busy}>
            {t.cancel}
          </button>
          <button type="submit" className={primary} disabled={busy || !canCreate}>
            {busy ? t.creating : t.createAndEnter}
          </button>
        </div>
      </form>
    </div>
  );
}
