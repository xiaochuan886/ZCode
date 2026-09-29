import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { EnterpriseAuth } from "./auth.js";
import type { EnterpriseCase } from "./types.js";
import type { EnterpriseSession } from "./types.js";
import type { RuntimeBinding } from "./runtime.js";
import type { EnterpriseApiHelpers, GatewayOptions } from "./gateway-types.js";
import { nativePathAllowed, proxyWebSocket, validWebSocketHandshake } from "./proxy.js";

type SocketHelpers = Pick<EnterpriseApiHelpers, "cookies" | "origin" | "relayOrigin"> & {
  sessionFor(request: IncomingMessage, auth: EnterpriseAuth): EnterpriseSession | null;
};

export function attachEnterpriseWebSocketHandler(input: {
  server: Server;
  options: GatewayOptions;
  sockets: Map<string, Set<Duplex>>;
  socketUsers: Map<string, string>;
  ensureRuntime(
    value: EnterpriseCase,
    userId: string,
    requestOrigin: string,
  ): Promise<RuntimeBinding>;
  helpers: SocketHelpers;
}): void {
  const { server, options, sockets, socketUsers, ensureRuntime, helpers } = input;
  const { cookies, origin, relayOrigin, sessionFor } = helpers;

  server.on("upgrade", async (request, socket, head) => {
    const fail = (status: number) =>
      socket.end(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\n\r\n`);
    try {
      const path = new URL(request.url ?? "/", origin(request, options.expectedOrigin)).pathname;
      if (path !== "/ws" || !nativePathAllowed(path)) {
        fail(403);
        return;
      }
      if (!validWebSocketHandshake(request)) {
        fail(400);
        return;
      }
      if (request.headers.origin !== origin(request, options.expectedOrigin)) {
        fail(403);
        return;
      }
      const session = sessionFor(request, options.auth);
      if (!session) {
        fail(401);
        return;
      }
      const value = options.store.getActiveCase(session.id);
      if (!value || value.status === "closed") {
        fail(403);
        return;
      }
      const binding = await ensureRuntime(value, session.userId, relayOrigin(request, options));
      const token = cookies(request).get("enterprise_session") ?? "";
      const current = options.auth.resolveSession(token);
      if (!current) {
        fail(401);
        return;
      }
      const activeCase = options.store.getActiveCase(session.id);
      if (
        current.id !== session.id ||
        activeCase?.id !== value.id ||
        activeCase.status === "closed"
      ) {
        fail(403);
        return;
      }
      let set = sockets.get(session.id);
      if (!set) {
        set = new Set();
        sockets.set(session.id, set);
      }
      set.add(socket);
      socketUsers.set(session.id, session.userId);
      const authorizationCheck = setInterval(() => {
        const current = options.auth.resolveSession(token);
        if (!current || options.store.getActiveCase(current.id)?.id !== value.id) socket.destroy();
      }, 2000);
      authorizationCheck.unref();
      socket.on("close", () => {
        clearInterval(authorizationCheck);
        set?.delete(socket);
        if (!set?.size) {
          sockets.delete(session.id);
          socketUsers.delete(session.id);
        }
      });
      proxyWebSocket(request, socket, head, binding);
    } catch {
      fail(503);
    }
  });
}
