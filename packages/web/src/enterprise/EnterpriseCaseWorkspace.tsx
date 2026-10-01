import type { IPlatformService } from "@zcode/shared";
import type { ActiveCustomer } from "./api.js";
import {
  EnterpriseNativeRoot,
  type EnterpriseRootContext,
  type NativeServices,
} from "./EnterpriseNativeRoot.js";
import { primary, zh } from "./presentation.js";

export function EnterpriseCaseWorkspace({
  activeCustomer,
  modelReady,
  modelStatusLoaded,
  t,
  native,
  platform,
  onError,
  onBack,
  onOpenModelSettings,
  enterpriseContext,
}: {
  activeCustomer: ActiveCustomer;
  modelReady: boolean;
  modelStatusLoaded: boolean;
  t: typeof zh;
  native: { customerId: string; services: NativeServices } | null;
  platform: IPlatformService;
  onError: (message: string) => void;
  onBack: () => void;
  onOpenModelSettings: () => void;
  enterpriseContext?: EnterpriseRootContext;
}) {
  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div id="enterprise-native-root" className="min-h-0 min-w-0 flex-1">
        {!modelStatusLoaded ? (
          <div className="flex min-h-40 items-center justify-center p-5 text-ui-base text-foreground-subtle">
            {t.loading}
          </div>
        ) : !modelReady ? (
          <div className="mx-auto flex min-h-full max-w-xl flex-col items-start justify-center gap-4 p-6">
            <h1 className="text-ui-xl font-medium">{t.modelSetupTitle}</h1>
            <p className="text-ui-sm text-foreground-subtle">{t.modelSetupHint}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primary} onClick={onOpenModelSettings}>
                {t.modelSettings}
              </button>
              <button
                type="button"
                className="rounded-lg border border-border px-3 py-2 text-ui-base"
                onClick={onBack}
              >
                {t.backToCustomers}
              </button>
            </div>
          </div>
        ) : native?.customerId === activeCustomer.id ? (
          <EnterpriseNativeRoot
            activeCustomer={activeCustomer}
            services={native.services}
            platform={platform}
            onError={onError}
            enterpriseContext={enterpriseContext}
          />
        ) : (
          <div className="flex min-h-40 items-center justify-center p-5 text-ui-base text-foreground-subtle">
            {t.customerLoading}
          </div>
        )}
      </div>
    </main>
  );
}
