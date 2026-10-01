import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  WindowHostControllerTaskListItem,
  ZCodeTaskListItem,
  ZCodeTaskListKind,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { stabilizeTaskListItems } from "@/v4/taskListItemStabilization.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import type { WindowControllerTaskListVersion } from "@/v4/windowControllerTaskListRegistry.js";

type GlobalTaskListItem = WindowHostControllerTaskListItem;

const subscribeToNothing = () => () => {};
const zeroRevision = () => 0;

function addTaskListPresentation(item: ZCodeTaskListItem): GlobalTaskListItem {
  return {
    ...item,
    sourceAvailability: "online",
    liveStatus:
      item.status === "completed" ? "completed" : item.status === "error" ? "error" : "idle",
  };
}

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]): ZCodeTaskListWorkspaceScope[] {
  const scopes = new Map<string, ZCodeTaskListWorkspaceScope>();
  for (const tab of workspaceTabs) {
    const scope = {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    };
    scopes.set(
      JSON.stringify([tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath]),
      scope,
    );
  }
  return Array.from(scopes.values());
}

export function useGlobalTaskList(params: {
  kind: ZCodeTaskListKind;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
  searchQuery: string;
  expanded: boolean;
  collapsedLimit: number;
  /**
   * Enterprise Web 当前 runtime 只有 workspace task service，没有 Desktop 的窗口级
   * Controller。企业调用方明确选择 workspace source 后，直接查询当前 workspace service；
   * 普通模式继续使用现有 Controller 聚合源。
   */
  useWorkspaceTaskService?: boolean;
}) {
  const baseServices = useBaseWorkspaceServices();
  const controller = baseServices.windowControllerService;
  const useWorkspaceTaskService = params.useWorkspaceTaskService === true;
  const controllerRegistry = useMemo(
    () =>
      useWorkspaceTaskService || !controller
        ? null
        : getWindowControllerTaskListRegistry(controller),
    [controller, useWorkspaceTaskService],
  );
  const controllerRevision = useSyncExternalStore(
    controllerRegistry?.subscribe ?? subscribeToNothing,
    controllerRegistry?.getRevision ?? zeroRevision,
    controllerRegistry?.getRevision ?? zeroRevision,
  );
  const workspaceSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath] as const,
      )
      .sort(
        ([leftKey, leftPath], [rightKey, rightPath]) =>
          leftKey.localeCompare(rightKey) || leftPath.localeCompare(rightPath),
      ),
  );
  const workspaceSourceGenerationSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) =>
          [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            tab.workspacePath,
            tab.remoteSessionId?.trim() || null,
          ] as const,
      )
      .sort(
        ([leftKey, leftPath, leftSession], [rightKey, rightPath, rightSession]) =>
          leftKey.localeCompare(rightKey) ||
          leftPath.localeCompare(rightPath) ||
          (leftSession ?? "").localeCompare(rightSession ?? ""),
      ),
  );
  const workspaceScopes = useMemo(
    () => buildWorkspaceScopes(params.workspaceTabs),
    // workspaceSignature 是标准化后的 scope 值签名，避免父组件重建 tabs 数组时重复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceSignature],
  );
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs
        .map((tab) => {
          const workspace = selectWorkspaceZCodeState(
            state,
            tab.workspacePath,
            tab.workspaceIdentity,
          );
          return [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            workspace.taskListVersion,
          ] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  const [items, setItems] = useState<GlobalTaskListItem[]>([]);
  const itemsRef = useRef<GlobalTaskListItem[]>(items);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(workspaceScopes.length > 0);
  const requestSerialRef = useRef(0);
  const manualRefreshSerialRef = useRef(0);

  const query = useMemo(
    () => ({
      kind: params.kind,
      workspaceScopes,
      sortBy: params.sortBy,
      search: params.searchQuery.trim() || undefined,
      limit: params.expanded ? undefined : params.collapsedLimit,
    }),
    [
      params.collapsedLimit,
      params.expanded,
      params.kind,
      params.searchQuery,
      params.sortBy,
      workspaceScopes,
    ],
  );
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  const load = useCallback(
    async (version: WindowControllerTaskListVersion) => {
      const requestSerial = ++requestSerialRef.current;
      if (workspaceScopes.length === 0) {
        setItems([]);
        itemsRef.current = [];
        setTotal(0);
        setHasMore(false);
        setLoading(false);
        return;
      }
      if (!controllerRegistry && !useWorkspaceTaskService) {
        // 原子切换后 base attachment 必须提供 Controller；缺失代表 Host/Renderer 版本不一致。
        logger.error("[useGlobalTaskList] window Host Controller channel unavailable");
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const result = await (controllerRegistry
          ? controllerRegistry.list(queryKey, version, query)
          : (() => {
              // Enterprise Web 没有窗口 Controller，workspace task service 仍提供同一份
              // tasks-index 查询；只发一次 RPC，避免归档页刷新时产生重复读取。
              return baseServices.zcodeTaskService.listTaskList(query).then((serviceResult) => ({
                ...serviceResult,
                items: serviceResult.items.map(addTaskListPresentation),
              }));
            })());
        if (requestSerialRef.current !== requestSerial) {
          return;
        }
        // Controller 的每个 activity 帧（运行中任务的 tool 调用等）都会让本 hook 重查，
        // 而 attachTaskListRowActivity 与 tasks-index join 每次都产生全新对象。下游（grouped 视图）
        // 只能按引用判等，于是整棵列表树换代重渲染并重测量虚拟器。这里与 sessions-index lane 同款
        // 逐条引用稳定化：内容等价复用旧对象，整表等价复用旧数组。
        const nextItems = stabilizeTaskListItems(
          itemsRef.current,
          result.items.map((item) =>
            item.activity ? attachTaskListRowActivity(item, item.activity) : item,
          ),
        );
        itemsRef.current = nextItems;
        setItems(nextItems);
        setTotal(result.total);
        setHasMore(result.hasMore);
      } catch (error) {
        if (requestSerialRef.current === requestSerial) {
          // Controller/Workspace service 查询失败时保留最后可信列表，避免单 source 异常清空其他 workspace。
          logger.error(
            `[useGlobalTaskList] ${useWorkspaceTaskService ? "workspace service" : "Controller"} 加载 ${params.kind} 列表失败`,
            error,
          );
        }
      } finally {
        if (requestSerialRef.current === requestSerial) {
          setLoading(false);
        }
      }
    },
    [
      baseServices.zcodeTaskService,
      controllerRegistry,
      params.kind,
      query,
      queryKey,
      useWorkspaceTaskService,
      workspaceScopes,
    ],
  );

  const refresh = useCallback(async () => {
    manualRefreshSerialRef.current += 1;
    await load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
      manualRefreshSerial: manualRefreshSerialRef.current,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  useEffect(() => {
    // 远程 workspace 从断开占位恢复为在线 session 时 identity/path 不变，
    // taskListVersion 也可能尚未变化，旧缓存因此永久保留连接前的空结果。remoteSessionId
    // 只作为 source 代际触发重查，不改变 workspaceIdentity 与 Controller 查询契约。
    void load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  const hasRemoteScope = params.workspaceTabs.some((tab) => Boolean(tab.workspaceIdentity));
  return {
    items,
    total,
    hasMore,
    loading,
    syncingRemoteWorkspaces: loading && hasRemoteScope,
    refresh,
  };
}
