import type { EnterpriseCustomerReader } from "./contract.js";
export function currentCustomer(reader: EnterpriseCustomerReader, sessionId: string) {
  return reader.getActiveCustomer(sessionId);
}
