import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { connectViaWebSocket } from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { zh, en } from "./presentation.js";
import { EnterpriseCaseHome } from "./EnterpriseCaseHome.js";
import { EnterpriseCaseWorkspace } from "./EnterpriseCaseWorkspace.js";
import { EnterpriseAppLayout } from "./EnterpriseAppLayout.js";
import { EnterpriseModelSettings } from "./EnterpriseModelSettings.js";
import type {
  ActiveCustomer,
  Customer,
  CustomerDraft,
  EnterpriseBootstrap,
} from "./api.js";
import type { EnterpriseRootContext, NativeServices } from "./EnterpriseNativeRoot.js";
import { useEnterpriseAction } from "./useEnterpriseAction.js";
import { useEnterpriseCustomerCatalog } from "./useEnterpriseCustomerCatalog.js";
import { useTenantModelStatus } from "./useTenantModelStatus.js";
import { createEnterpriseClient } from "./api.js";

const api = createEnterpriseClient();

interface NativeBinding {
  customerId: string;
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
  const [workspaceOpen, setWorkspaceOpen] = useState(Boolean(initial.activeCustomer));
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [native, setNative] = useState<NativeBinding | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const connectionGeneration = useRef(0);
  const { error, setError, busy, run } = useEnterpriseAction();
  const {
    modelReady,
    modelStatusLoaded,
    refresh: refreshModelStatus,
  } = useTenantModelStatus(bootstrap.user?.id, tenantId, setError);
  const [customerDraft, setCustomerDraft] = useState<CustomerDraft>({
    tenantId,
    name: "",
    type: "",
  });
  const [customers, setCustomers] = useEnterpriseCustomerCatalog({
    user: bootstrap.user,
    tenantId,
    tenants: bootstrap.tenants,
    activeCustomer: bootstrap.activeCustomer,
    onTenantResolved: setTenantId,
    setError,
  });

  const selectedTenant = bootstrap.tenants.find((tenant) => tenant.id === tenantId);
  const tenantName = selectedTenant?.name ?? t.select;
  const activeCustomer = bootstrap.activeCustomer;
  const workspaceTarget = activeCustomer;

  async function refresh() {
    const next = await api.bootstrap();
    if (!next) throw new Error("Enterprise gateway is unavailable");
    setBootstrap(next);
    return next;
  }

  /**
   * Invalidate the current generation before changing active customer. The Root
   * must be removed in the same event before the gateway mutation starts.
   */
  function disconnect() {
    connectionGeneration.current += 1;
    flushSync(() => {
      setNative(null);
      setWorkspaceOpen(false);
    });
    socketRef.current?.close();
    socketRef.current = null;
  }

  async function connect(target: ActiveCustomer) {
    const generation = connectionGeneration.current;
    const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";
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
    socketRef.current = opened.current;
    setNative({ customerId: target.id, services });
  }

  useEffect(() => {
    const target = workspaceOpen ? workspaceTarget : null;
    if (
      !target ||
      modelSettingsOpen ||
      !modelReady ||
      !bootstrap.user ||
      native?.customerId === target.id
    ) {
      return;
    }
    let stale = false;
    void connect(target).catch((cause: unknown) => {
      if (!stale) setError(String(cause));
    });
    return () => {
      stale = true;
    };
  }, [
    bootstrap.user?.id,
    modelReady,
    modelSettingsOpen,
    native?.customerId,
    setError,
    workspaceOpen,
    workspaceTarget?.id,
  ]);

  useEffect(() => () => socketRef.current?.close(), []);

  function openNewCustomer() {
    setModelSettingsOpen(false);
    setCustomerDraft({ tenantId, name: "", type: "" });
    setCustomerDialogOpen(true);
  }

  function openCustomer(customer: Customer) {
    void run(async () => {
      setModelSettingsOpen(false);
      setCustomerDialogOpen(false);
      if (activeCustomer?.id === customer.id) {
        setWorkspaceOpen(true);
        return;
      }
      disconnect();
      await api.activateCustomer(customer.id, bootstrap.csrfToken);
      const next = await refresh();
      if (next.activeCustomer?.id !== customer.id) {
        throw new Error("Customer activation did not return the selected workspace");
      }
      setWorkspaceOpen(true);
    });
  }

  function returnHome() {
    disconnect();
    setCustomerDialogOpen(false);
    setModelSettingsOpen(false);
  }

  function openModelSettings() {
    disconnect();
    setCustomerDialogOpen(false);
    setModelSettingsOpen(true);
  }

  function createCustomer(submitted: CustomerDraft) {
    void run(async () => {
      const created = await api.createCustomer(
        { ...submitted, tenantId, name: submitted.name.trim() },
        bootstrap.csrfToken,
      );
      disconnect();
      await api.activateCustomer(created.id, bootstrap.csrfToken);
      const next = await refresh();
      if (next.activeCustomer?.id !== created.id) {
        throw new Error("Customer activation did not return the newly created workspace");
      }
      setCustomers((current) => [...current.filter((item) => item.id !== created.id), created]);
      setCustomerDialogOpen(false);
      setWorkspaceOpen(true);
    });
  }

  function changeTenant(nextTenantId: string) {
    if (nextTenantId === tenantId) return;
    disconnect();
    setModelSettingsOpen(false);
    setTenantId(nextTenantId);
    setCustomers([]);
    setCustomerDraft((current) => ({ ...current, tenantId: nextTenantId, name: "", type: "" }));
  }

  function logout() {
    void run(async () => {
      disconnect();
      setModelSettingsOpen(false);
      await api.logout(bootstrap.csrfToken);
      setCustomers([]);
      await refresh();
    });
  }

  const enterpriseContext: EnterpriseRootContext = {
    user: bootstrap.user
      ? {
          id: bootstrap.user.id,
          email: bootstrap.user.email,
          displayName: bootstrap.user.displayName,
        }
      : null,
    tenants: bootstrap.tenants,
    activeTenantId: tenantId || null,
    customers:
      customers.length > 0
        ? customers
        : activeCustomer
          ? [{ id: activeCustomer.id, name: activeCustomer.name }]
          : [],
    activeCustomerId: activeCustomer?.id ?? null,
    onSelectCustomer: (customerId) => {
      const customer = customers.find((item) => item.id === customerId);
      if (customer) openCustomer(customer);
    },
    onSelectTenant: changeTenant,
    onOpenModelSettings: openModelSettings,
    onOpenCustomerHome: returnHome,
    onLogout: logout,
  };

  const workspace =
    workspaceTarget && workspaceOpen ? (
      <EnterpriseCaseWorkspace
        activeCustomer={workspaceTarget}
        modelReady={modelReady}
        modelStatusLoaded={modelStatusLoaded}
        t={t}
        native={native}
        platform={platform}
        onError={setError}
        onBack={returnHome}
        onOpenModelSettings={openModelSettings}
        enterpriseContext={enterpriseContext}
      />
    ) : (
      <EnterpriseCaseHome
        t={t}
        tenantName={tenantName}
        customers={customers}
        activeCustomerId={activeCustomer?.id}
        busy={busy}
        onOpenCustomer={openCustomer}
        onCreateCustomer={openNewCustomer}
        onOpenModelSettings={openModelSettings}
      />
    );

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
    <EnterpriseAppLayout
      t={t}
      user={bootstrap.user}
      tenants={bootstrap.tenants}
      tenantId={tenantId}
      busy={busy}
      modelSettingsOpen={modelSettingsOpen}
      workspaceOpen={workspaceOpen}
      error={error}
      workspace={workspace}
      modelSettings={modelSettings}
      customerDialogOpen={customerDialogOpen}
      customerDraft={customerDraft}
      setCustomerDraft={setCustomerDraft}
      onTenantChange={changeTenant}
      onLogout={logout}
      onLogin={(email, password) =>
        void run(async () => {
          await api.login(email, password, bootstrap.csrfToken);
          const next = await refresh();
          setTenantId(next.tenants[0]?.id ?? "");
        })
      }
      onCreateCustomer={createCustomer}
      onCancelCustomer={() => setCustomerDialogOpen(false)}
    />
  );
}
