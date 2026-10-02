export { App } from "./App.js";
export { AppErrorBoundary, ScopedErrorBoundary } from "./ErrorBoundary.js";
export type { ScopedErrorBoundaryVariant } from "./ErrorBoundary.js";
export { Button, buttonVariants } from "./components/ui/button.js";
// 企业设置复用的原生展示层组件(数据由调用方注入,不携带服务耦合):
// 模板选择器/API Key 输入/MCP 表单/设置表单原语。additive 导出,原生用法不变。
export { ApiKeyInput } from "./settings/model-provider-section/ApiKeyInput.js";
export { ProviderTemplatePicker } from "./settings/model-provider-section/ProviderTemplatePicker.js";
export type { ProviderSettingsTemplateView } from "@zcode/provider";
export { McpServerForm } from "./settings/McpServerForm.js";
export type { FormState as McpFormState, McpEditorMode } from "./settings/mcpSettingsShared.js";
export { SettingsFormActions } from "./settings/SettingsFormActions.js";
export { SettingsFormTextarea } from "./settings/SettingsFormTextarea.js";
export { SettingsSegmentedTabs } from "./settings/SettingsSegmentedTabs.js";
export { Input } from "./components/ui/input.js";
// 原生展示组件内的 ControlHintTooltip 依赖 TooltipProvider 上下文(原生 Root 内挂载,
// 企业设置浮层在其外),导出供企业侧就近补挂。additive,原生用法不变。
export { TooltipProvider } from "./components/ui/tooltip.js";
// 企业模型目录复用的原生编辑器中间层(props 注入;注意 InlineEditableProviderCard
// 内部经 ProviderModelsSection 调用 useServices,企业侧需用 ServiceProvider 注入
// resolveModelConfig 桩):左侧导航 + 右侧详情编辑卡 + 协议选择/状态点/logo。
// additive,原生用法不变。
export { InlineEditableProviderCard } from "./settings/model-provider-section/InlineEditableProviderCard.js";
export { ModelProviderSectionNavigation } from "./settings/model-provider-section/Navigation.js";
export type {
  ModelProviderNavGroup,
  ModelProviderNavItem,
} from "./settings/model-provider-section/constants.js";
export type {
  ProviderSettingsFormProvider,
  ProviderSettingsFormModel,
} from "./lib/providerSettingsFormTypes.js";
export { ProviderApiFormatSelect } from "./settings/model-provider-section/ProviderApiFormatSelect.js";
export { ProviderStatusIndicator } from "./settings/model-provider-section/ProviderStatusIndicator.js";
export { ProviderLogo } from "./settings/model-provider-section/ProviderLogo.js";
export { StatusDot } from "./settings/StatusDot.js";
export { DesktopWindowFrame } from "./DesktopWindowFrame.js";
export {
  AssistantCodeCommentFeatureProvider,
  useAssistantCodeCommentFeatureEnabled,
} from "./AssistantCodeCommentFeatureProvider.js";
export { Root } from "./Root.js";
export {
  openEnterpriseWorkspace,
  subscribeEnterpriseWorkspaceOpen,
} from "./enterprise/enterpriseWorkspaceBridge.js";
export type {
  EnterpriseCustomerSummary,
  EnterpriseRootContext,
  EnterpriseTenantSummary,
  EnterpriseUserSummary,
} from "./root/types.js";
export { UpdateStatusWindowRoot } from "./UpdateStatusWindowRoot.js";
export { ConfirmDialogHost } from "./ConfirmDialog.js";
export { Terminal } from "./Terminal.js";
export { GitGraphPane } from "./git-graph/GitGraphPane.js";
export { layoutGitGraph } from "./git-graph/layout.js";
export type {
  GitGraphCommit,
  GitGraphLayout,
  GitGraphLayoutEdge,
  GitGraphLayoutOptions,
  GitGraphLayoutRow,
  GitGraphRef,
  GitGraphRefKind,
} from "./git-graph/layout.js";
export { SSHDialog, RemoteConnectionDialog } from "./SSHDialog.js";
export { useTheme } from "./useTheme.js";
export type { Theme } from "./useTheme.js";
export { useTestActions } from "./test-actions.js";
export type { TestActions } from "./test-actions.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export { useActiveTaskIdForWorkspace } from "./hooks/useActiveTaskIdForWorkspace.js";
export type { ZCodeState } from "./store/index.js";
export {
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "./store/remoteWorkspaceSessionStore.js";
export {
  REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
  createRemoteWorkspaceDisconnectedError,
} from "./lib/remoteWorkspaceServiceError.js";

// Hooks —— 统一的服务和平台操作访问层
export {
  ServiceProvider,
  useServices,
  useWorkspaceServices,
  PlatformProvider,
  usePlatform,
  useSelectDirectory,
  useConnectRemote,
  useReaddir,
  useSystemInfo,
  useIntranetProbe,
  useTerminal,
  useSettings,
  useRecentProjects,
  useConfirmDialog,
  useCredentials,
  useAuthToken,
  useGitRepository,
  useGitActions,
} from "./hooks/index.js";

export { ZCodeIntlProvider, useZCodeIntl, LocaleSwitcher } from "./i18n/index.js";
export { ResourceManagerApp } from "./resource-manager/ResourceManagerApp.js";
export type {
  ResourceManagerAppProps,
  ResourceManagerTab,
} from "./resource-manager/ResourceManagerApp.js";
export type { IntlInstance } from "./i18n/index.js";
export {
  FileDisplayInline,
  createFileDisplayDom,
  getFileDisplayPath,
  resolveFileDisplayDescriptor,
  setDefaultFileDisplayBasePath,
} from "./lib/fileDisplay.js";
export type { FileDisplayDescriptor, FileDisplayOptions } from "./lib/fileDisplay.js";
export { playTaskNotificationSound } from "./lib/taskNotificationSound.js";
export {
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
} from "./lib/uiFontSize.js";
export { reportUiLaunchToInput } from "./lib/uiPerfArmsTelemetry.js";
export {
  RendererUserActionTelemetry,
  runUserAction,
  runUserActionAsync,
  setUserActionTelemetry,
  startUserAction,
} from "./lib/userActionTelemetry.js";
export {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
} from "./lib/userActionTraceCatalog.js";
export { setReactErrorArmsReporter } from "./lib/reactErrorArmsTelemetry.js";
export { recordArmsCustomEventForE2E } from "./lib/armsCustomEventObservability.js";
export { generateMobileDeviceFingerprint, setStreamClientId } from "./lib/streamClientId.js";
export { GlobalDatabaseStartupLoading } from "./root/GlobalDatabaseStartupLoading.js";

export { LocalTtftObserver, setLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
