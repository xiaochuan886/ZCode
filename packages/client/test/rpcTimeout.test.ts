import test from "node:test";
import assert from "node:assert/strict";
import { ChannelServer, Emitter, Event, createQueuePair, type IServerChannel } from "@zcode/rpc";
import { ISkillsService } from "@zcode/services";
import {
  DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  RpcTimeoutError,
  ZCODE_RPC_TIMEOUT_ERROR_CODE,
  connectViaProtocol,
  connectViaWebSocket,
  isRpcTimeoutError,
} from "../src/index.js";

/**
 * In-memory harness: a ChannelServer on one end of a createQueuePair loopback,
 * the client stack under test (connectViaProtocol / connectViaWebSocket) on the
 * other. The fake channel answers "echo" immediately, leaves "never" unanswered
 * forever (a half-dead transport) and streams "onTestValueChanged" events.
 */

interface TestSkillsLike {
  echo(params: { echoed: boolean }): Promise<{ echoed: boolean }>;
  never(): Promise<{ value: number }>;
  onTestValueChanged: Event<number>;
}

function asTestSkills(services: { skillsService: ISkillsService }): TestSkillsLike {
  return services.skillsService as unknown as TestSkillsLike;
}

interface TestConnection {
  services: ReturnType<typeof connectViaProtocol>;
  fireValueChanged: (value: number) => void;
  dispose: () => void;
}

function createTestConnection(options?: { requestTimeoutMs?: number }): TestConnection {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "test-ctx");
  const valueEmitter = new Emitter<number>();

  const channel: IServerChannel<string> = {
    call<T>(_ctx: string, command: string): Promise<T> {
      switch (command) {
        case "echo":
          return Promise.resolve({ echoed: true }) as Promise<T>;
        case "never":
          return new Promise<T>(() => {});
        default:
          return Promise.reject(new Error(`unexpected command: ${command}`));
      }
    },
    listen<T>(_ctx: string, event: string): Event<T> {
      return (event === "onTestValueChanged" ? valueEmitter.event : Event.None) as Event<T>;
    },
  };
  server.registerChannel(ISkillsService.channelName, channel);

  return {
    services: connectViaProtocol(clientProtocol, options),
    fireValueChanged: (value) => valueEmitter.fire(value),
    dispose: () => server.dispose(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Node's setTimeout declaration carries extra members (e.g. __promisify__), so
 * the patched timers below use these narrow shapes and are cast on assignment.
 */
type PatchedSetTimeout = (handler: () => void, timeout?: number) => unknown;
type PatchedClearTimeout = (id: unknown) => unknown;

/** Minimal browser-like WebSocket that self-opens; writes go nowhere on purpose. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType: BinaryType = "arraybuffer";
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, ((event: { type: string }) => void)[]>();

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }, 0);
  }

  addEventListener(type: string, listener: (event: { type: string }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  // The transport never answers in these tests; this is the half-dead socket.
  send(_data: ArrayBuffer | Uint8Array): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type });
    }
  }
}

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

test("default per-request timeout is 60s per the enterprise MVP design spec", () => {
  assert.equal(DEFAULT_RPC_REQUEST_TIMEOUT_MS, 60_000);
});

test("a request that never gets a response rejects with the typed timeout error", async () => {
  const connection = createTestConnection({ requestTimeoutMs: 50 });
  const skills = asTestSkills(connection.services);
  const startedAt = Date.now();

  await assert.rejects(skills.never(), (error: unknown): boolean => {
    assert.ok(error instanceof RpcTimeoutError, "must reject with RpcTimeoutError");
    assert.ok(isRpcTimeoutError(error));
    assert.equal(error.code, ZCODE_RPC_TIMEOUT_ERROR_CODE);
    assert.equal(error.method, `${ISkillsService.channelName}.never`);
    assert.equal(error.timeoutMs, 50);
    assert.match(error.message, /never/);
    return true;
  });
  assert.ok(
    Date.now() - startedAt >= 40,
    "rejection must come from the timer, not transport failure",
  );

  connection.dispose();
});

test("requestTimeoutMs: 0 disables the timeout; a never-answered request stays pending", async () => {
  const connection = createTestConnection({ requestTimeoutMs: 0 });
  const skills = asTestSkills(connection.services);

  let settled = false;
  skills.never().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await delay(150);
  assert.equal(settled, false, "request must still be pending when timeouts are disabled");

  connection.dispose();
});

test("a request answered before the timeout resolves normally and clears its timer", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const createdTimers = new Set<unknown>();
  let clearedCreatedTimers = 0;
  const trackedSetTimeout: PatchedSetTimeout = (handler, timeout) => {
    const id = originalSetTimeout(handler, timeout);
    createdTimers.add(id);
    return id;
  };
  const trackedClearTimeout: PatchedClearTimeout = (id) => {
    if (createdTimers.delete(id)) {
      clearedCreatedTimers += 1;
    }
    return originalClearTimeout(id as Parameters<typeof originalClearTimeout>[0]);
  };

  let result: { echoed: boolean } | undefined;
  try {
    globalThis.setTimeout = trackedSetTimeout as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = trackedClearTimeout as unknown as typeof globalThis.clearTimeout;
    const connection = createTestConnection({ requestTimeoutMs: 80 });
    result = await asTestSkills(connection.services).echo({ echoed: true });
    connection.dispose();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.deepEqual(result, { echoed: true });
  assert.ok(
    clearedCreatedTimers >= 1,
    "the request's timeout timer must be cleared once the response arrives",
  );
});

test("a timed-out request does not degrade the connection or its event subscriptions", async () => {
  const connection = createTestConnection({ requestTimeoutMs: 50 });
  const skills = asTestSkills(connection.services);

  const received: number[] = [];
  const subscription = skills.onTestValueChanged((value) => {
    received.push(value);
  });
  // Let the EventListen request reach the server before firing.
  await delay(30);

  await assert.rejects(skills.never(), isRpcTimeoutError);

  // Events still flow on the same connection after a request timed out.
  connection.fireValueChanged(7);
  await delay(30);
  assert.deepEqual(received, [7]);

  // Later requests still work too.
  assert.deepEqual(await skills.echo({ echoed: true }), { echoed: true });

  connection.fireValueChanged(8);
  await delay(30);
  assert.deepEqual(received, [7, 8]);

  subscription.dispose();
  connection.dispose();
});

test("connectViaProtocol without options applies the 60s default to every request", async () => {
  const seenTimeoutDelays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  // Accelerate only the real 60s timer (20ms) so the suite stays fast while
  // still proving the scheduled delay is the documented default.
  const acceleratedSetTimeout: PatchedSetTimeout = (handler, timeout) => {
    if (timeout === DEFAULT_RPC_REQUEST_TIMEOUT_MS) {
      seenTimeoutDelays.push(timeout);
      return originalSetTimeout(handler, 20);
    }
    return originalSetTimeout(handler, timeout);
  };

  try {
    globalThis.setTimeout = acceleratedSetTimeout as unknown as typeof globalThis.setTimeout;
    const connection = createTestConnection();
    const rejection = assert.rejects(
      asTestSkills(connection.services).never(),
      (error: unknown): boolean => {
        assert.ok(isRpcTimeoutError(error));
        assert.equal(error.timeoutMs, DEFAULT_RPC_REQUEST_TIMEOUT_MS);
        return true;
      },
    );
    assert.ok(
      seenTimeoutDelays.includes(DEFAULT_RPC_REQUEST_TIMEOUT_MS),
      "a per-request timer with the 60s default must be scheduled",
    );
    await rejection;
    connection.dispose();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("connectViaWebSocket forwards requestTimeoutMs to its services", async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const services = await connectViaWebSocket("ws://test.invalid/ws", { requestTimeoutMs: 40 });
    await assert.rejects(
      asTestSkills(services).never(),
      (error: unknown): boolean => isRpcTimeoutError(error) && error.timeoutMs === 40,
    );
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("no unhandled rejections were produced by late responses or disposed connections", async () => {
  // Give any stray timers/macrotasks a final chance to surface rejections.
  await delay(120);
  assert.deepEqual(unhandledRejections, []);
});
