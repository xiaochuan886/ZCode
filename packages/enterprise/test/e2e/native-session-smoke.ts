import assert from "node:assert/strict";
import { connectViaWebSocket } from "@zcode/client";
import { WebSocket as NodeWebSocket } from "ws";

/** Exercise the unchanged native session RPC over the enterprise WebSocket route. */
export async function smokeNativeSession(
  base: string,
  cookie: string,
  workspacePath: string,
): Promise<string> {
  const originalWebSocket = globalThis.WebSocket;
  const AuthenticatedWebSocket = class extends NodeWebSocket {
    constructor(url: string | URL) {
      super(url.toString(), { headers: { Cookie: cookie, Origin: base } });
    }
  };
  globalThis.WebSocket = AuthenticatedWebSocket as unknown as typeof WebSocket;
  const openedSocket: { current?: WebSocket } = {};
  try {
    const services = await connectViaWebSocket(base.replace(/^http/, "ws") + "/ws", {
      onOpenSocket: (opened) => {
        openedSocket.current = opened;
      },
    });
    const created = await services.zcodeSessionService.createSession({
      workspacePath,
      mode: "plan",
    });
    const sessionId = created.session.sessionId;
    for (const mode of ["plan", "build", "edit", "yolo", "plan"] as const) {
      const changed = await services.zcodeSessionService.setMode({
        workspacePath,
        sessionId,
        mode,
      });
      assert.equal(changed.session.sessionId, sessionId);
      // Native Plan is planEnabled on top of the current permission mode; this
      // legacy snapshot exposes only that underlying permission mode.
      if (mode !== "plan") assert.equal(changed.settings.mode.current, mode);
    }
    const resumed = await services.zcodeSessionService.resumeSession({ workspacePath, sessionId });
    assert.equal(resumed.session.sessionId, sessionId);
    return sessionId;
  } finally {
    openedSocket.current?.close();
    globalThis.WebSocket = originalWebSocket;
  }
}
