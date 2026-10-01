import {
  ICredentialService,
  IOAuthService,
  IProviderSettingsService,
  ISettingService,
  ServiceCollection,
  type ICredentialService as CredentialService,
  type IOAuthService as OAuthService,
  type IProviderSettingsService as ProviderSettingsService,
  type ISettingService as SettingService,
} from "@zcode/services";

/** 稳定错误码供企业 UI/远程客户端识别模型配置归管理员所有。 */
export const ENTERPRISE_MANAGED_MODEL_ERROR_CODE = "enterprise.model_configuration_managed";

const ENTERPRISE_MANAGED_MODEL_ERROR_MESSAGE =
  "Model configuration is managed by the enterprise administrator";

const managedModelSettingKeys = [
  "providerFamilyDomain",
  "providerFamilyConnectionSelections",
  "providerFamilyDomainUpdatedAt",
  "providerFamilyDomainMigrated",
] as const;

/** RPC 错误会透传 code；不要让调用方依赖易变的错误文案或堆栈。 */
export class EnterpriseManagedModelPolicyError extends Error {
  readonly code = ENTERPRISE_MANAGED_MODEL_ERROR_CODE;

  constructor() {
    super(ENTERPRISE_MANAGED_MODEL_ERROR_MESSAGE);
    this.name = "EnterpriseManagedModelPolicyError";
  }
}

function rejectManagedModelChange(): Promise<never> {
  return Promise.reject(new EnterpriseManagedModelPolicyError());
}

function hasManagedModelSetting(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return managedModelSettingKeys.some((key) => Object.hasOwn(value, key));
}

function wrapProviderSettings(service: ProviderSettingsService): ProviderSettingsService {
  return {
    onDidChange: service.onDidChange,
    getView: () => service.getView(),
    refresh: (reason) => service.refresh(reason),
    resolveModelConfig: (input) => service.resolveModelConfig(input),
    testModelConnectivity: (input) => service.testModelConnectivity(input),
    createPersonalProvider: rejectManagedModelChange,
    savePersonalProviderOverlay: rejectManagedModelChange,
    deletePersonalProvider: rejectManagedModelChange,
    reorderPersonalProviders: rejectManagedModelChange,
    reorderPersonalModels: rejectManagedModelChange,
    addPersonalModel: rejectManagedModelChange,
    renamePersonalModel: rejectManagedModelChange,
    deletePersonalModel: rejectManagedModelChange,
    savePersonalModelDraft: rejectManagedModelChange,
    setPersonalModelEnabled: rejectManagedModelChange,
  };
}

function wrapSettings(service: SettingService): SettingService {
  return {
    get: () => service.get(),
    update: async (patch, expectedAccountSettings) => {
      if (hasManagedModelSetting(patch) || hasManagedModelSetting(expectedAccountSettings)) {
        throw new EnterpriseManagedModelPolicyError();
      }
      await service.update(patch, expectedAccountSettings);
    },
    updateDataBaseDir: rejectManagedModelChange,
    ensureDefaultProject: (homedir) => service.ensureDefaultProject(homedir),
  };
}

function wrapOAuth(service: OAuthService): OAuthService {
  return {
    getProviders: () => service.getProviders(),
    getActiveProvider: () => service.getActiveProvider(),
    // 企业 runtime 没有个人 OAuth；避免调用原实现触发凭据迁移、登出或外部验证。
    restoreCachedSession: async () => null,
    restoreCachedSessionState: async () => ({ status: "signed-out" as const }),
    restoreSession: async () => null,
    startOAuth: rejectManagedModelChange,
    startOAuthWithPolling: rejectManagedModelChange,
    pollPendingOAuth: rejectManagedModelChange,
    handleCallback: rejectManagedModelChange,
    refreshToken: rejectManagedModelChange,
    logout: rejectManagedModelChange,
    logoutAll: rejectManagedModelChange,
    cancelPending: rejectManagedModelChange,
  };
}

function wrapCredentials(_service: CredentialService): CredentialService {
  return {
    load: rejectManagedModelChange,
    save: rejectManagedModelChange,
    delete: rejectManagedModelChange,
  };
}

/**
 * 仅企业 runtime 显式开启 managed model 时使用。
 * 普通 Web/远控不调用此函数，因此仍暴露原有 service 实例。
 */
export function createEnterpriseManagedModelOverrides(
  services: ServiceCollection,
  enabled: boolean,
): Map<string, unknown> {
  if (!enabled) return new Map();

  const overrides = new Map<string, unknown>();
  const providerSettings = services.getOptional(IProviderSettingsService);
  if (providerSettings) {
    overrides.set(IProviderSettingsService.channelName, wrapProviderSettings(providerSettings));
  }
  const settings = services.getOptional(ISettingService);
  if (settings) {
    overrides.set(ISettingService.channelName, wrapSettings(settings));
  }
  const oauth = services.getOptional(IOAuthService);
  if (oauth) {
    overrides.set(IOAuthService.channelName, wrapOAuth(oauth));
  }
  const credentials = services.getOptional(ICredentialService);
  if (credentials) {
    overrides.set(ICredentialService.channelName, wrapCredentials(credentials));
  }
  return overrides;
}
