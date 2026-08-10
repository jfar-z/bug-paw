import { DomainError } from "./errors";
import { SYSTEM_LIMITS } from "./limits";

interface AgentLifecycleState {
  activeMutations: number;
  removalOwner?: symbol;
  idleWaiters: Set<() => void>;
}

export interface AgentRemovalPermit {
  /** 提交删除并释放该 Agent 的生命周期状态。 */
  finalize(): void;
  /** 删除失败时重新允许 Agent 级写操作。 */
  restore(): void;
}

/** 阻断 Agent 删除与附件、Prompt、Workspace 等文件写入之间的竞态。 */
export class AgentLifecycleGate {
  private readonly states = new Map<string, AgentLifecycleState>();

  /** 在 Agent 未进入删除阶段时执行一个完整写操作。 */
  async runMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const state = this.stateFor(agentId);
    if (state.removalOwner) throw new DomainError("AGENT_REMOVAL_IN_PROGRESS", "Agent 正在删除，请稍后重试");
    state.activeMutations += 1;
    try {
      return await operation();
    } finally {
      state.activeMutations = Math.max(0, state.activeMutations - 1);
      if (state.activeMutations === 0) state.idleWaiters.forEach((resolve) => resolve());
      this.cleanup(agentId, state);
    }
  }

  /** 阻止新写操作并等待已进入的操作完成，返回仅属于本次删除的提交凭证。 */
  async beginRemoval(agentId: string, timeoutMs: number = SYSTEM_LIMITS.shutdownDrainMs): Promise<AgentRemovalPermit> {
    const state = this.stateFor(agentId);
    if (state.removalOwner) throw new DomainError("AGENT_REMOVAL_IN_PROGRESS", "Agent 正在删除，请勿重复提交");
    const owner = Symbol(agentId);
    state.removalOwner = owner;
    try {
      await this.waitForIdle(state, timeoutMs);
    } catch (error) {
      if (state.removalOwner === owner) state.removalOwner = undefined;
      this.cleanup(agentId, state);
      throw error;
    }
    let completed = false;
    const complete = (removed: boolean) => {
      if (completed || state.removalOwner !== owner) return;
      completed = true;
      state.removalOwner = undefined;
      if (removed || state.activeMutations === 0) this.states.delete(agentId);
    };
    return {
      finalize: () => complete(true),
      restore: () => complete(false),
    };
  }

  private stateFor(agentId: string): AgentLifecycleState {
    const existing = this.states.get(agentId);
    if (existing) return existing;
    const created = { activeMutations: 0, idleWaiters: new Set<() => void>() };
    this.states.set(agentId, created);
    return created;
  }

  private async waitForIdle(state: AgentLifecycleState, timeoutMs: number): Promise<void> {
    if (state.activeMutations === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveIdle: () => void = () => undefined;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
      state.idleWaiters.add(resolve);
    });
    try {
      await Promise.race([
        idle,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DomainError("OPERATION_ABORTED", "等待 Agent 写操作排空超时")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      state.idleWaiters.delete(resolveIdle);
    }
  }

  private cleanup(agentId: string, state: AgentLifecycleState): void {
    if (state.activeMutations === 0 && !state.removalOwner) this.states.delete(agentId);
  }
}
