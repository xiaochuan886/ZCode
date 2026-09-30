import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { connectViaWebSocket } from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { button, zh, en } from "./presentation.js";
import { EnterpriseLogin } from "./EnterpriseLogin.js";
import { EnterpriseCaseForm } from "./EnterpriseCaseForm.js";
import { EnterpriseCaseHome } from "./EnterpriseCaseHome.js";
import { EnterpriseCaseWorkspace } from "./EnterpriseCaseWorkspace.js";
import { EnterpriseModelSettings } from "./EnterpriseModelSettings.js";
import { EnterpriseTopBar } from "./EnterpriseTopBar.js";
import type { NativeServices } from "./EnterpriseNativeRoot.js";
import { useEnterpriseAction } from "./useEnterpriseAction.js";
import { useTenantModelStatus } from "./useTenantModelStatus.js";
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
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [caseDialogOpen, setCaseDialogOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [native, setNative] = useState<NativeBinding | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const connectionGeneration = useRef(0);
  const { error, setError, busy, run } = useEnterpriseAction();
  const {
    modelReady,
    modelStatusLoaded,
    refresh: refreshModelStatus,
  } = useTenantModelStatus(bootstrap.user?.id, tenantId, setError);
  const [draft, setDraft] = useState<CaseDraft>({
    serviceSpaceId: spaceId,
    serviceObjectId: "",
    title: "",
    category: "general",
  });

  const activeCase = bootstrap.activeCase;
  const tenantName = bootstrap.tenants.find((tenant) => tenant.id === tenantId)?.name ?? t.select;

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

  async function connect(active: EnterpriseCase) {
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
    setNative({ caseId: active.id, services });
  }

  useEffect(() => {
    if (!bootstrap.user || !tenantId) {
      setSpaces([]);
      return;
    }
    let stale = false;
    void api
      .spaces(tenantId)
      .then((next) => {
        if (stale) return;
        setSpaces(next);
        setSpaceId((current) => {
          if (current && next.some((space) => space.id === current)) return current;
          return next[0]?.id ?? "";
        });
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [bootstrap.user?.id, tenantId, setError]);

  useEffect(() => {
    setDraft((current) =>
      current.serviceSpaceId === spaceId
        ? current
        : { ...current, serviceSpaceId: spaceId, serviceObjectId: "" },
    );
  }, [spaceId]);

  useEffect(() => {
    if (!bootstrap.user || !spaceId) {
      setObjects([]);
      setCases([]);
      return;
    }
    let stale = false;
    void Promise.all([api.objects(spaceId), api.cases(spaceId)])
      .then(([nextObjects, nextCases]) => {
        if (stale) return;
        setObjects(nextObjects);
        setCases(nextCases);
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [bootstrap.user?.id, spaceId, setError]);

  useEffect(() => {
    const selectedCase = bootstrap.activeCase;
    if (
      !workspaceOpen ||
      modelSettingsOpen ||
      !modelReady ||
      !bootstrap.user ||
      !selectedCase ||
      selectedCase.status === "closed" ||
      native?.caseId === selectedCase.id
    )
      return;
    let stale = false;
    void connect(selectedCase).catch((cause: unknown) => {
      if (!stale) setError(String(cause));
    });
    return () => {
      stale = true;
    };
    // 只有进入案例工作区后才连接 native Root；案例首页不会占用工作区 socket。
  }, [
    bootstrap.activeCase?.id,
    bootstrap.activeCase?.status,
    bootstrap.user?.id,
    native?.caseId,
    modelSettingsOpen,
    modelReady,
    setError,
    workspaceOpen,
  ]);

  useEffect(() => () => socket?.close(), [socket]);

  function selectSpace(nextSpaceId: string) {
    setSpaceId(nextSpaceId);
    setDraft((current) => ({ ...current, serviceSpaceId: nextSpaceId, serviceObjectId: "" }));
  }

  function openNewCase() {
    setModelSettingsOpen(false);
    setDraft({
      serviceSpaceId: spaceId,
      serviceObjectId: "",
      title: "",
      category: "general",
    });
    setCaseDialogOpen(true);
  }

  function openCase(item: EnterpriseCase) {
    void run(async () => {
      setModelSettingsOpen(false);
      if (activeCase?.id !== item.id) {
        disconnect();
        await api.activateCase(item.id, bootstrap.csrfToken);
        await refresh();
      }
      setSpaceId(item.serviceSpaceId);
      setCaseDialogOpen(false);
      setWorkspaceOpen(true);
    });
  }

  function returnHome() {
    disconnect();
    setCaseDialogOpen(false);
    setModelSettingsOpen(false);
    setWorkspaceOpen(false);
  }

  function openModelSettings() {
    disconnect();
    setModelSettingsOpen(true);
  }

  function createCase(submittedDraft: CaseDraft) {
    void run(async () => {
      const normalizedDraft = {
        ...submittedDraft,
        category: submittedDraft.category.trim() || "general",
      };
      const created = await api.createCase(normalizedDraft, bootstrap.csrfToken);
      setSpaceId(normalizedDraft.serviceSpaceId);
      setCases(await api.cases(normalizedDraft.serviceSpaceId));
      setDraft({
        serviceSpaceId: normalizedDraft.serviceSpaceId,
        serviceObjectId: "",
        title: "",
        category: "general",
      });
      disconnect();
      await api.activateCase(created.id, bootstrap.csrfToken);
      await refresh();
      setCaseDialogOpen(false);
      setWorkspaceOpen(true);
    });
  }

  async function createSpace(name: string) {
    await run(async () => {
      const created = await api.createSpace(tenantId, name, bootstrap.csrfToken);
      setSpaces(await api.spaces(tenantId));
      selectSpace(created.id);
    });
  }

  async function createObject(name: string, type: string) {
    await run(async () => {
      const created = await api.createObject(spaceId, name, type, bootstrap.csrfToken);
      setObjects(await api.objects(spaceId));
      setDraft((current) => ({
        ...current,
        serviceSpaceId: spaceId,
        serviceObjectId: created.id,
      }));
    });
  }

  function changeTenant(nextTenantId: string) {
    setModelSettingsOpen(false);
    setTenantId(nextTenantId);
    setSpaceId("");
    setSpaces([]);
    setObjects([]);
    setCases([]);
    setDraft((current) => ({ ...current, serviceSpaceId: "", serviceObjectId: "" }));
  }

  const workspace =
    workspaceOpen && activeCase ? (
      <EnterpriseCaseWorkspace
        activeCase={activeCase}
        modelReady={modelReady}
        modelStatusLoaded={modelStatusLoaded}
        cases={cases}
        t={t}
        busy={busy}
        native={native}
        platform={platform}
        csrfToken={bootstrap.csrfToken}
        onError={setError}
        onBack={returnHome}
        onNewCase={openNewCase}
        onOpenModelSettings={openModelSettings}
        onSelectCase={(caseId) => {
          const next = cases.find((item) => item.id === caseId);
          if (next) openCase(next);
        }}
        onStatusChange={(status) =>
          void run(async () => {
            await api.updateCaseStatus(activeCase.id, status, bootstrap.csrfToken);
            const next = await refresh();
            if (status === "closed" || !next.activeCase) {
              disconnect();
              setWorkspaceOpen(false);
            }
          })
        }
      />
    ) : (
      <EnterpriseCaseHome
        t={t}
        tenantName={tenantName}
        spaces={spaces}
        spaceId={spaceId}
        cases={cases}
        activeCaseId={activeCase?.id}
        busy={busy}
        onSpaceChange={selectSpace}
        onOpenCase={openCase}
        onNewCase={openNewCase}
        onOpenModelSettings={openModelSettings}
      />
    );

  const selectedTenant = bootstrap.tenants.find((tenant) => tenant.id === tenantId);
  const modelSettings = modelSettingsOpen ? (
    <EnterpriseModelSettings
      tenantId={tenantId}
      tenantName={tenantName}
      role={selectedTenant?.role ?? "member"}
      csrfToken={bootstrap.csrfToken}
      onBack={() => setModelSettingsOpen(false)}
      onSaved={() => {
        disconnect();
        void refreshModelStatus();
      }}
    />
  ) : null;

  return (
    <div className="flex h-dvh min-h-dvh flex-col bg-background text-ui-base text-foreground">
      <EnterpriseTopBar
        t={t}
        user={bootstrap.user}
        tenants={bootstrap.tenants}
        tenantId={tenantId}
        busy={busy}
        tenantLocked={workspaceOpen || modelSettingsOpen}
        onTenantChange={changeTenant}
        onLogout={() =>
          void run(async () => {
            disconnect();
            setWorkspaceOpen(false);
            setModelSettingsOpen(false);
            await api.logout(bootstrap.csrfToken);
            await refresh();
          })
        }
      />
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
        (modelSettings ?? workspace)
      )}
      {bootstrap.user && caseDialogOpen ? (
        <EnterpriseCaseForm
          t={t}
          spaces={spaces}
          spaceId={spaceId}
          objects={objects}
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          onSpaceChange={selectSpace}
          onCreateSpace={createSpace}
          onCreateObject={createObject}
          onCreate={createCase}
          onCancel={() => setCaseDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
