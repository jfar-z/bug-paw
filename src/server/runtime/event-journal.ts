import { SYSTEM_LIMITS } from "../core/limits";

/** 有界事件日志的重放结果。 */
export type EventReplay<T> =
  | { kind: "replay"; events: T[] }
  | { kind: "projection_required"; latestId: number };

/** 为单个 Session 保存可重放的有界事件窗口。 */
export class EventJournal<T extends { id: number }> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly retained: Array<{ event: T; bytes: number }> = [];
  private nextId = 1;
  private retainedBytes = 0;

  constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = options.maxEntries ?? SYSTEM_LIMITS.eventJournalEntries;
    this.maxBytes = options.maxBytes ?? SYSTEM_LIMITS.eventJournalBytes;
  }

  get latestId(): number {
    return this.nextId - 1;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  get entries(): T[] {
    return this.retained.map(({ event }) => event);
  }

  append(event: Omit<T, "id">): T {
    const sequenced = { ...event, id: this.nextId } as T;
    const bytes = Buffer.byteLength(JSON.stringify(sequenced));
    if (bytes > this.maxBytes) {
      throw new RangeError("事件载荷超过 Event Journal 字节预算");
    }
    this.nextId += 1;
    this.retained.push({ event: sequenced, bytes });
    this.retainedBytes += bytes;
    while (this.retained.length > 1 && (this.retained.length > this.maxEntries || this.retainedBytes > this.maxBytes)) {
      const removed = this.retained.shift()!;
      this.retainedBytes -= removed.bytes;
    }
    return sequenced;
  }

  replay(afterId: number): EventReplay<T> {
    const firstRetainedId = this.retained[0]?.event.id;
    if (afterId > this.latestId || (afterId < this.latestId && (firstRetainedId === undefined || afterId < firstRetainedId - 1))) {
      return { kind: "projection_required", latestId: this.latestId };
    }
    return { kind: "replay", events: this.retained.filter(({ event }) => event.id > afterId).map(({ event }) => event) };
  }

  restoreLatestId(latestId: number): void {
    this.nextId = Math.max(this.nextId, latestId + 1);
  }
}
