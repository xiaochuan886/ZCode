import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnterpriseAuth } from "./auth.js";
import type { EnterpriseRuntimeTarget } from "./types.js";
import type { RuntimeBinding, RuntimeManager } from "./runtime.js";
import type { EnterpriseStore } from "./store.js";
import type { McpDnsLookup } from "./mcp-policy.js";

export type GatewayOptions = {
  store: EnterpriseStore;
  auth: EnterpriseAuth;
  runtimes: RuntimeManager;
  staticRoot: string;
  host?: string;
  port?: number;
  expectedOrigin?: string;
  relayOrigin?: string;
  modelRuntimeDataRoot?: string;
  fetchImpl?: typeof fetch;
  mcpDnsLookup?: McpDnsLookup;
};

export type EnterpriseApiHelpers = {
  cookies(request: IncomingMessage): Map<string, string>;
  send(response: ServerResponse, status: number, data: unknown): void;
  jsonBody(request: IncomingMessage): Promise<Record<string, unknown>>;
  str(value: unknown): string;
  origin(request: IncomingMessage, configured?: string): string;
  relayOrigin(request: IncomingMessage, options: GatewayOptions): string;
  publicCustomer(value: import("./types.js").Customer): unknown;
  runtimeTargetsForTenant(
    store: EnterpriseStore,
    actorId: string,
    tenantId: string,
  ): EnterpriseRuntimeTarget[];
};

export type EnterpriseApiRequest = {
  options: GatewayOptions;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  path: string;
  method: string;
  closeSockets(sessionId: string): void;
  closeUserSockets(userId: string): void;
  stopRuntime(value: EnterpriseRuntimeTarget): Promise<void>;
  ensureRuntime(
    value: EnterpriseRuntimeTarget,
    userId: string,
    requestOrigin: string,
  ): Promise<RuntimeBinding>;
  helpers: EnterpriseApiHelpers;
};
