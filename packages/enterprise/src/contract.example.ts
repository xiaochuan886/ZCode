import type { EnterpriseCaseReader } from "./contract.js";
export function currentCase(reader: EnterpriseCaseReader, sessionId: string) {
  return reader.getActiveCase(sessionId);
}
