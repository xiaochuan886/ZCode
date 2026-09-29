import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
import { connectViaWebSocket } from "@zcode/client";
import type { EnterpriseCase } from "./api.js";
import { EnterpriseSessionBinding } from "./EnterpriseSessionBinding.js";

export type NativeServices = Awaited<ReturnType<typeof connectViaWebSocket>>;
export function EnterpriseNativeRoot({
  activeCase,
  services,
  platform,
  csrfToken,
  onError,
}: {
  activeCase: EnterpriseCase;
  services: NativeServices;
  platform: IPlatformService;
  csrfToken: string | null;
  onError: (message: string) => void;
}) {
  return (
    <AppErrorBoundary>
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
      >
        <Root
          key={activeCase.id}
          services={services}
          platform={platform}
          initialWorkspaceAbsPath={activeCase.workspacePath}
          initialTaskId={activeCase.sessionId}
          restoreSession={false}
          allowOpenWorkspace={false}
          preferDirectoryBrowser
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
        />
        <EnterpriseSessionBinding
          caseId={activeCase.id}
          workspacePath={activeCase.workspacePath}
          csrfToken={csrfToken}
          onError={onError}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>
  );
}
