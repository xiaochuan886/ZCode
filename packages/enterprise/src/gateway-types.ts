import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnterpriseAuth } from "./auth.js";
import type { EnterpriseCase } from "./types.js";
import type { RuntimeBinding, RuntimeManager } from "./runtime.js";
import type { EnterpriseStore } from "./store.js";

export type GatewayOptions = {
  store: EnterpriseStore;
  auth: EnterpriseAuth;
  runtimes: RuntimeManager;
  staticRoot: string;
  host?: string;
  port?: number;
  expectedOrigin?: string;
  relayOrigin?: string;
  fetchImpl?: typeof fetch;
};

export type EnterpriseApiHelpers = {
  cookies(request: IncomingMessage): Map<string, string>;
  send(response: ServerResponse, status: number, data: unknown): void;
  jsonBody(request: IncomingMessage): Promise<Record<string, unknown>>;
  str(value: unknown): string;
  origin(request: IncomingMessage, configured?: string): string;
  relayOrigin(request: IncomingMessage, options: GatewayOptions): string;
  publicCase(value: EnterpriseCase): unknown;
  runtimeCasesInSpaces(
    store: EnterpriseStore,
    actorId: string,
    serviceSpaceIds: string[],
  ): EnterpriseCase[];
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
  stopRuntime(value: EnterpriseCase): Promise<void>;
  ensureRuntime(
    value: EnterpriseCase,
    userId: string,
    requestOrigin: string,
  ): Promise<RuntimeBinding>;
  helpers: EnterpriseApiHelpers;
};
