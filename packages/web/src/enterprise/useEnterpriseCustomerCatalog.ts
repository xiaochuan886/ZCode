import { useEffect, useState } from "react";
import {
  createEnterpriseClient,
  type Customer,
  type EnterpriseUser,
  type ActiveCustomer,
  type Tenant,
} from "./api.js";

const api = createEnterpriseClient();

export function useEnterpriseCustomerCatalog({
  user,
  tenantId,
  tenants,
  activeCustomer,
  onTenantResolved,
  setError,
}: {
  user: EnterpriseUser | null;
  tenantId: string;
  tenants: Tenant[];
  activeCustomer: ActiveCustomer | null;
  onTenantResolved: (tenantId: string) => void;
  setError: (message: string) => void;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);

  useEffect(() => {
    if (!user || !tenantId) {
      setCustomers([]);
      return;
    }
    let stale = false;
    void api.customers(tenantId).then(
      (next) => {
        if (!stale) setCustomers(next);
      },
      (cause: unknown) => {
        if (!stale) setError(String(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [setError, tenantId, user?.id]);

  useEffect(() => {
    if (!user || !activeCustomer?.id || tenants.length < 2) return;
    let stale = false;
    void Promise.all(
      tenants.map(async (tenant) => ({
        tenantId: tenant.id,
        customers: await api.customers(tenant.id),
      })),
    )
      .then((groups) => {
        if (stale) return;
        const match = groups.find((group) =>
          group.customers.some((customer) => customer.id === activeCustomer.id),
        );
        if (!match || match.tenantId === tenantId) return;
        onTenantResolved(match.tenantId);
        setCustomers(match.customers);
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [activeCustomer?.id, onTenantResolved, setError, tenantId, tenants, user?.id]);

  return [customers, setCustomers] as const;
}
