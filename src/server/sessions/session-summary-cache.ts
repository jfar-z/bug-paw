import type { SessionSummary } from "../pi-runtime";

/**
 * 缓存 Pi 会话摘要，避免列表、打开和删除操作重复扫描完整 JSONL 历史。
 */
export class SessionSummaryCache {
  private loaded = false;
  private loading?: Promise<void>;
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly removed = new Set<string>();

  constructor(private readonly loadSummaries: () => Promise<SessionSummary[]>) {}

  /** 返回当前摘要快照；首次调用才执行底层扫描。 */
  async list(): Promise<SessionSummary[]> {
    await this.ensureLoaded();
    return [...this.summaries.values()].map(copySummary);
  }

  /** 查找会话；缓存未命中时强制刷新一次，以兼容进程内新落盘的 JSONL。 */
  async find(sessionId: string): Promise<SessionSummary | undefined> {
    await this.ensureLoaded();
    const cached = this.summaries.get(sessionId);
    if (cached || this.removed.has(sessionId)) return cached ? copySummary(cached) : undefined;
    await this.refresh();
    const refreshed = this.summaries.get(sessionId);
    return refreshed ? copySummary(refreshed) : undefined;
  }

  /** 写入已知摘要，供删除回滚等不需要重新扫描文件的流程恢复索引。 */
  upsert(summary: SessionSummary): void {
    this.removed.delete(summary.id);
    this.summaries.set(summary.id, copySummary(summary));
  }

  /** 从当前索引移除摘要，并阻止并发中的旧扫描结果重新加入。 */
  remove(sessionId: string): void {
    this.removed.add(sessionId);
    this.summaries.delete(sessionId);
  }

  /** 重新读取底层摘要，并保留删除流程已经登记的排除项。 */
  async refresh(): Promise<void> {
    if (this.loading) {
      await this.loading;
      return;
    }
    this.summaries.clear();
    this.loaded = false;
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.loadSummaries()
        .then((summaries) => {
          for (const summary of summaries) {
            if (!this.removed.has(summary.id)) this.summaries.set(summary.id, copySummary(summary));
          }
          this.loaded = true;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.loading;
  }
}

function copySummary(summary: SessionSummary): SessionSummary {
  return { ...summary };
}
