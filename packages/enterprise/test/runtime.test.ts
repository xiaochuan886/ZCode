import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProcessRuntimeAdapter, RuntimeManager, type RuntimeAdapter } from "../src/runtime.js";

test("runtime bindings are case-specific and unhealthy runtimes restart", async () => {
  let starts = 0;
  const unhealthy = new Set<string>();
  const stopped: string[] = [];
  const events: string[] = [];
  const adapter: RuntimeAdapter = {
    async stopStale(input) {
      events.push(`stop-stale:${input.id}`);
    },
    async start(input) {
      starts += 1;
      const id = `${input.id}-${starts}`;
      events.push(`start:${id}`);
      return {
        id,
        url: `http://127.0.0.1:${4000 + starts}`,
        stop: async () => {
          stopped.push(input.id);
          events.push(`stop:${id}`);
        },
      };
    },
    async healthy(handle) {
      return !unhealthy.has(handle.id);
    },
  };
  const manager = new RuntimeManager(adapter);
  const firstCase = { id: "case-a", workspacePath: "/tmp/case-a" };
  const first = await manager.ensure(firstCase, {
    beforeStart: async () => {
      events.push("prepare:case-a");
    },
  });
  assert.deepEqual(events, ["stop-stale:case-a", "prepare:case-a", "start:case-a-1"]);
  const reused = await manager.ensure(firstCase, {
    beforeStart: async () => {
      events.push("unexpected-prepare:case-a");
    },
  });
  assert.equal(reused.token, first.token);
  assert.deepEqual(events, ["stop-stale:case-a", "prepare:case-a", "start:case-a-1"]);
  unhealthy.add("case-a-1");
  const restarted = await manager.ensure(firstCase, {
    beforeStart: async () => {
      events.push("prepare:case-a");
    },
  });
  assert.deepEqual(events, [
    "stop-stale:case-a",
    "prepare:case-a",
    "start:case-a-1",
    "stop:case-a-1",
    "stop-stale:case-a",
    "prepare:case-a",
    "start:case-a-2",
  ]);
  const second = await manager.ensure(
    { id: "case-b", workspacePath: "/tmp/case-b" },
    {
      beforeStart: async () => {
        events.push("prepare:case-b");
      },
    },
  );
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.url, second.url);
  assert.notEqual(first.token, restarted.token);
  assert.deepEqual(stopped, ["case-a"]);
  await manager.stop({ id: "case-b", workspacePath: "/tmp/case-b" });
  assert.deepEqual(stopped, ["case-a", "case-b"]);
  const beforeStaleStop = events.length;
  await manager.stop({ id: "case-c", workspacePath: "/tmp/case-c" });
  assert.deepEqual(events.slice(beforeStaleStop), ["stop-stale:case-c"]);
});

test("native session binding accepts only a task indexed for that Case workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "enterprise-runtime-"));
  const dataRoot = join(root, "runtimes");
  const indexDir = join(dataRoot, "case-a", ".zcode", "v2");
  await mkdir(indexDir, { recursive: true });
  const db = new DatabaseSync(join(indexDir, "tasks-index.sqlite"));
  db.exec(
    "CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, task_id TEXT, deleted INTEGER)",
  );
  db.prepare("INSERT INTO tasks VALUES(?,?,?,0)").run("/tmp/case-a", "/tmp/case-a", "task-owned");
  db.prepare("INSERT INTO tasks VALUES(?,?,?,0)").run("/tmp/case-b", "/tmp/case-b", "task-foreign");
  db.close();
  const adapter = new ProcessRuntimeAdapter({ serverEntry: "/unused", dataRoot });
  assert.equal(
    await adapter.ownsSession({ id: "case-a", workspacePath: "/tmp/case-a" }, "task-owned"),
    true,
  );
  assert.equal(
    await adapter.ownsSession({ id: "case-a", workspacePath: "/tmp/case-a" }, "task-foreign"),
    false,
  );
  assert.equal(
    await adapter.ownsSession({ id: "case-b", workspacePath: "/tmp/case-b" }, "task-foreign"),
    false,
  );
});

test("stopAll waits for an in-flight start and rejects new runtime ensures", async () => {
  let markStarted!: () => void;
  let finishStart!: (handle: Awaited<ReturnType<RuntimeAdapter["start"]>>) => void;
  const startWasCalled = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const deferredStart = new Promise<Awaited<ReturnType<RuntimeAdapter["start"]>>>((resolve) => {
    finishStart = resolve;
  });
  let stopped = false;
  const manager = new RuntimeManager({
    async start() {
      markStarted();
      return deferredStart;
    },
    async healthy() {
      return true;
    },
  });
  const caseInfo = { id: "case-pending", workspacePath: "/tmp/case-pending" };
  const ensuring = manager.ensure(caseInfo);
  await startWasCalled;
  const stopping = manager.stopAll();
  await assert.rejects(manager.ensure({ id: "case-new", workspacePath: "/tmp/case-new" }), {
    message: "Runtime manager is shutting down",
  });
  finishStart({
    id: "pending-handle",
    url: "http://127.0.0.1:4400",
    stop: async () => {
      stopped = true;
    },
  });
  await ensuring;
  await stopping;
  assert.equal(stopped, true);
  assert.equal(manager.getBinding(caseInfo), null);
});
