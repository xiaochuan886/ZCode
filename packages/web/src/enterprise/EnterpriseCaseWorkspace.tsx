import type { IPlatformService } from "@zcode/shared";
import type { EnterpriseCase } from "./api.js";
import { EnterpriseCaseHeader } from "./EnterpriseCaseHeader.js";
import { EnterpriseNativeRoot, type NativeServices } from "./EnterpriseNativeRoot.js";
import { primary, zh } from "./presentation.js";

export function EnterpriseCaseWorkspace({
  activeCase,
  modelReady,
  modelStatusLoaded,
  cases,
  t,
  busy,
  native,
  platform,
  csrfToken,
  onError,
  onBack,
  onNewCase,
  onSelectCase,
  onStatusChange,
  onOpenModelSettings,
}: {
  activeCase: EnterpriseCase;
  modelReady: boolean;
  modelStatusLoaded: boolean;
  cases: EnterpriseCase[];
  t: typeof zh;
  busy: boolean;
  native: { caseId: string; services: NativeServices } | null;
  platform: IPlatformService;
  csrfToken: string | null;
  onError: (message: string) => void;
  onBack: () => void;
  onNewCase: () => void;
  onSelectCase: (caseId: string) => void;
  onStatusChange: (status: string) => void;
  onOpenModelSettings: () => void;
}) {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EnterpriseCaseHeader
        activeCase={activeCase}
        cases={cases}
        t={t}
        busy={busy}
        onBack={onBack}
        onNewCase={onNewCase}
        onSelectCase={onSelectCase}
        onStatusChange={onStatusChange}
        onOpenModelSettings={onOpenModelSettings}
      />
      <div
        id="enterprise-native-root"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {!modelStatusLoaded ? (
          <div className="flex min-h-40 items-center justify-center p-5 text-ui-base text-foreground-subtle">
            {t.loading}
          </div>
        ) : !modelReady ? (
          <div className="mx-auto flex min-h-full max-w-xl flex-col items-start justify-center gap-4 p-6">
            <h1 className="text-ui-xl font-medium">{t.modelSetupTitle}</h1>
            <p className="text-ui-sm text-foreground-subtle">{t.modelSetupHint}</p>
            <button type="button" className={primary} onClick={onOpenModelSettings}>
              {t.modelSettings}
            </button>
          </div>
        ) : native?.caseId === activeCase.id && activeCase.status !== "closed" ? (
          <EnterpriseNativeRoot
            activeCase={activeCase}
            services={native.services}
            platform={platform}
            csrfToken={csrfToken}
            onError={onError}
          />
        ) : (
          <div className="flex min-h-40 items-center justify-center p-5 text-ui-base text-foreground-subtle">
            {activeCase.status === "closed" ? t.closedCase : t.caseLoading}
          </div>
        )}
      </div>
    </main>
  );
}
