import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { writeAsyncIterableBackpressured } from "../src/backpressure.js";

test("a slow downstream pauses upstream iteration until drain", async () => {
  let releaseWrite!: () => void;
  let writes = 0;
  const writable = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writes += 1;
      if (writes === 1) releaseWrite = callback;
      else callback();
    },
  });
  let pulled = 0;
  async function* source() {
    pulled += 1;
    yield Buffer.from("first");
    pulled += 1;
    yield Buffer.from("second");
  }

  const forwarding = writeAsyncIterableBackpressured(source(), writable);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(pulled, 1, "upstream must not advance while write() is waiting for drain");
  releaseWrite();
  await forwarding;
  assert.equal(writes, 2);
  writable.end();
});
