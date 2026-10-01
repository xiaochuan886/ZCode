import type { CancellationToken, IChannel, IChannelClient } from "@zcode/rpc";

/**
 * Stable error code carried by `RpcTimeoutError`.
 *
 * Consumers (e.g. the enterprise shell) can branch on this code — through
 * `isRpcTimeoutError` or `normalizeUnknownError(error).code` — to render an
 * explicit error state instead of an infinite spinner when a half-dead
 * transport never answers a request.
 */
export const ZCODE_RPC_TIMEOUT_ERROR_CODE = "ZCODE_RPC_TIMEOUT" as const;

/**
 * Default per-request timeout applied to every request/response call made
 * through connections created by `connectViaWebSocket` / `connectViaProtocol`.
 * Event subscriptions are never timed out.
 */
export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 60_000;

/** Error thrown when a single request/response RPC exceeds its timeout. */
export class RpcTimeoutError extends Error {
  readonly code: typeof ZCODE_RPC_TIMEOUT_ERROR_CODE = ZCODE_RPC_TIMEOUT_ERROR_CODE;
  /** Dotted `<channel>.<command>` name of the timed-out request. */
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`RPC request timed out after ${timeoutMs}ms: ${method}`);
    this.name = "RpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** Type guard that also matches cross-bundle copies of the error by its stable `code`. */
export function isRpcTimeoutError(error: unknown): error is RpcTimeoutError {
  if (error instanceof RpcTimeoutError) {
    return true;
  }
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === ZCODE_RPC_TIMEOUT_ERROR_CODE
  );
}

/** Connect options shared by every entry point that can apply the per-request timeout. */
export interface RpcRequestTimeoutOptions {
  /**
   * Timeout in milliseconds for each request/response RPC on this connection.
   * On timeout the caller's promise rejects with `RpcTimeoutError` while the
   * connection itself stays usable (other requests and event subscriptions
   * keep working). `0` (or any non-positive value) disables the timeout.
   *
   * Raise this at connect time for long-running request/response flows such as
   * plugin installs or session compaction, which are designed to stream
   * progress over events while the request promise stays open for minutes.
   */
  requestTimeoutMs?: number;
}

/**
 * Wraps an `IChannelClient` so every `channel.call` rejects with
 * `RpcTimeoutError` after `requestTimeoutMs`. `channel.listen` (event
 * subscriptions) is passed through untouched.
 */
export function withRpcRequestTimeout(
  channelClient: IChannelClient,
  requestTimeoutMs: number | undefined,
): IChannelClient {
  const timeoutMs = requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
  if (!(timeoutMs > 0)) {
    return channelClient;
  }

  return {
    getChannel<T extends IChannel>(channelName: string): T {
      return createTimeoutChannel(
        channelClient.getChannel(channelName),
        channelName,
        timeoutMs,
      ) as T;
    },
  };
}

function createTimeoutChannel(channel: IChannel, channelName: string, timeoutMs: number): IChannel {
  return {
    call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
      return callWithRequestTimeout(
        channel,
        `${channelName}.${command}`,
        command,
        arg,
        cancellationToken,
        timeoutMs,
      ) as Promise<T>;
    },
    listen<T>(event: string, arg?: any) {
      return channel.listen<T>(event, arg);
    },
  };
}

function callWithRequestTimeout(
  channel: IChannel,
  method: string,
  command: string,
  arg: unknown,
  cancellationToken: CancellationToken | undefined,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The transport may just be slow for this one call, so a timeout only
    // settles the caller's promise: it never disposes the connection, and no
    // PromiseCancel is sent, because the request may still complete and the
    // server-side work (e.g. a plugin install) must not be aborted by the
    // client-side spinner defense. If the response (or the connection-level
    // rejection from ChannelClient.dispose) arrives later, it lands on this
    // already-settled promise as a silent no-op.
    channel.call(command, arg, cancellationToken).then(
      (value) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(value);
      },
      (error) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(error);
      },
    );
    timer = setTimeout(() => {
      timer = undefined;
      reject(new RpcTimeoutError(method, timeoutMs));
    }, timeoutMs);
  });
}
