import type { Writable } from "node:stream";

function waitForDrainOrClose(writable: Writable, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (writable.destroyed || writable.writableEnded || signal?.aborted) {
      resolve(false);
      return;
    }

    const finish = (drained: boolean) => {
      writable.off("drain", onDrain);
      writable.off("close", onClose);
      writable.off("error", onClose);
      signal?.removeEventListener("abort", onAbort);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onAbort = () => finish(false);
    writable.once("drain", onDrain);
    writable.once("close", onClose);
    writable.once("error", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Forward one chunk at a time and pause upstream reads while the client socket is full. */
export async function writeAsyncIterableBackpressured(
  source: AsyncIterable<Uint8Array>,
  writable: Writable,
  signal?: AbortSignal,
): Promise<boolean> {
  for await (const chunk of source) {
    if (writable.destroyed || writable.writableEnded || signal?.aborted) return false;
    if (!writable.write(chunk) && !(await waitForDrainOrClose(writable, signal))) return false;
  }
  return !writable.destroyed && !signal?.aborted;
}
