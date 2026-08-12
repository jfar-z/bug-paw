import { randomUUID } from "node:crypto";

import type { BrowserPoolConfig } from "../../shared/browser-automation-contracts";
import { BrowserAutomationError } from "./browser-error";

/** 浏览器租约的释放原因。 */
export type BrowserLeaseReleaseReason = "run_completed" | "run_aborted" | "run_error" | "orphan_timeout" | "run_timeout" | "capability_disabled" | "service_shutdown";

/** 排队进度摘要。 */
export interface BrowserQueueUpdate {
  /** 当前请求前方的任务数加一。 */
  position: number;
  /** 队列总请求数。 */
  queued: number;
}

/** 浏览器资源租约。 */
export interface BrowserLease {
  /** 不透明租约标识。 */
  id: string;
  /** 租约所属 Agent。 */
  agentId: string;
  /** 租约所属 Run。 */
  runId: string;
  /** 获得资源的时间戳。 */
  acquiredAt: number;
  /** 刷新 Runtime 活跃时间。 */
  heartbeat(): void;
  /** 幂等释放租约。 */
  release(reason: BrowserLeaseReleaseReason): Promise<void>;
}

/** 资源池运行状态。 */
export interface BrowserPoolStatus {
  /** 活动 Context 数。 */
  activeContexts: number;
  /** 排队请求数。 */
  queuedRequests: number;
  /** 全局 Context 上限。 */
  maxContexts: number;
}

/** 申请资源的可信身份和取消上下文。 */
export interface BrowserLeaseRequest {
  /** 当前 Agent。 */
  agentId: string;
  /** 当前 Run。 */
  runId: string;
  /** 工具调用取消信号。 */
  signal: AbortSignal;
  /** 队列位置更新回调。 */
  onQueueUpdate?: (update: BrowserQueueUpdate) => void;
}

interface BrowserResourcePoolDependencies {
  /** 关闭 Worker Context。 */
  closeContext(leaseId: string, reason: BrowserLeaseReleaseReason): Promise<void>;
  /** 可测试当前时间。 */
  now?: () => number;
  /** 可测试租约标识。 */
  id?: () => string;
}

interface ActiveLeaseState {
  lease: BrowserLease;
  lastHeartbeatAt: number;
}

interface QueueEntry extends BrowserLeaseRequest {
  resolve(lease: BrowserLease): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  abortListener: () => void;
}

/** 管理全局 Browser Context、阻塞队列和 Run 租约回收。 */
export class BrowserResourcePool {
  /** 当前资源策略。 */
  private config: BrowserPoolConfig;
  /** 活动租约。 */
  private readonly active = new Map<string, ActiveLeaseState>();
  /** 按到达顺序保存、按 Agent 去重的等待队列。 */
  private readonly queue: QueueEntry[] = [];
  /** 当前时间函数。 */
  private readonly now: () => number;
  /** 租约标识函数。 */
  private readonly id: () => string;
  /** 定期回收计时器。 */
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  /** 是否已停止接收新请求。 */
  private closed = false;

  /** 创建资源池并启动轻量回收扫描。 */
  constructor(config: BrowserPoolConfig, private readonly dependencies: BrowserResourcePoolDependencies) {
    this.config = { ...config };
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, 1_000);
    this.sweepTimer.unref?.();
  }

  /** 获取可用租约；资源不足时保持 Promise 等待。 */
  acquire(input: BrowserLeaseRequest): Promise<BrowserLease> {
    if (this.closed) return Promise.reject(new BrowserAutomationError("BROWSER_CAPABILITY_DISABLED", "浏览器能力当前不可用", false));
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    if (this.hasAgent(input.agentId)) {
      return Promise.reject(new BrowserAutomationError("BROWSER_AGENT_QUOTA_REACHED", "当前 Agent 已有活动或排队中的浏览器任务", false));
    }
    if (this.active.size < this.config.maxContexts) return Promise.resolve(this.grant(input.agentId, input.runId));
    if (this.queue.length >= this.config.queueCapacity) {
      return Promise.reject(new BrowserAutomationError("BROWSER_QUEUE_FULL", "浏览器资源队列已满", true));
    }

    return new Promise<BrowserLease>((resolve, reject) => {
      const abortListener = () => {
        this.removeQueued(entry);
        reject(input.signal.reason);
      };
      const timer = setTimeout(() => {
        this.removeQueued(entry);
        reject(new BrowserAutomationError("BROWSER_POOL_WAIT_TIMEOUT", "等待浏览器资源超时", true));
      }, this.config.queueWaitMs);
      const entry: QueueEntry = { ...input, resolve, reject, timer, abortListener };
      this.queue.push(entry);
      input.signal.addEventListener("abort", abortListener, { once: true });
      this.publishQueuePositions();
    });
  }

  /** 返回不包含 Agent 身份的资源池摘要。 */
  status(): BrowserPoolStatus {
    return { activeContexts: this.active.size, queuedRequests: this.queue.length, maxContexts: this.config.maxContexts };
  }

  /** 应用收紧或放宽后的资源策略。 */
  async reconfigure(config: BrowserPoolConfig): Promise<void> {
    this.config = { ...config };
    await this.sweep();
    this.dispatch();
  }

  /** 停止队列并释放全部活动 Context。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    const error = new BrowserAutomationError("BROWSER_CAPABILITY_DISABLED", "浏览器能力已经关闭", false);
    this.queue.splice(0).forEach((entry) => {
      this.cleanupQueued(entry);
      entry.reject(error);
    });
    await Promise.all([...this.active.keys()].map((id) => this.release(id, "service_shutdown")));
  }

  /** 能力关闭时清空队列与 Context，但允许之后重新启用同一资源池。 */
  async disable(): Promise<void> {
    const error = new BrowserAutomationError("BROWSER_CAPABILITY_DISABLED", "浏览器能力已经关闭", false);
    this.queue.splice(0).forEach((entry) => {
      this.cleanupQueued(entry);
      entry.reject(error);
    });
    await Promise.all([...this.active.keys()].map((id) => this.release(id, "capability_disabled")));
  }

  /** 创建活动租约。 */
  private grant(agentId: string, runId: string): BrowserLease {
    const id = this.id();
    const acquiredAt = this.now();
    const lease: BrowserLease = {
      id,
      agentId,
      runId,
      acquiredAt,
      heartbeat: () => {
        const state = this.active.get(id);
        if (state) state.lastHeartbeatAt = this.now();
      },
      release: (reason) => this.release(id, reason),
    };
    this.active.set(id, { lease, lastHeartbeatAt: acquiredAt });
    return lease;
  }

  /** 幂等释放活动租约并派发队列。 */
  private async release(id: string, reason: BrowserLeaseReleaseReason): Promise<void> {
    if (!this.active.delete(id)) return;
    try {
      await this.dependencies.closeContext(id, reason);
    } finally {
      this.dispatch();
    }
  }

  /** 按到达顺序授予空闲资源。 */
  private dispatch(): void {
    while (!this.closed && this.active.size < this.config.maxContexts && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.cleanupQueued(entry);
      if (entry.signal.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      entry.resolve(this.grant(entry.agentId, entry.runId));
    }
    this.publishQueuePositions();
  }

  /** 回收失去心跳或到达总时限的租约。 */
  private async sweep(): Promise<void> {
    const now = this.now();
    const expirations: Array<{ id: string; reason: "run_timeout" | "orphan_timeout" }> = [];
    for (const { lease, lastHeartbeatAt } of this.active.values()) {
      if (now - lease.acquiredAt >= this.config.runTimeoutMs) {
        expirations.push({ id: lease.id, reason: "run_timeout" });
      } else if (now - lastHeartbeatAt >= this.config.orphanTimeoutMs) {
        expirations.push({ id: lease.id, reason: "orphan_timeout" });
      }
    }
    await Promise.all(expirations.map(({ id, reason }) => this.release(id, reason)));
  }

  /** 判断 Agent 是否已有活动或等待请求。 */
  private hasAgent(agentId: string): boolean {
    return [...this.active.values()].some(({ lease }) => lease.agentId === agentId)
      || this.queue.some((entry) => entry.agentId === agentId);
  }

  /** 从队列移除单项并刷新位置。 */
  private removeQueued(entry: QueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    this.cleanupQueued(entry);
    this.publishQueuePositions();
  }

  /** 清理队列项的 timer 与取消监听。 */
  private cleanupQueued(entry: QueueEntry): void {
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abortListener);
  }

  /** 向等待中的工具调用发布最新排队位置。 */
  private publishQueuePositions(): void {
    this.queue.forEach((entry, index) => entry.onQueueUpdate?.({ position: index + 1, queued: this.queue.length }));
  }
}
