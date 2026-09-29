import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { connectViaWebSocket } from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { button, field, zh, en } from "./presentation.js";
import { EnterpriseLogin } from "./EnterpriseLogin.js";
import { EnterpriseCaseForm } from "./EnterpriseCaseForm.js";
import { EnterpriseCaseHeader } from "./EnterpriseCaseHeader.js";
import { EnterpriseNativeRoot, type NativeServices } from "./EnterpriseNativeRoot.js";
import { useEnterpriseAction } from "./useEnterpriseAction.js";
import {
  createEnterpriseClient,
  type CaseDraft,
  type EnterpriseBootstrap,
  type EnterpriseCase,
  type ServiceObject,
  type ServiceSpace,
} from "./api.js";

const api = createEnterpriseClient();
interface NativeBinding {
  caseId: string;
  services: NativeServices;
  activeCase: EnterpriseCase;
}
export function EnterpriseApp({
  initial,
  platform,
}: {
  initial: EnterpriseBootstrap;
  platform: IPlatformService;
}) {
  const t = /^zh\b/i.test(navigator.language) ? zh : en;
  const [bootstrap, setBootstrap] = useState(initial);
  const [tenantId, setTenantId] = useState(initial.tenants[0]?.id ?? "");
  const [spaceId, setSpaceId] = useState(initial.activeCase?.serviceSpaceId ?? "");
  const [spaces, setSpaces] = useState<ServiceSpace[]>([]);
  const [objects, setObjects] = useState<ServiceObject[]>([]);
  const [cases, setCases] = useState<EnterpriseCase[]>([]);
  const [native, setNative] = useState<NativeBinding | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const connectionGeneration = useRef(0);
  const { error, setError, busy, run } = useEnterpriseAction();
  const [spaceName, setSpaceName] = useState("");
  const [objectName, setObjectName] = useState("");
  const [objectType, setObjectType] = useState("");
  const [draft, setDraft] = useState<CaseDraft>({
    serviceSpaceId: spaceId,
    serviceObjectId: "",
    title: "",
    category: "",
  });

  async function refresh() {
    const next = await api.bootstrap();
    if (!next) throw new Error("Enterprise gateway is unavailable");
    setBootstrap(next);
    return next;
  }
  function disconnect() {
    connectionGeneration.current += 1;
    flushSync(() => setNative(null));
    socket?.close();
    setSocket(null);
  }
  async function connect(activeCase: EnterpriseCase) {
    const generation = connectionGeneration.current;
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    const opened: { current: WebSocket | null } = { current: null };
    const services = await connectViaWebSocket(wsUrl, {
      onOpenSocket: (ws) => {
        opened.current = ws;
      },
    });
    if (generation !== connectionGeneration.current) {
      opened.current?.close();
      return;
    }
    setSocket(opened.current);
    setNative({ caseId: activeCase.id, services, activeCase });
  }
  useEffect(() => {
    if (!bootstrap.user || !tenantId) {
      setSpaces([]);
      return;
    }
    let stale = false;
    void api
      .spaces(tenantId)
      .then((value) => {
        if (!stale) setSpaces(value);
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [bootstrap.user, tenantId]);
  useEffect(() => {
    if (!bootstrap.user || !spaceId) {
      setObjects([]);
      setCases([]);
      return;
    }
    let stale = false;
    void Promise.all([api.objects(spaceId), api.cases(spaceId)])
      .then(([nextObjects, nextCases]) => {
        if (!stale) {
          setObjects(nextObjects);
          setCases(nextCases);
        }
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [bootstrap.user, spaceId]);
  useEffect(() => {
    const active = bootstrap.activeCase;
    if (!bootstrap.user || !active || active.status === "closed" || native?.caseId === active.id)
      return;
    let stale = false;
    void connect(active).catch((cause: unknown) => {
      if (!stale) setError(String(cause));
    });
    return () => {
      stale = true;
    };
    // Connect only on authorized active Case changes; switching explicitly disconnects first.
  }, [bootstrap.activeCase?.id, bootstrap.activeCase?.status, bootstrap.user]);
  useEffect(() => () => socket?.close(), [socket]);

  const activeCase = bootstrap.activeCase;
  function createCase(submittedDraft: CaseDraft) {
    void run(async () => {
      const created = await api.createCase(submittedDraft, bootstrap.csrfToken);
      setCases(await api.cases(spaceId));
      setDraft({ serviceSpaceId: spaceId, serviceObjectId: "", title: "", category: "" });
      disconnect();
      await api.activateCase(created.id, bootstrap.csrfToken);
      await refresh();
    });
  }
  const caseForm = (
    <EnterpriseCaseForm
      t={t} spaceId={spaceId} objects={objects} draft={draft}
      setDraft={setDraft} busy={busy}
      onCreate={createCase}
    />
  );
  return (
    <div className="flex h-dvh min-h-dvh flex-col bg-background text-ui-base text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-header px-4 py-2">
        <strong className="text-ui-lg">ZCode</strong>
        <span className="text-ui-caption text-foreground-subtle">Enterprise</span>
        {bootstrap.user && (
          <span className="ml-auto text-ui-caption text-foreground-subtle">
            {bootstrap.user.displayName || bootstrap.user.email}
          </span>
        )}
        {bootstrap.user && (
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                disconnect();
                await api.logout(bootstrap.csrfToken);
                await refresh();
              })
            }
          >
            {t.logout}
          </button>
        )}
      </header>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-destructive bg-card px-4 py-2 text-ui-caption text-destructive"
        >
          <span className="flex-1">{error}</span>
          <button className={button} onClick={() => location.reload()}>
            {t.retry}
          </button>
        </div>
      )}
      {!bootstrap.user ? (
        <EnterpriseLogin
          t={t}
          busy={busy}
          onLogin={(email, password) =>
            void run(async () => {
              await api.login(email, password, bootstrap.csrfToken);
              const next = await refresh();
              setTenantId(next.tenants[0]?.id ?? "");
            })
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex max-h-72 w-full shrink-0 flex-col gap-3 overflow-auto border-b border-border bg-sidebar p-3 md:max-h-none md:w-72 md:border-b-0 md:border-r">
            <label className="flex flex-col gap-1 text-ui-caption">
              {t.tenant}
              <select
                className={field}
                value={tenantId}
                onChange={(event) => {
                  setTenantId(event.target.value);
                  setSpaceId("");
                  setObjects([]);
                  setCases([]);
                }}
              >
                <option value="">{t.select}</option>
                {bootstrap.tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-ui-caption">
              {t.space}
              <select
                className={field}
                value={spaceId}
                onChange={(event) => {
                  setSpaceId(event.target.value);
                  setDraft((old) => ({
                    ...old,
                    serviceSpaceId: event.target.value,
                    serviceObjectId: "",
                  }));
                }}
              >
                <option value="">{t.select}</option>
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </label>
            {tenantId && (
              <form
                className="flex gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const created = await api.createSpace(
                      tenantId,
                      spaceName.trim(),
                      bootstrap.csrfToken,
                    );
                    setSpaces(await api.spaces(tenantId));
                    setSpaceId(created.id);
                    setSpaceName("");
                  });
                }}
              >
                <input
                  aria-label={t.newSpace}
                  className={`${field} flex-1`}
                  required
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  placeholder={t.newSpace}
                />
                <button className={button} disabled={busy}>
                  {t.create}
                </button>
              </form>
            )}
            {spaceId && (
              <>
                <div className="border-t border-border pt-2 text-ui-caption font-medium">
                  {t.object}
                </div>
                <div className="max-h-28 overflow-auto text-ui-caption">
                  {objects.map((object) => (
                    <div key={object.id} className="py-1">
                      {object.name} · {object.type}
                    </div>
                  ))}
                </div>
                <form
                  className="flex flex-col gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      const created = await api.createObject(
                        spaceId,
                        objectName.trim(),
                        objectType.trim(),
                        bootstrap.csrfToken,
                      );
                      setObjects(await api.objects(spaceId));
                      setDraft((current) => ({
                        ...current,
                        serviceSpaceId: spaceId,
                        serviceObjectId: created.id,
                      }));
                      setObjectName("");
                      setObjectType("");
                    });
                  }}
                >
                  <input
                    aria-label={t.newObject}
                    className={field}
                    required
                    value={objectName}
                    onChange={(event) => setObjectName(event.target.value)}
                    placeholder={t.newObject}
                  />
                  <input
                    aria-label={t.objectType}
                    className={field}
                    required
                    value={objectType}
                    onChange={(event) => setObjectType(event.target.value)}
                    placeholder={t.objectType}
                  />
                  <button className={button} disabled={busy}>
                    {t.create}
                  </button>
                </form>
                <div className="border-t border-border pt-2 text-ui-caption font-medium">
                  {t.cases}
                </div>
                <div className="flex flex-col gap-1">
                  {cases.map((item) => (
                    <button
                      key={item.id}
                      className={`${button} text-left ${activeCase?.id === item.id ? "bg-selected" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        activeCase?.id === item.id
                          ? undefined
                          : void run(async () => {
                              disconnect();
                              await api.activateCase(item.id, bootstrap.csrfToken);
                              await refresh();
                            })
                      }
                    >
                      {item.title}
                      <span className="block text-ui-sm text-foreground-subtle">
                        {item.serviceObject.name} · {item.status}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {activeCase ? (
              <>
                <EnterpriseCaseHeader
                  activeCase={activeCase}
                  t={t}
                  busy={busy}
                  onStatusChange={(status) =>
                    void run(async () => {
                      await api.updateCaseStatus(activeCase.id, status, bootstrap.csrfToken);
                      const next = await refresh();
                      setCases(await api.cases(activeCase.serviceSpaceId));
                      if (status === "closed" || !next.activeCase) disconnect();
                    })
                  }
                />
                <div className="min-h-0 flex-1">
                  {native?.caseId === activeCase.id && activeCase.status !== "closed" ? (
                    <EnterpriseNativeRoot
                      activeCase={activeCase}
                      services={native.services}
                      platform={platform}
                      csrfToken={bootstrap.csrfToken}
                      onError={setError}
                    />
                  ) : (
                    <div className="p-5 text-ui-base text-foreground-subtle">{t.loading}</div>
                  )}
                </div>
              </>
            ) : (
              <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
                <h1 className="text-ui-lg">{t.noCase}</h1>
                <p className="text-ui-sm text-foreground-subtle">{t.caseHint}</p>
                {caseForm}
              </div>
            )}
            {activeCase && caseForm}
          </main>
        </div>
      )}
    </div>
  );
}
