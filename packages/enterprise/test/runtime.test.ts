import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ContainerRuntimeAdapter,
  ProcessRuntimeAdapter,
  RuntimeManager,
  type RuntimeAdapter,
} from "../src/runtime.js";

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

test("multiple native sessions share one stable customer runtime", async () => {
  let starts = 0;
  let stops = 0;
  const manager = new RuntimeManager({
    async start(input) {
      starts += 1;
      return {
        id: `customer-runtime-${starts}`,
        url: `http://127.0.0.1:${4500 + starts}`,
        workspacePath: input.workspacePath,
        stop: async () => {
          stops += 1;
        },
      };
    },
    async healthy() {
      return true;
    },
  });
  const firstSessionTarget = {
    id: "customer-acme",
    runtimeId: "customer-acme",
    workspacePath: "/tmp/customers/acme",
  };
  const secondSessionTarget = {
    id: "customer-acme",
    runtimeId: "customer-acme",
    workspacePath: "/tmp/customers/acme",
  };
  const first = await manager.ensure(firstSessionTarget);
  const second = await manager.ensure(secondSessionTarget);
  assert.equal(starts, 1);
  assert.equal(second.token, first.token);
  assert.equal(manager.getBinding(secondSessionTarget)?.runtimeId, "customer-acme");
  await manager.stop(secondSessionTarget);
  assert.equal(stops, 1);
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

test("enterprise process runtime passes the managed model and content markers to native server", async () => {
  const root = await mkdtemp(join(tmpdir(), "enterprise-runtime-env-"));
  const markerPath = join(root, "managed-markers.json");
  const serverEntry = join(root, "server.mjs");
  await writeFile(
    serverEntry,
    [
      'import { createServer } from "node:http";',
      'import { writeFile } from "node:fs/promises";',
      `const markerPath = ${JSON.stringify(markerPath)};`,
      "await writeFile(",
      "  markerPath,",
      "  JSON.stringify({",
      '    managedModel: process.env.ZCODE_ENTERPRISE_MANAGED_MODEL ?? "",',
      '    managedContent: process.env.ZCODE_ENTERPRISE_MANAGED_CONTENT ?? "",',
      "  }),",
      ");",
      "const server = createServer((request, response) => {",
      '  if (request.url !== "/api/server-info") { response.writeHead(404); response.end(); return; }',
      '  response.setHeader("content-type", "application/json");',
      "  response.end(JSON.stringify({ workspaces: [{ path: process.env.ZCODE_SERVER_WORKSPACE }] }));",
      "});",
      'server.listen(Number(process.env.PORT), "127.0.0.1");',
      'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    ].join("\n"),
  );
  const adapter = new ProcessRuntimeAdapter({
    serverEntry,
    dataRoot: join(root, "runtimes"),
  });
  let handle: Awaited<ReturnType<ProcessRuntimeAdapter["start"]>> | undefined;
  try {
    handle = await adapter.start({ id: "customer-a", workspacePath: root, token: "test-token" });
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      managedModel: "1",
      managedContent: "1",
    });
  } finally {
    await handle?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("enterprise container runtime passes the managed content marker via docker env", async () => {
  const root = await mkdtemp(join(tmpdir(), "enterprise-container-env-"));
  // 用假 docker shim 走真实 ContainerRuntimeAdapter.start 路径:记录收到的
  // docker 参数,并为健康检查拉起一个返回 /api/server-info 的独立服务进程。
  const shimDir = join(root, "bin");
  const argsPath = join(root, "docker-args.jsonl");
  const port = await allocateFreePort();
  await mkdir(shimDir, { recursive: true });
  await writeFile(
    join(shimDir, "docker"),
    [
      "#!/usr/bin/env node",
      'const { appendFile } = require("node:fs/promises");',
      'const { spawn } = require("node:child_process");',
      `const argsPath = ${JSON.stringify(argsPath)};`,
      `const port = ${JSON.stringify(port)};`,
      "const args = process.argv.slice(2);",
      "appendFile(argsPath, JSON.stringify(args) + '\\n', 'utf8').then(() => {",
      '  if (args[0] === "run") {',
      "    const serverCode = [",
      "      'const http = require(\"node:http\");',",
      "      'const server = http.createServer((request, response) => {',",
      "      '  if (request.url !== \"/api/server-info\") { response.writeHead(404); response.end(); return; }',",
      "      '  response.setHeader(\"content-type\", \"application/json\");',",
      `      '  response.end(JSON.stringify({ workspaces: [{ path: ${JSON.stringify(root)} }] }));',`,
      "      '});',",
      `      'server.listen(${port}, "127.0.0.1");',`,
      "      'setTimeout(() => process.exit(0), 20000);',",
      "    ].join(\"\\n\");",
      "    const child = spawn(process.execPath, ['-e', serverCode], { detached: true, stdio: 'ignore' });",
      "    child.unref();",
      "    setTimeout(() => { console.log('fake-container-id'); process.exit(0); }, 150);",
      "    return;",
      "  }",
      '  if (args[0] === "port") { console.log(`0.0.0.0:${port}`); process.exit(0); }',
      "  process.exit(0);",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${previousPath ?? ""}`;
  const adapter = new ContainerRuntimeAdapter({
    image: "zcode-enterprise-test",
    dataRoot: root,
  });
  let handle: Awaited<ReturnType<ContainerRuntimeAdapter["start"]>> | undefined;
  try {
    handle = await adapter.start({
      id: "customer-container",
      workspacePath: root,
      token: "test-token",
    });
    const invocations = (await readFile(argsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const runArgs = invocations.find((args) => args[0] === "run");
    assert.ok(runArgs, "fake docker should have received the run invocation");
    assert.ok(runArgs.includes("ZCODE_ENTERPRISE_MANAGED_MODEL=1"));
    assert.ok(runArgs.includes("ZCODE_ENTERPRISE_MANAGED_CONTENT=1"));
  } finally {
    await handle?.stop();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

async function allocateFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

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
