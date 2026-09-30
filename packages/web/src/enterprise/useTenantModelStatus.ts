import { useCallback, useEffect, useState } from "react";
import { createEnterpriseClient, type ModelCredentialStatus } from "./api.js";

const api = createEnterpriseClient();

export function useTenantModelStatus(
  userId: string | undefined,
  tenantId: string,
  setError: (message: string) => void,
) {
  const [statuses, setStatuses] = useState<ModelCredentialStatus[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !tenantId) {
      setStatuses([]);
      setLoaded(false);
      return;
    }
    try {
      setStatuses(await api.modelCredentials(tenantId));
      setLoaded(true);
    } catch (cause) {
      setStatuses([]);
      setLoaded(true);
      setError(String(cause));
    }
  }, [userId, tenantId, setError]);

  useEffect(() => {
    let stale = false;
    setLoaded(false);
    if (!userId || !tenantId) {
      setStatuses([]);
      return;
    }
    void api.modelCredentials(tenantId).then(
      (next) => {
        if (stale) return;
        setStatuses(next);
        setLoaded(true);
      },
      (cause: unknown) => {
        if (stale) return;
        setStatuses([]);
        setLoaded(true);
        setError(String(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [userId, tenantId, setError]);

  return {
    modelReady: statuses.some((status) => status.configured),
    modelStatusLoaded: loaded,
    refresh,
  };
}
