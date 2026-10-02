import { useCallback, useEffect, useState } from "react";
import { createEnterpriseClient } from "./api.js";

const api = createEnterpriseClient();

/**
 * 模型就绪判定走成员可读的 model-status 信号(只含 ready 布尔):
 * 供应商目录列表是企业设置数据,已收紧为管理员专属,工作台门控不得依赖它。
 */
export function useTenantModelStatus(
  userId: string | undefined,
  tenantId: string,
  setError: (message: string) => void,
) {
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !tenantId) {
      setReady(false);
      setLoaded(false);
      return;
    }
    try {
      const status = await api.modelStatus(tenantId);
      setReady(status.ready);
      setLoaded(true);
    } catch (cause) {
      setReady(false);
      setLoaded(true);
      setError(String(cause));
    }
  }, [userId, tenantId, setError]);

  useEffect(() => {
    let stale = false;
    setLoaded(false);
    if (!userId || !tenantId) {
      setReady(false);
      return;
    }
    void api.modelStatus(tenantId).then(
      (status) => {
        if (stale) return;
        setReady(status.ready);
        setLoaded(true);
      },
      (cause: unknown) => {
        if (stale) return;
        setReady(false);
        setLoaded(true);
        setError(String(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [userId, tenantId, setError]);

  return {
    modelReady: ready,
    modelStatusLoaded: loaded,
    refresh,
  };
}
