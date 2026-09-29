import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";

/** Enterprise hosts can observe the current native task without owning session state. */
export function useActiveTaskIdForWorkspace(workspacePath: string): string | null {
  return useZCodeSessionStore((state) => getWorkspaceState(state, workspacePath).activeTaskId);
}
