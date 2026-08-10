import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";

interface RegistryEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
}

/** 有界、一次性消费的配置导入预览仓库。 */
export class ImportPreviewRegistry<T> {
  private readonly entries = new Map<string, RegistryEntry<T>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; maxEntries?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? SYSTEM_LIMITS.importPreviewEntries;
    this.ttlMs = options.ttlMs ?? SYSTEM_LIMITS.importPreviewTtlMs;
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  create(id: string, value: T): void {
    this.sweep();
    if (this.entries.has(id)) throw new DomainError("VERSION_CONFLICT", "导入预览标识重复");
    while (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries].sort((left, right) => left[1].createdAt - right[1].createdAt)[0]?.[0];
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    const createdAt = this.now();
    this.entries.set(id, { value, createdAt, expiresAt: createdAt + this.ttlMs });
  }

  consume(id: string): T {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) throw new DomainError("IMPORT_PREVIEW_EXPIRED", "导入预览已失效，请重新预览");
    this.entries.delete(id);
    return entry.value;
  }

  sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
