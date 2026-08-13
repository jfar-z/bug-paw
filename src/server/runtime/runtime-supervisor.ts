import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import type { PiRuntimeGateway } from "../pi-runtime";
import type { AgentRuntimeContext, RuntimeLease } from "./runtime-types";

export interface RuntimeSupervisorOptions {
  modelRuntime: ModelRuntime;
  resolveAgent(agentId: string): Promise<{ cwd: string }>;
  createRuntime(context: AgentRuntimeContext): Promise<PiRuntimeGateway>;
}

interface RuntimeEntry {
  agentId: string;
  generation: number;
  runtime: PiRuntimeGateway;
  leaseCount: number;
  retiring: boolean;
  disposed: boolean;
  disposal?: Promise<void>;
  retireListeners: Set<() => void>;
  removeIdleListener?: () => void;
}

interface PendingRuntime {
  generation: number;
  promise: Promise<RuntimeEntry>;
}

/** 通过代次和显式租约管理全部 Agent Runtime 生命周期。 */
export class RuntimeSupervisor {
  private modelRuntime: ModelRuntime;
  private readonly resolveAgent: RuntimeSupervisorOptions["resolveAgent"];
  private readonly createRuntime: RuntimeSupervisorOptions["createRuntime"];
  private readonly generations = new Map<string, number>();
  private readonly current = new Map<string, RuntimeEntry>();
  private readonly pending = new Map<string, PendingRuntime>();
  private readonly retired = new Set<RuntimeEntry>();
  private readonly removed = new Set<string>();
  private closing = false;
  private maintenance = false;
  private drainPromise?: Promise<void>;

  constructor(options: RuntimeSupervisorOptions) {
    this.modelRuntime = options.modelRuntime;
    this.resolveAgent = options.resolveAgent;
    this.createRuntime = options.createRuntime;
  }

  get activeLeaseCount(): number {
    return [...this.current.values(), ...this.retired].reduce((count, entry) => count + entry.leaseCount, 0);
  }

  get trackedAgentCount(): number {
    return new Set([...this.knownAgentIds(), ...this.removed]).size;
  }

  /** 获取当前代 Runtime；同一 Agent/代次只执行一次创建。 */
  async acquire(agentId: string): Promise<RuntimeLease> {
    if (this.closing || this.maintenance) throw new DomainError("OPERATION_ABORTED", this.closing ? "服务正在关闭，无法创建 Runtime 租约" : "Runtime 正在维护，请稍后重试");
    if (this.removed.has(agentId)) throw new DomainError("AGENT_NOT_FOUND", "Agent 不存在");
    const generation = this.generationOf(agentId);
    let entry = this.current.get(agentId);
    if (!entry || entry.generation !== generation || entry.retiring) {
      const existing = this.pending.get(agentId);
      const pending = existing?.generation === generation ? existing : this.beginCreation(agentId, generation);
      entry = await pending.promise;
    }
    if (entry.retiring || entry.generation !== this.generationOf(agentId) || this.removed.has(agentId)) {
      this.retire(entry);
      throw new DomainError("RUNTIME_GENERATION_RETIRED", "Runtime 已在创建期间失效，请重试");
    }
    entry.leaseCount += 1;
    let released = false;
    let notifyRetired: () => void = () => undefined;
    const retired = new Promise<void>((resolve) => { notifyRetired = resolve; });
    entry.retireListeners.add(notifyRetired);
    return {
      runtime: entry.runtime,
      generation: entry.generation,
      retired,
      release: () => {
        if (released) return;
        released = true;
        entry!.retireListeners.delete(notifyRetired);
        entry!.leaseCount = Math.max(0, entry!.leaseCount - 1);
        this.tryDispose(entry!);
      },
    };
  }

  async refreshAgent(agentId: string): Promise<void> {
    const entry = this.invalidate(agentId);
    if (entry?.disposal) await entry.disposal;
  }

  async refreshAllAgents(): Promise<void> {
    for (const agentId of this.knownAgentIds()) await this.refreshAgent(agentId);
  }

  async replaceModelRuntime(modelRuntime: ModelRuntime): Promise<void> {
    this.modelRuntime = modelRuntime;
    await this.refreshAllAgents();
  }

  async refreshModels(): Promise<void> {
    await this.modelRuntime.refresh({ allowNetwork: false });
    await this.refreshAllAgents();
  }

  async abortAll(): Promise<number> {
    const entries = [...this.current.values(), ...this.retired].filter((entry, index, all) => all.indexOf(entry) === index);
    const results = await Promise.allSettled(entries.map((entry) => entry.runtime.abortAll()));
    return results.reduce((count, result) => count + (result.status === "fulfilled" ? result.value : 0), 0);
  }

  /** 暂停新租约并完整排空全部 Runtime，供跨会话配置迁移使用。 */
  async beginMaintenance(timeoutMs: number = SYSTEM_LIMITS.shutdownDrainMs): Promise<{ release(): void }> {
    if (this.closing || this.maintenance) throw new DomainError("OPERATION_ABORTED", "Runtime 已在关闭或维护中");
    this.maintenance = true;
    const deadline = Date.now() + timeoutMs;
    try {
      for (const agentId of this.knownAgentIds()) this.invalidate(agentId);
      await settleBefore(this.abortAll(), deadline);
      while (this.hasActiveWork() && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (this.hasActiveWork()) throw new DomainError("OPERATION_ABORTED", "Runtime 未能在维护预算内排空");
      const entries = [...this.retired];
      const disposals = entries.map((entry) => this.disposeEntry(entry));
      await settleBefore(Promise.allSettled(disposals), deadline);
      if (entries.some((entry) => !entry.disposed)) {
        throw new DomainError("OPERATION_ABORTED", "Runtime 检查点未能在维护预算内落盘");
      }
    } catch (error) {
      this.maintenance = false;
      throw error;
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.maintenance = false;
      },
    };
  }

  /** 阻止新租约并排空指定 Agent；持久化操作结束后必须 finalize 或 restore。 */
  async removeAgent(agentId: string, timeoutMs: number = SYSTEM_LIMITS.shutdownDrainMs): Promise<void> {
    this.removed.add(agentId);
    this.invalidate(agentId);
    const deadline = Date.now() + timeoutMs;
    const entries = [...this.retired].filter((entry) => entry.agentId === agentId);
    await settleBefore(Promise.allSettled(entries.map((entry) => entry.runtime.abortAll())), deadline);
    while (this.hasAgentWork(agentId) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (this.hasAgentWork(agentId)) {
      throw new DomainError("OPERATION_ABORTED", "Agent 仍有未结束操作，取消删除");
    }
    const retiring = [...this.retired].filter((candidate) => candidate.agentId === agentId);
    const disposals = retiring.map((entry) => this.disposeEntry(entry));
    await settleBefore(Promise.allSettled(disposals), deadline);
    if (retiring.some((entry) => !entry.disposed)) {
      throw new DomainError("OPERATION_ABORTED", "Agent Runtime 检查点未能在删除预算内落盘");
    }
  }

  finalizeAgentRemoval(agentId: string): void {
    this.removed.delete(agentId);
    this.cleanupAgentState(agentId);
  }

  restoreAgent(agentId: string): void {
    this.removed.delete(agentId);
    this.cleanupAgentState(agentId);
  }

  /** 停止接受旧代 Runtime，等待租约释放并在截止时间后强制销毁。 */
  async drainAndDispose(timeoutMs: number = SYSTEM_LIMITS.shutdownDrainMs): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.closing = true;
    this.drainPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      for (const agentId of this.knownAgentIds()) this.invalidate(agentId);
      await settleBefore(this.abortAll(), deadline);
      while (this.hasActiveWork() && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      const entries = [...new Set([...this.current.values(), ...this.retired])];
      const disposals = entries.map((entry) => this.disposeEntry(entry));
      await settleBefore(Promise.allSettled(disposals), deadline);
      entries.forEach((entry) => this.forceDisposeEntry(entry));
      this.current.clear();
      this.retired.clear();
      this.generations.clear();
      this.removed.clear();
    })();
    return this.drainPromise;
  }

  private beginCreation(agentId: string, generation: number): PendingRuntime {
    let promise: Promise<RuntimeEntry>;
    promise = (async () => {
      const agent = await this.resolveAgent(agentId);
      const runtime = await this.createRuntime({ agentId, cwd: agent.cwd, modelRuntime: this.modelRuntime });
      if (this.closing || generation !== this.generationOf(agentId) || this.removed.has(agentId)) {
        await runtime.drain?.().catch(() => undefined);
        runtime.dispose();
        throw new DomainError(
          this.closing ? "OPERATION_ABORTED" : "RUNTIME_GENERATION_RETIRED",
          this.closing ? "服务正在关闭，Runtime 创建已取消" : "Runtime 已在创建期间失效，请重试",
        );
      }
      const entry: RuntimeEntry = {
        agentId,
        generation,
        runtime,
        leaseCount: 0,
        retiring: false,
        disposed: false,
        retireListeners: new Set(),
      };
      this.current.set(agentId, entry);
      return entry;
    })().finally(() => {
      if (this.pending.get(agentId)?.promise === promise) this.pending.delete(agentId);
      this.cleanupAgentState(agentId);
    });
    const pending = { generation, promise };
    this.pending.set(agentId, pending);
    return pending;
  }

  private generationOf(agentId: string): number {
    return this.generations.get(agentId) ?? 0;
  }

  private invalidate(agentId: string): RuntimeEntry | undefined {
    this.generations.set(agentId, this.generationOf(agentId) + 1);
    const entry = this.current.get(agentId);
    if (!entry) {
      this.cleanupAgentState(agentId);
      return undefined;
    }
    this.current.delete(agentId);
    this.retire(entry);
    return entry;
  }

  private retire(entry: RuntimeEntry): void {
    if (entry.disposed || entry.retiring) return;
    entry.retiring = true;
    entry.retireListeners.forEach((notify) => notify());
    entry.retireListeners.clear();
    this.retired.add(entry);
    if (entry.runtime.onIdle) {
      entry.removeIdleListener = entry.runtime.onIdle(() => this.tryDispose(entry));
    }
    this.tryDispose(entry);
  }

  private tryDispose(entry: RuntimeEntry): void {
    if (!entry.retiring || entry.leaseCount > 0 || entry.runtime.isBusy?.()) return;
    this.disposeEntry(entry);
  }

  private disposeEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    if (entry.disposed) return Promise.resolve();
    entry.removeIdleListener?.();
    const draining = entry.runtime.drain?.();
    if (!draining) {
      this.finalizeDisposeEntry(entry);
      entry.disposal = Promise.resolve();
      return entry.disposal;
    }
    entry.disposal = draining.catch(() => undefined).then(() => this.finalizeDisposeEntry(entry));
    return entry.disposal;
  }

  private forceDisposeEntry(entry: RuntimeEntry): void {
    this.finalizeDisposeEntry(entry);
  }

  private finalizeDisposeEntry(entry: RuntimeEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.runtime.dispose();
    this.retired.delete(entry);
    if (this.current.get(entry.agentId) === entry) this.current.delete(entry.agentId);
    this.cleanupAgentState(entry.agentId);
  }

  private cleanupAgentState(agentId: string): void {
    const hasRetired = [...this.retired].some((entry) => entry.agentId === agentId);
    if (this.current.has(agentId) || this.pending.has(agentId) || hasRetired) return;
    // Agent 存在性由 Repository 负责；代次只需覆盖仍在途的 Runtime，结束后立即释放。
    this.generations.delete(agentId);
  }

  private knownAgentIds(): Set<string> {
    return new Set([...this.generations.keys(), ...this.current.keys(), ...this.pending.keys()]);
  }

  private hasActiveWork(): boolean {
    const entries = [...this.current.values(), ...this.retired];
    return this.pending.size > 0
      || this.activeLeaseCount > 0
      || entries.some((entry) => entry.runtime.isBusy?.() === true);
  }

  private hasAgentWork(agentId: string): boolean {
    if (this.pending.has(agentId)) return true;
    return [...this.current.values(), ...this.retired]
      .filter((entry) => entry.agentId === agentId)
      .some((entry) => entry.leaseCount > 0 || entry.runtime.isBusy?.() === true);
  }
}

/** 等待操作到统一截止时间；底层拒绝或挂起都不能突破服务关闭预算。 */
async function settleBefore(operation: Promise<unknown>, deadline: number): Promise<void> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    }),
  ]);
  if (timer) clearTimeout(timer);
}
