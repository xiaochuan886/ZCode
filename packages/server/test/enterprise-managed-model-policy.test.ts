import assert from "node:assert/strict";
import { test } from "node:test";
import { Event } from "@zcode/rpc";
import {
  ICredentialService,
  IOAuthService,
  IProviderSettingsService,
  ISettingService,
  ServiceCollection,
} from "@zcode/services";
import {
  createEnterpriseManagedModelOverrides,
  ENTERPRISE_MANAGED_MODEL_ERROR_CODE,
} from "../src/enterprise-managed-model-policy.js";

const rejectedMethodNames = [
  "createPersonalProvider",
  "savePersonalProviderOverlay",
  "deletePersonalProvider",
  "reorderPersonalProviders",
  "reorderPersonalModels",
  "addPersonalModel",
  "renamePersonalModel",
  "deletePersonalModel",
  "savePersonalModelDraft",
  "setPersonalModelEnabled",
] as const;

const oauthMutationNames = [
  "startOAuth",
  "startOAuthWithPolling",
  "pollPendingOAuth",
  "handleCallback",
  "refreshToken",
  "logout",
  "logoutAll",
  "cancelPending",
] as const;

function assertManagedModelRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === ENTERPRISE_MANAGED_MODEL_ERROR_CODE
  );
}

function serviceWithMethods(methodNames: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(methodNames.map((name) => [name, async () => "unexpected"])) as Record<
    string,
    unknown
  >;
}

test("ordinary mode does not install enterprise model restrictions", () => {
  const services = new ServiceCollection();
  services.register(ISettingService, {
    get: async () => ({}) as never,
    update: async () => {},
    updateDataBaseDir: async () => {},
    ensureDefaultProject: async () => ({ path: "/tmp/project", created: false }),
  });
  assert.equal(createEnterpriseManagedModelOverrides(services, false).size, 0);
});

test("enterprise mode blocks provider, OAuth, and credential mutations", async () => {
  const provider = {
    onDidChange: Event.None,
    getView: async () => ({}) as never,
    refresh: async () => ({}) as never,
    resolveModelConfig: async () => ({}) as never,
    testModelConnectivity: async () => ({ success: true }),
    ...serviceWithMethods(rejectedMethodNames),
  } as unknown as IProviderSettingsService;
  const oauth = {
    getProviders: async () => [],
    getActiveProvider: async () => null,
    restoreCachedSession: async () => ({
      id: "unexpected",
      username: "unexpected",
      displayName: "unexpected",
    }),
    restoreCachedSessionState: async () => ({
      status: "authenticated",
      userInfo: { id: "unexpected", username: "unexpected", displayName: "unexpected" },
    }),
    restoreSession: async () => ({
      id: "unexpected",
      username: "unexpected",
      displayName: "unexpected",
    }),
    ...serviceWithMethods(oauthMutationNames),
  } as unknown as IOAuthService;
  const credentials = {
    load: async () => "secret",
    save: async () => {},
    delete: async () => {},
  } as ICredentialService;
  const settings = {
    get: async () => ({ locale: "zh-CN", recentProjects: [] }) as never,
    update: async () => {},
    updateDataBaseDir: async () => {},
    ensureDefaultProject: async () => ({ path: "/tmp/project", created: false }),
  };
  const services = new ServiceCollection()
    .register(IProviderSettingsService, provider)
    .register(IOAuthService, oauth)
    .register(ICredentialService, credentials)
    .register(ISettingService, settings);
  const overrides = createEnterpriseManagedModelOverrides(services, true);
  const guardedProvider = overrides.get(
    IProviderSettingsService.channelName,
  ) as IProviderSettingsService;
  const guardedOAuth = overrides.get(IOAuthService.channelName) as IOAuthService;
  const guardedCredentials = overrides.get(ICredentialService.channelName) as ICredentialService;
  const guardedSettings = overrides.get(ISettingService.channelName) as ISettingService;

  for (const methodName of rejectedMethodNames) {
    await assert.rejects(
      () => (guardedProvider as unknown as Record<string, () => Promise<unknown>>)[methodName](),
      assertManagedModelRejection,
    );
  }
  for (const methodName of oauthMutationNames) {
    await assert.rejects(
      () => (guardedOAuth as unknown as Record<string, () => Promise<unknown>>)[methodName](),
      assertManagedModelRejection,
    );
  }
  for (const methodName of ["load", "save", "delete"]) {
    await assert.rejects(
      () => (guardedCredentials as unknown as Record<string, () => Promise<unknown>>)[methodName](),
      assertManagedModelRejection,
    );
  }
  await assert.rejects(
    () => guardedSettings.updateDataBaseDir("/tmp/enterprise-managed-model-test"),
    assertManagedModelRejection,
  );
  assert.equal(await guardedOAuth.restoreCachedSession(), null);
  assert.deepEqual(await guardedOAuth.restoreCachedSessionState(), { status: "signed-out" });
  assert.equal(await guardedOAuth.restoreSession(), null);
});

test("enterprise mode allows read-only provider access and ordinary settings", async () => {
  let receivedPatch: unknown;
  const provider = {
    onDidChange: Event.None,
    getView: async () => ({ marker: "view" }) as never,
    refresh: async () => ({ marker: "refresh" }) as never,
    resolveModelConfig: async () => ({ marker: "resolved" }) as never,
    testModelConnectivity: async () => ({ success: true }),
  } as unknown as IProviderSettingsService;
  const settings = {
    get: async () => ({ locale: "zh-CN", recentProjects: [] }) as never,
    update: async (patch: unknown) => {
      receivedPatch = patch;
    },
    updateDataBaseDir: async () => {},
    ensureDefaultProject: async () => ({ path: "/tmp/project", created: false }),
  };
  const services = new ServiceCollection()
    .register(IProviderSettingsService, provider)
    .register(ISettingService, settings);
  const overrides = createEnterpriseManagedModelOverrides(services, true);
  const guardedProvider = overrides.get(
    IProviderSettingsService.channelName,
  ) as IProviderSettingsService;
  const guardedSettings = overrides.get(ISettingService.channelName) as ISettingService;

  assert.deepEqual(await guardedProvider.getView(), { marker: "view" });
  assert.deepEqual(await guardedProvider.refresh("enterprise"), { marker: "refresh" });
  await guardedSettings.update({ locale: "zh-CN" });
  assert.deepEqual(receivedPatch, { locale: "zh-CN" });
  for (const field of [
    "providerFamilyDomain",
    "providerFamilyConnectionSelections",
    "providerFamilyDomainUpdatedAt",
    "providerFamilyDomainMigrated",
  ]) {
    await assert.rejects(
      () => guardedSettings.update({ [field]: "blocked" } as never),
      assertManagedModelRejection,
    );
  }
});
