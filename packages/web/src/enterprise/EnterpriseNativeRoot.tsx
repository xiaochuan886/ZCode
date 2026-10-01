import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
import { connectViaWebSocket } from "@zcode/client";
import type { ActiveCustomer } from "./api.js";

export type NativeServices = Awaited<ReturnType<typeof connectViaWebSocket>>;
export interface EnterpriseRootContext {
  user: { id: string; email: string; displayName: string } | null;
  tenants: readonly { id: string; name: string; role?: "admin" | "member" }[];
  activeTenantId: string | null;
  customers: readonly { id: string; name: string; workspacePath?: string }[];
  activeCustomerId: string | null;
  onSelectCustomer: (customerId: string) => void | Promise<void>;
  onOpenCustomerWorkspace?: (workspacePath: string) => void | Promise<void>;
  onSelectTenant?: (tenantId: string) => void | Promise<void>;
  onOpenModelSettings?: () => void | void | Promise<void>;
  onOpenCustomerHome?: () => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
}
export function EnterpriseNativeRoot({
  runtimeKey,
  activeCustomer,
  services,
  platform,
  onError,
  enterpriseContext,
}: {
  /** 专家 runtime 会话标识(用户×租户);客户切换不重挂 Root。 */
  runtimeKey: string;
  activeCustomer: ActiveCustomer;
  services: NativeServices;
  platform: IPlatformService;
  onError: (message: string) => void;
  enterpriseContext?: EnterpriseRootContext;
}) {
  return (
    <AppErrorBoundary onCaughtReactError={(error) => onError(error.message)}>
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
      >
        <Root
          key={runtimeKey}
          services={services}
          platform={platform}
          initialWorkspaceAbsPath={activeCustomer.workspacePath}
          initialWorkspaceIdentity={activeCustomer.workspaceIdentity}
          enterpriseManagedModel
          restoreSession={false}
          allowOpenWorkspace={false}
          enterpriseContext={enterpriseContext}
          preferDirectoryBrowser
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>
  );
}
