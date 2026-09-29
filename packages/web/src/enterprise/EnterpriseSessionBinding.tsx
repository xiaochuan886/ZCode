import { useEffect } from "react";
import { useActiveTaskIdForWorkspace } from "@zcode/ui";
import { createEnterpriseClient, EnterpriseApiError } from "./api.js";

const api = createEnterpriseClient();

async function bindWithRetry(
  caseId: string,
  sessionId: string,
  token: string | null,
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (signal.aborted) return;
    try {
      await api.bindSession(caseId, sessionId, token, signal);
      return;
    } catch (error) {
      if (signal.aborted) return;
      if (
        !(error instanceof EnterpriseApiError) ||
        ![404, 409].includes(error.status) ||
        attempt === 3
      )
        throw error;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 150 * 2 ** attempt);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}

/** Reports the mounted native task; the gateway validates Case and workspace ownership. */
export function EnterpriseSessionBinding({
  caseId,
  workspacePath,
  csrfToken,
  onError,
}: {
  caseId: string;
  workspacePath: string;
  csrfToken: string | null;
  onError: (message: string) => void;
}) {
  const sessionId = useActiveTaskIdForWorkspace(workspacePath);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void bindWithRetry(caseId, sessionId, csrfToken, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted)
        onError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [caseId, sessionId, csrfToken, onError]);
  return null;
}
