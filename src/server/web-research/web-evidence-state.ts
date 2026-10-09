/** 本轮联网操作的脱敏错误，保留阶段与重试语义。 */
export class WebEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, string | number | boolean> = {},
  ) { super(message); this.name = "WebEvidenceError"; }
}

/** 缓存条目在本轮内复用；策略变化和下一轮会使其失效。 */
interface Entry {
  value: unknown;
  bytes: number;
  expiresAt: number;
}

/** 单个 Run 的内存缓存、并发请求合并与失败重试控制。 */
export class WebEvidenceState {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, { error: Error; policy: string }>();
  private generation = 0;

  /** 新 Run 不继承旧缓存或失败，未结束的旧请求也不能写入新状态。 */
  reset(): void {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
    this.failures.clear();
  }

  /** 同地址并发请求只发一次；失败不再联网，但仍返回原始可观测错误。 */
  async load<T>(kind: string, url: string, policy: string, operation: () => Promise<{ value: T; bytes: number }>): Promise<T> {
    const address = normalizeAddress(url);
    const failure = this.failures.get(`${kind}:${address}`);
    if (failure?.policy === policy) {
      const original = failure.error as Error & { code?: string; details?: Record<string, string | number | boolean> };
      throw new WebEvidenceError("WEB_READ_RETRY_BLOCKED", "该资源在本次运行中已读取失败，未重复发起联网请求", false, { originalCode: original.code ?? "WEB_FETCH_FAILED", ...original.details, retryBlocked: true });
    }
    const key = `${kind}:${new URL(url).toString()}:${policy}`;
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    this.entries.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const generation = this.generation;
    const task = operation().then(({ value, bytes }) => {
      if (generation === this.generation && bytes <= 4 * 1024 * 1024) {
        while (this.entries.size >= 8 || [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0) + bytes > 8 * 1024 * 1024) {
          const oldest = this.entries.keys().next().value;
          if (!oldest) break;
          this.entries.delete(oldest);
        }
        this.entries.set(key, { value, bytes, expiresAt: Date.now() + 5 * 60_000 });
      }
      return value;
    }).catch((error: unknown) => {
      if (generation === this.generation && error instanceof Error) {
        // 有界保存失败事实，避免模型生成无限地址耗尽内存。
        if (this.failures.size >= 64) this.failures.delete(this.failures.keys().next().value!);
        this.failures.set(`${kind}:${address}`, { error, policy });
      }
      throw error;
    }).finally(() => {
      if (generation === this.generation) this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }
}

/** 仅在失败去重中折叠末尾斜杠；查询参数保留，不能把不同资源合并。 */
function normalizeAddress(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/(?=\?|$)/u, "");
  } catch { return value; }
}

/** 外部取消立即结束等待，依赖仍自行使用同一信号停止网络或解析。 */
export function waitForEvidence<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}
