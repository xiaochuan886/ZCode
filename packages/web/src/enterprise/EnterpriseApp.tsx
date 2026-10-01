import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { connectViaWebSocket } from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { zh, en } from "./presentation.js";
import { EnterpriseLogin } from "./EnterpriseLogin.js";
import { EnterpriseNativeRoot } from "./EnterpriseNativeRoot.js";
import { EnterpriseSettings } from "./EnterpriseSettings.js";
import type { EnterpriseBootstrap } from "./api.js";
import type { EnterpriseRootContext, NativeServices } from "./EnterpriseNativeRoot.js";
import { useEnterpriseAction } from "./useEnterpriseAction.js";
import { useEnterpriseCustomerCatalog } from "./useEnterpriseCustomerCatalog.js";
import { useTenantModelStatus } from "./useTenantModelStatus.js";
import { createEnterpriseClient } from "./api.js";

const api = createEnterpriseClient();

interface NativeBinding {
  /** 专家 runtime 会话标识:用户×租户。客户切换不重建连接。 */
  key: string;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [native, setNative] = useState<NativeBinding | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const connectionGeneration = useRef(0);
  const { error, setError, busy, run } = useEnterpriseAction();
  const {
    modelReady,
    modelStatusLoaded,
    refresh: refreshModelStatus,
  } = useTenantModelStatus(bootstrap.user?.id, tenantId, setError);
  const [customers, setCustomers] = useEnterpriseCustomerCatalog({
    user: bootstrap.user,
    tenantId,
    tenants: bootstrap.tenants,
    activeCustomer: bootstrap.activeCustomer,
    onTenantResolved: setTenantId,
    setError,
  });

  const selectedTenant = bootstrap.tenants.find((tenant) => tenant.id === tenantId);
  const activeCustomer = bootstrap.activeCustomer;
  const runtimeKey = bootstrap.user ? `${bootstrap.user.id}:${tenantId}` : null;

  async function refresh() {
    const next = await api.bootstrap();
    if (!next) throw new Error("Enterprise gateway is unavailable");
    setBootstrap(next);
    return next;
  }

  function disconnect() {
    connectionGeneration.current += 1;
    flushSync(() => {
      setNative(null);
    });
    socketRef.current?.close();
    socketRef.current = null;
  }

  async function connect() {
    const generation = connectionGeneration.current;
    const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";
    const opened: { current: WebSocket | null } = { current: null };
    const services = await connectViaWebSocket(wsUrl, {
      onOpenSocket: (ws) => {
        opened.current = ws;
      },
      onClose: () => {
        // 只处理非主动断开(租户切换/登出会先推进 generation)。网关在停专家 runtime
        // 时会销毁本会话 socket:这里卸载 Root 并触发重连,重连会重新 prepare 并拉起
        // 新 runtime;半开 socket 上的任何 RPC 都不会返回,必须自愈而不是等待。
        if (generation !== connectionGeneration.current) return;
        connectionGeneration.current += 1;
        socketRef.current = null;
        flushSync(() => {
          setNative(null);
        });
        setReconnectNonce((nonce) => nonce + 1);
      },
    });
    if (generation !== connectionGeneration.current) {
      opened.current?.close();
      return;
    }
    socketRef.current = opened.current;
    setNative((current) => (current ? current : { key: runtimeKey ?? "", services }));
  }

  // 登录前 initial.tenants 为空,tenantId 以空串起步;登录成功后必须从新 bootstrap
  // 解析出租户,否则客户目录 hook 拿空租户查询,首登会停在"暂无客户"死锁。
  useEffect(() => {
    if (!bootstrap.user) return;
    if (bootstrap.tenants.some((tenant) => tenant.id === tenantId)) return;
    setTenantId(bootstrap.tenants[0]?.id ?? "");
  }, [bootstrap, tenantId]);

  // 首次进入若没有活跃客户,自动激活租户下第一个客户,让 Root 有初始工作区。
  useEffect(() => {
    if (!bootstrap.user || !tenantId || activeCustomer) return;
    const first = customers.find((customer) => customer.tenantId === tenantId) ?? customers[0];
    if (!first) return;
    let stale = false;
    void api
      .activateCustomer(first.id, bootstrap.csrfToken)
      .then(refresh)
      .then((next) => {
        if (!stale && next.activeCustomer?.id !== first.id) {
          throw new Error("Customer activation did not return the selected workspace");
        }
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap.user?.id, activeCustomer?.id, tenantId, customers.length]);

  // 专家 runtime 连接:按 (用户, 租户) 一条连接,客户切换不触发重建;
  // reconnectNonce 在 socket 意外断开后推进,让本 effect 重新拉起连接。
  useEffect(() => {
    if (!bootstrap.user || !activeCustomer || !modelReady || native || !runtimeKey) {
      return;
    }
    let stale = false;
    void connect().catch((cause: unknown) => {
      if (!stale) setError(String(cause));
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap.user?.id, activeCustomer?.id, modelReady, native, runtimeKey, reconnectNonce]);

  useEffect(
    () => () => {
      // 卸载时先推进 generation,避免 onClose 在组件销毁后触发重连。
      connectionGeneration.current += 1;
      socketRef.current?.close();
    },
    [],
  );

  function activateBookkeeping(customerId: string) {
    if (activeCustomer?.id === customerId) return;
    void api
      .activateCustomer(customerId, bootstrap.csrfToken)
      .then(refresh)
      .catch((cause: unknown) => {
        setError(String(cause));
      });
  }

  function changeTenant(nextTenantId: string) {
    if (nextTenantId === tenantId) return;
    disconnect();
    setTenantId(nextTenantId);
    setCustomers([]);
    void refresh().catch((cause: unknown) => setError(String(cause)));
  }

  function logout() {
    void run(async () => {
      disconnect();
      await api.logout(bootstrap.csrfToken);
      setCustomers([]);
      await refresh();
    });
  }

  const enterpriseContext: EnterpriseRootContext | undefined = useMemo(() => {
    if (!bootstrap.user) return undefined;
    return {
      user: {
        id: bootstrap.user.id,
        email: bootstrap.user.email,
        displayName: bootstrap.user.displayName,
      },
      tenants: bootstrap.tenants,
      activeTenantId: tenantId || null,
      customers: customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        workspacePath: customer.workspacePath,
      })),
      activeCustomerId: activeCustomer?.id ?? null,
      onSelectCustomer: (customerId) => {
        activateBookkeeping(customerId);
      },
      onOpenCustomerWorkspace: (workspacePath: string) => {
        const customer = customers.find(
          (item) => item.workspacePath && item.workspacePath === workspacePath,
        );
        if (customer) activateBookkeeping(customer.id);
      },
      onSelectTenant: changeTenant,
      onOpenCustomerHome: () => setSettingsOpen(true),
      onLogout: logout,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap, tenantId, customers, activeCustomer?.id]);

  if (!bootstrap.user) {
    return (
      <div className="flex h-dvh min-h-dvh flex-col bg-background text-ui-base text-foreground">
        {error ? (
          <div
            role="alert"
            className="absolute inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-destructive bg-card px-3 py-2 text-ui-caption text-destructive"
          >
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              className="rounded-lg border border-border bg-surface px-3 py-1.5"
              onClick={() => location.reload()}
            >
              {t.retry}
            </button>
          </div>
        ) : null}
        <EnterpriseLogin
          t={t}
          busy={busy}
          onLogin={(email, password) => {
            void run(async () => {
              await api.login(email, password, null);
              await refresh();
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-dvh flex-col bg-background text-ui-base text-foreground">
      {error ? (
        <div
          role="alert"
          className="absolute inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-destructive bg-card px-3 py-2 text-ui-caption text-destructive"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            className="rounded-lg border border-border bg-surface px-3 py-1.5"
            onClick={() => location.reload()}
          >
            {t.retry}
          </button>
        </div>
      ) : null}
      {activeCustomer && modelStatusLoaded ? (
        modelReady ? (
          native ? (
            <EnterpriseNativeRoot
              runtimeKey={native.key}
              activeCustomer={activeCustomer}
              services={native.services}
              platform={platform}
              onError={setError}
              enterpriseContext={enterpriseContext}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-ui-sm text-foreground-subtle">
              {t.customerLoading}
            </div>
          )
        ) : (
          <div className="mx-auto flex min-h-full max-w-xl flex-col items-start justify-center gap-4 p-6">
            <h1 className="text-ui-xl font-medium">{t.modelSetupTitle}</h1>
            <p className="text-ui-sm text-foreground-subtle">{t.modelSetupHint}</p>
            <button
              type="button"
              className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground hover:bg-surface-hover"
              onClick={() => setSettingsOpen(true)}
            >
              {t.modelSettings}
            </button>
          </div>
        )
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <p className="text-ui-base text-foreground-subtle">{t.noCustomer}</p>
          <button
            type="button"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground hover:bg-surface-hover"
            onClick={() => setSettingsOpen(true)}
          >
            {t.openSettings}
          </button>
        </div>
      )}
      {settingsOpen ? (
        <EnterpriseSettings
          t={t}
          bootstrap={bootstrap}
          tenantId={tenantId}
          tenantName={selectedTenant?.name ?? t.select}
          role={selectedTenant?.role ?? "member"}
          csrfToken={bootstrap.csrfToken}
          busy={busy}
          customers={customers}
          onCustomersChange={setCustomers}
          onClose={() => {
            setSettingsOpen(false);
            void refreshModelStatus();
          }}
          onLogout={logout}
          onTenantChange={changeTenant}
        />
      ) : null}
    </div>
  );
}
