import type { WorkflowRun } from "../../shared/workflow-contracts";
import { invalid } from "./workflow-validation";

/** 根任务共享步数、轨迹容量与叶节点并发；容器不占用许可，避免嵌套死锁。 */
export class WorkflowExecutionBudget {
  private steps = 0;
  private bytes = 0;
  private active = 0;
  private readonly waiters = new Set<() => void>();
  constructor(readonly root: WorkflowRun) {
    this.account(root);
  }
  /** 在分配轨迹或写入输入输出前计入容量，超限保留已有记录并明确失败。 */
  account(value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
    if (this.bytes + bytes > 16 * 1024 * 1024)
      invalid("工作流运行快照及轨迹超过 16 MiB 上限");
    this.bytes += bytes;
  }
  /** 每个开始执行的节点均纳入总步数预算，涵盖所有嵌套作用域。 */
  step(): void {
    if (++this.steps > 10_000)
      invalid("工作流包含循环及子调用的总执行步数超过 10000");
  }
  /** 等待许可期间响应取消，释放时唤醒等待者重新竞争剩余许可。 */
  async leaf<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    while (this.active >= 3) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.waiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        this.waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
      for (const wake of [...this.waiters]) wake();
    }
  }
}
