import type { Duplex } from "node:stream";
import type { EnterpriseRuntimeTarget } from "./types.js";
import type { RuntimeBinding, RuntimeManager } from "./runtime.js";
import type { EnterpriseStore } from "./store.js";

export type RuntimeGovernorOptions = {
  runtimeIdleMs?: number;
  runtimeReapIntervalMs?: number;
  maxRuntimes?: number;
};

export type RuntimeGovernorInput = {
  store: EnterpriseStore;
  runtimes: RuntimeManager;
  options: RuntimeGovernorOptions;
  /** 会话 socket 表(网关所有);附着判定与停止路径都基于它。 */
  sockets: Map<string, Set<Duplex>>;
  /** 唯一的 fail-fast 停止路径(先销毁指向该 runtime 的会话 socket 再停止)。 */
  stopRuntime(value: EnterpriseRuntimeTarget): Promise<void>;
};

/**
 * 空闲回收与并发上限的治理器(全部可选,默认关闭,不影响开发行为)。
 *
 * 状态所有权:RuntimeManager 是 live/pending runtime 的唯一所有者;治理器只持有
 * 会话 socket 的只读视图和这份活跃登记(网关内存,进程重启即重建)。回收与驱逐
 * 都复用传入的 stopRuntime,不引入第二条停止路径。
 */
export class RuntimeGovernor {
  private readonly activity = new Map<
    string,
    { target: EnterpriseRuntimeTarget; lastActivity: number }
  >();
  private readonly reaping = new Set<string>();
  private readonly reapInterval: NodeJS.Timeout | null;
  private readonly idleMs: number;
  private readonly maxRuntimes: number;
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(private readonly input: RuntimeGovernorInput) {
    this.idleMs = input.options.runtimeIdleMs ?? 0;
    this.maxRuntimes = input.options.maxRuntimes ?? 0;
    this.reapInterval =
      this.idleMs > 0
        ? setInterval(() => this.reapIdleRuntimes(), input.options.runtimeReapIntervalMs ?? 60_000)
        : null;
    this.reapInterval?.unref();
  }

  /**
   * 上限准入下的 ensure 包装:每个请求都刷新活跃时间(既是空闲窗口的起点,也让
   * 驱逐排序有意义);新 runtime 超限时先驱逐,再在临界区内发起 start(manager.ensure
   * 的同步前缀注册 pending,锁不等待启动完成)。
   */
  async ensure(
    value: EnterpriseRuntimeTarget,
    start: () => Promise<RuntimeBinding>,
  ): Promise<RuntimeBinding> {
    this.touch(value);
    if (this.maxRuntimes <= 0 || this.occupiedRuntimeIds().has(value.runtimeId))
      return await start();
    const release = await this.beginRuntimeAdmission();
    let operation: Promise<RuntimeBinding> | undefined;
    try {
      const occupancy = this.occupiedRuntimeIds();
      if (!occupancy.has(value.runtimeId) && occupancy.size >= this.maxRuntimes) {
        const victim = this.pickEvictionTarget(value.runtimeId);
        if (victim) {
          await this.input.stopRuntime(victim);
        } else {
          // 全部占用方都在启动中时无处驱逐:放行并告警,不阻塞登录(过载下的
          // 抖动是显式接受的行为,见设计文档并发上限一节)。
          process.emitWarning(
            `Enterprise runtime cap ${this.maxRuntimes} exceeded with no evictable runtime; admitting anyway.`,
            { code: "ZCODE_ENTERPRISE_RUNTIME_CAP_EXCEEDED" },
          );
        }
      }
      operation = start();
    } finally {
      release();
    }
    return await operation!;
  }

  close(): void {
    if (this.reapInterval) clearInterval(this.reapInterval);
  }

  private touch(target: EnterpriseRuntimeTarget): void {
    this.activity.set(target.runtimeId, { target, lastActivity: Date.now() });
  }

  /** 与 stopRuntime 相同的判定:socket 所在会话的 active target 指向该 runtime 即附着。 */
  private attachedRuntimeIds(): Set<string> {
    const attached = new Set<string>();
    for (const [sessionId] of this.input.sockets) {
      const active = this.input.store.getActiveRuntimeTarget(sessionId);
      if (active?.runtimeId) attached.add(active.runtimeId);
    }
    return attached;
  }

  private occupiedRuntimeIds(): Set<string> {
    const occupied = new Set<string>(this.input.runtimes.pendingRuntimeIds());
    for (const binding of this.input.runtimes.listLive())
      occupied.add(binding.runtimeId ?? binding.caseId);
    return occupied;
  }

  /**
   * 准入串行化:两个并发登录各自读到"未超限"会重复放行,检查、驱逐与 pending
   * 注册必须在同一临界区内完成。
   */
  private async beginRuntimeAdmission(): Promise<() => void> {
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((done) => {
      release = done;
    });
    await previous;
    return release;
  }

  /** 驱逐对象:排除请求自身与启动中的 runtime;优先无附着 socket,其次最久未活跃。 */
  private pickEvictionTarget(incoming: string): EnterpriseRuntimeTarget | null {
    const attached = this.attachedRuntimeIds();
    const pending = new Set<string>(this.input.runtimes.pendingRuntimeIds());
    let candidate: {
      target: EnterpriseRuntimeTarget;
      attached: boolean;
      lastActivity: number;
    } | null = null;
    for (const binding of this.input.runtimes.listLive()) {
      const runtimeId = binding.runtimeId ?? binding.caseId;
      if (runtimeId === incoming || pending.has(runtimeId)) continue;
      const activity = this.activity.get(runtimeId);
      if (!activity) continue;
      const entry = {
        target: activity.target,
        attached: attached.has(runtimeId),
        lastActivity: activity.lastActivity,
      };
      const better = !candidate
        ? true
        : entry.attached !== candidate.attached
          ? !entry.attached
          : entry.lastActivity < candidate.lastActivity;
      if (better) candidate = entry;
    }
    return candidate?.target ?? null;
  }

  // 空闲定义 = 整个窗口内没有任何会话 socket 附着在该 runtime 上。MCP 中继请求
  // 不计入活跃:中继请求由容器内的 runtime 自身发起(runtime 是中继的客户端,不
  // 是消费者),runtime 被回收后不会再产生中继流量,也就没有需要保活的运行时;
  // 网关代理的 HTTP/WS 访问都会经过 ensureRuntime,天然刷新活跃时间。
  private reapIdleRuntimes(): void {
    if (this.idleMs <= 0) return;
    const pending = new Set<string>(this.input.runtimes.pendingRuntimeIds());
    const attached = this.attachedRuntimeIds();
    const live = new Set<string>();
    for (const binding of this.input.runtimes.listLive())
      live.add(binding.runtimeId ?? binding.caseId);
    const now = Date.now();
    // 已停止 runtime 的活跃登记同步清理,避免 map 无界增长。
    for (const runtimeId of this.activity.keys()) {
      if (!live.has(runtimeId)) this.activity.delete(runtimeId);
    }
    for (const runtimeId of live) {
      const activity = this.activity.get(runtimeId);
      if (!activity || pending.has(runtimeId) || this.reaping.has(runtimeId)) continue;
      if (attached.has(runtimeId)) {
        // 浏览器 socket 附着 = 持续活跃;刷新时间戳供并发上限的驱逐排序使用。
        activity.lastActivity = now;
        continue;
      }
      if (now - activity.lastActivity >= this.idleMs) {
        this.reaping.add(runtimeId);
        void this.input
          .stopRuntime(activity.target)
          .catch((error: unknown) => {
            process.emitWarning(
              `Failed to reap idle runtime ${runtimeId}: ${error instanceof Error ? error.message : String(error)}`,
              { code: "ZCODE_ENTERPRISE_RUNTIME_REAP_FAILED" },
            );
          })
          .finally(() => {
            this.reaping.delete(runtimeId);
          });
      }
    }
  }
}
