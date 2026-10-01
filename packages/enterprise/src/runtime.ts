import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RuntimeCase {
  id: string;
  workspacePath: string;
  /** Stable runtime owner; the expert (user×tenant) id. */
  runtimeId?: string;
  /** 该专家租户下全部客户工作区;容器逐一挂载并由原生 server 广播。 */
  workspacePaths?: string[];
}
export interface RuntimeHandle {
  id: string;
  url: string;
  workspacePath?: string;
  stop(): Promise<void>;
}
export interface RuntimeAdapter {
  stopStale?(caseInfo: RuntimeCase): Promise<void>;
  start(input: RuntimeCase & { token: string }): Promise<RuntimeHandle>;
  healthy(handle: RuntimeHandle, token: string): Promise<boolean>;
  ownsSession?(caseInfo: RuntimeCase, nativeSessionId: string): Promise<boolean>;
}
export interface RuntimeLifecycleHooks {
  beforeStop?(): void;
  beforeStart?(): Promise<void>;
}
export interface RuntimeBinding {
  caseId: string;
  runtimeId?: string;
  workspacePath: string;
  url: string;
  token: string;
}

export class RuntimeManager {
  private readonly live = new Map<string, { binding: RuntimeBinding; handle: RuntimeHandle }>();
  private readonly pending = new Map<string, Promise<RuntimeBinding>>();
  private shuttingDown = false;
  private stoppingAll: Promise<void> | null = null;

  constructor(private readonly adapter: RuntimeAdapter) {}

  async ensure(caseInfo: RuntimeCase, hooks: RuntimeLifecycleHooks = {}): Promise<RuntimeBinding> {
    if (this.shuttingDown) throw new Error("Runtime manager is shutting down");
    const runtimeId = caseInfo.runtimeId ?? caseInfo.id;
    const pending = this.pending.get(runtimeId);
    if (pending) return pending;
    const operation = this.ensureOnce(caseInfo, hooks);
    this.pending.set(runtimeId, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(runtimeId);
    }
  }

  private async ensureOnce(
    caseInfo: RuntimeCase,
    hooks: RuntimeLifecycleHooks,
  ): Promise<RuntimeBinding> {
    const runtimeId = caseInfo.runtimeId ?? caseInfo.id;
    const runtimeInput = { ...caseInfo, id: runtimeId, runtimeId };
    const current = this.live.get(runtimeId);
    // 专家 runtime 的身份只由 runtimeId 决定:同一专家切换主工作区(最近打开的
    // 客户)复用同一 runtime,不触发重启;只有健康检查失败才替换。
    if (current && (await this.adapter.healthy(current.handle, current.binding.token))) {
      return current.binding;
    }
    if (current) {
      hooks.beforeStop?.();
      this.live.delete(runtimeId);
      await current.handle.stop();
    }
    // 工作区会被运行时写入；重新物化/重新挂载前先停止旧容器，再启动新运行时。
    await this.adapter.stopStale?.(runtimeInput);
    await hooks.beforeStart?.();
    const token = randomBytes(32).toString("base64url");
    const handle = await this.adapter.start({ ...runtimeInput, token });
    const binding = {
      caseId: runtimeId,
      runtimeId,
      workspacePath: caseInfo.workspacePath,
      url: handle.url,
      token,
    };
    this.live.set(runtimeId, { binding, handle });
    return binding;
  }

  getBinding(caseInfo: RuntimeCase): RuntimeBinding | null {
    const runtimeId = caseInfo.runtimeId ?? caseInfo.id;
    return this.live.get(runtimeId)?.binding ?? null;
  }

  async ownsSession(caseInfo: RuntimeCase, nativeSessionId: string): Promise<boolean> {
    const runtimeId = caseInfo.runtimeId ?? caseInfo.id;
    return (
      this.adapter.ownsSession?.({ ...caseInfo, id: runtimeId, runtimeId }, nativeSessionId) ??
      false
    );
  }

  async stop(caseInfo: RuntimeCase, beforeStop?: () => void): Promise<void> {
    const runtimeId = caseInfo.runtimeId ?? caseInfo.id;
    await this.pending.get(runtimeId);
    beforeStop?.();
    const current = this.live.get(runtimeId);
    if (current) {
      this.live.delete(runtimeId);
      await current.handle.stop();
    } else {
      // 权限撤销和工作区更新也要清理上一 gateway 进程遗留的容器。
      await this.adapter.stopStale?.({ ...caseInfo, id: runtimeId, runtimeId });
    }
  }

  stopAll(): Promise<void> {
    if (this.stoppingAll) return this.stoppingAll;
    this.shuttingDown = true;
    const pending = [...this.pending.values()];
    this.stoppingAll = (async () => {
      // 启动中的容器在 await adapter.start 后才进入 live；等待这些操作后统一停止。
      await Promise.allSettled(pending);
      const handles = [...this.live.values()].map(({ handle }) => handle);
      this.live.clear();
      const results = await Promise.allSettled(handles.map((handle) => handle.stop()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Failed to stop all runtimes");
    })();
    return this.stoppingAll;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate runtime port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function waitHealthy(
  adapter: RuntimeAdapter,
  handle: RuntimeHandle,
  token: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await adapter.healthy(handle, token)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  await handle.stop();
  throw new Error("Native runtime failed its startup health check");
}

async function ownsIndexedSession(
  dataRoot: string,
  caseInfo: RuntimeCase,
  nativeSessionId: string,
): Promise<boolean> {
  const runtimeId = caseInfo.runtimeId ?? caseInfo.id;
  const index = join(dataRoot, runtimeId, ".zcode", "v2", "tasks-index.sqlite");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(index, { readOnly: true });
  } catch {
    return false;
  }
  try {
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM tasks WHERE workspace_key=? AND workspace_path=? AND task_id=? AND deleted=0 LIMIT 1",
        )
        .get(caseInfo.workspacePath, caseInfo.workspacePath, nativeSessionId),
    );
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export class ProcessRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly options: { serverEntry: string; dataRoot: string }) {}

  async start(input: RuntimeCase & { token: string }): Promise<RuntimeHandle> {
    const port = await freePort();
    const dataDir = join(this.options.dataRoot, input.id);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const advertised = [
      ...new Set([input.workspacePath, ...(input.workspacePaths ?? [])].filter(Boolean)),
    ];
    const child = spawn(process.execPath, [resolve(this.options.serverEntry)], {
      cwd: input.workspacePath,
      stdio: "ignore",
      env: {
        ...process.env,
        PORT: String(port),
        ZCODE_SERVER_HOST: "127.0.0.1",
        ZCODE_SERVER_WORKSPACE: input.workspacePath,
        ...(advertised.length > 1 ? { ZCODE_SERVER_WORKSPACES: advertised.join(":") } : {}),
        ZCODE_SERVER_AUTH_TOKEN: input.token,
        ZCODE_ENTERPRISE_MANAGED_MODEL: "1",
        HOME: dataDir,
        XDG_CONFIG_HOME: join(dataDir, "config"),
        XDG_DATA_HOME: join(dataDir, "data"),
      },
    });
    const handle: RuntimeHandle = {
      id: String(child.pid ?? "unknown"),
      url: `http://127.0.0.1:${port}`,
      workspacePath: input.workspacePath,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((done) => {
          child.once("close", () => done());
          if (!child.kill("SIGTERM") && (child.exitCode !== null || child.signalCode !== null))
            done();
        });
      },
    };
    await waitHealthy(this, handle, input.token);
    return handle;
  }

  async healthy(handle: RuntimeHandle, token: string): Promise<boolean> {
    try {
      const response = await fetch(`${handle.url}/api/server-info`, {
        headers: { cookie: `zcode_lite_token=${encodeURIComponent(token)}` },
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const info = (await response.json()) as { workspaces?: Array<{ path?: string }> };
      return (
        !handle.workspacePath ||
        info.workspaces?.some((workspace) => workspace.path === handle.workspacePath) === true
      );
    } catch {
      return false;
    }
  }

  async ownsSession(caseInfo: RuntimeCase, nativeSessionId: string): Promise<boolean> {
    return ownsIndexedSession(this.options.dataRoot, caseInfo, nativeSessionId);
  }
}

export class ContainerRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly options: { image: string; dataRoot: string }) {}

  private async docker(args: string[]): Promise<string> {
    return await new Promise<string>((done, reject) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        error += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? done(output.trim())
          : reject(new Error(`docker exited ${code}: ${error.trim()}`)),
      );
    });
  }

  private async removeContainer(identity: string): Promise<void> {
    const id = await this.docker(["ps", "-aq", "--filter", `name=^/${identity}$`]);
    if (id) await this.docker(["rm", "-f", id]);
  }

  async start(input: RuntimeCase & { token: string }): Promise<RuntimeHandle> {
    const dataDir = join(this.options.dataRoot, input.id);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const name = `zcode-enterprise-${input.id}`;
    // 专家容器挂载:专家 HOME 数据卷 + 租户全部客户工作区;不挂宿主 HOME 或其他租户卷。
    const mountPaths = [
      ...new Set(
        [input.workspacePath, ...(input.workspacePaths ?? [])]
          .filter(Boolean)
          .map((path) => resolve(path)),
      ),
    ];
    const advertised = [...new Set([resolve(input.workspacePath), ...mountPaths])];
    const dockerArgs = [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2g",
      "--cpus=2",
      `--user=${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
      "--tmpfs=/tmp:rw,nosuid,noexec,size=256m",
      "--add-host=host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::3030",
      "-v",
      `${resolve(dataDir)}:/home/zcode:rw`,
    ];
    for (const path of mountPaths) {
      dockerArgs.push("-v", `${path}:${path}:rw`);
    }
    dockerArgs.push(
      "-e",
      "HOME=/home/zcode",
      "-e",
      "PORT=3030",
      "-e",
      "ZCODE_SERVER_HOST=0.0.0.0",
      "-e",
      `ZCODE_SERVER_WORKSPACE=${resolve(input.workspacePath)}`,
    );
    if (advertised.length > 1) {
      dockerArgs.push("-e", `ZCODE_SERVER_WORKSPACES=${advertised.join(":")}`);
    }
    dockerArgs.push(
      "-e",
      `ZCODE_SERVER_AUTH_TOKEN=${input.token}`,
      "-e",
      "ZCODE_ENTERPRISE_MANAGED_MODEL=1",
      this.options.image,
    );
    const id = await this.docker(dockerArgs);
    const mapped = await this.docker(["port", id, "3030/tcp"]);
    const port = Number(mapped.match(/:(\d+)$/)?.[1]);
    if (!port) {
      await this.removeContainer(id);
      throw new Error("Container runtime has no mapped port");
    }
    const handle: RuntimeHandle = {
      id,
      url: `http://127.0.0.1:${port}`,
      workspacePath: input.workspacePath,
      stop: async () => {
        // removeContainer 使用 name filter；这里必须传启动时的容器名，不能传 Docker ID。
        await this.removeContainer(name);
      },
    };
    await waitHealthy(this, handle, input.token);
    return handle;
  }

  async stopStale(caseInfo: RuntimeCase): Promise<void> {
    // 上一个 gateway 进程可能遗留仍挂载 Case 工作区的同名容器。
    await this.removeContainer(`zcode-enterprise-${caseInfo.id}`);
  }

  async healthy(handle: RuntimeHandle, token: string): Promise<boolean> {
    try {
      const response = await fetch(`${handle.url}/api/server-info`, {
        headers: { cookie: `zcode_lite_token=${encodeURIComponent(token)}` },
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const info = (await response.json()) as { workspaces?: Array<{ path?: string }> };
      return (
        !handle.workspacePath ||
        info.workspaces?.some((workspace) => workspace.path === handle.workspacePath) === true
      );
    } catch {
      return false;
    }
  }

  async ownsSession(caseInfo: RuntimeCase, nativeSessionId: string): Promise<boolean> {
    return ownsIndexedSession(this.options.dataRoot, caseInfo, nativeSessionId);
  }
}
