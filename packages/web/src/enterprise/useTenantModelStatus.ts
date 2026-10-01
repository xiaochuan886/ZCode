import { useCallback, useEffect, useState } from "react";
import { createEnterpriseClient, type ModelProviderView } from "./api.js";

const api = createEnterpriseClient();

/**
 * 模型就绪判定基于供应商目录:列表中存在 enabled 的供应商即视为就绪,
 * 供 EnterpriseApp 的 modelReady 门控使用(旧的单凭据状态接口已随目录方案下线)。
 */
export function useTenantModelStatus(
  userId: string | undefined,
  tenantId: string,
  setError: (message: string) => void,
) {
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !tenantId) {
      setProviders([]);
      setLoaded(false);
      return;
    }
    try {
      setProviders(await api.modelProviders(tenantId));
      setLoaded(true);
    } catch (cause) {
      setProviders([]);
      setLoaded(true);
      setError(String(cause));
    }
  }, [userId, tenantId, setError]);

  useEffect(() => {
    let stale = false;
    setLoaded(false);
    if (!userId || !tenantId) {
      setProviders([]);
      return;
    }
    void api.modelProviders(tenantId).then(
      (next) => {
        if (stale) return;
        setProviders(next);
        setLoaded(true);
      },
      (cause: unknown) => {
        if (stale) return;
        setProviders([]);
        setLoaded(true);
        setError(String(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [userId, tenantId, setError]);

  return {
    modelReady: providers.some((provider) => provider.enabled),
    modelStatusLoaded: loaded,
    refresh,
  };
}
