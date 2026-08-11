import type { SearchProviderFailure } from "./search-provider";

/** 保存单个 Agent Run 内的搜索故障隔离与断路事实。 */
export class SearchRunState {
  private readonly unavailableByProvider = new Map<string, SearchProviderFailure>();
  private circuitOpen = false;

  /** 新 Run 开始时清除上一轮状态。 */
  reset(): void {
    this.unavailableByProvider.clear();
    this.circuitOpen = false;
  }

  /** 同一 Run 不再请求已经明确不可用的实例。 */
  shouldSkip(providerId: string): boolean {
    return this.unavailableByProvider.has(providerId);
  }

  /** 记录脱敏后的实例不可用事实。 */
  recordUnavailable(failure: SearchProviderFailure): void {
    this.unavailableByProvider.set(failure.provider, { ...failure });
  }

  /** 返回本 Run 已记录失败的只读快照。 */
  failures(): SearchProviderFailure[] {
    return [...this.unavailableByProvider.values()].map((failure) => ({ ...failure }));
  }

  /** 所有候选都不可用后阻止本 Run 再次发起搜索。 */
  openCircuit(): void {
    this.circuitOpen = true;
  }

  /** 返回断路状态；存在瞬时失败时允许用户在后续新 Run 再试。 */
  circuit(): { open: boolean; retryable: boolean } {
    const failures = this.failures();
    return {
      open: this.circuitOpen,
      retryable: this.circuitOpen && failures.some((failure) => failure.retryable),
    };
  }
}
