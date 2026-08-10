// @vitest-environment node

import { describe, expect, it } from "vitest";

import { EventJournal } from "./event-journal";

describe("EventJournal", () => {
  it("为事件分配严格递增序号并按游标重放", () => {
    const journal = new EventJournal<{ id: number; value: string }>({ maxEntries: 3, maxBytes: 1_000 });
    journal.append({ value: "a" });
    journal.append({ value: "b" });

    expect(journal.replay(0)).toEqual({ kind: "replay", events: [{ id: 1, value: "a" }, { id: 2, value: "b" }] });
    expect(journal.latestId).toBe(2);
  });

  it("游标早于最早保留事件时要求重新读取 Projection", () => {
    const journal = new EventJournal<{ id: number; value: string }>({ maxEntries: 2, maxBytes: 1_000 });
    journal.append({ value: "a" });
    journal.append({ value: "b" });
    journal.append({ value: "c" });

    expect(journal.replay(0)).toEqual({ kind: "projection_required", latestId: 3 });
    expect(journal.replay(1)).toEqual({ kind: "replay", events: [{ id: 2, value: "b" }, { id: 3, value: "c" }] });
  });

  it("同时执行条数和字节双上限", () => {
    const journal = new EventJournal<{ id: number; value: string }>({ maxEntries: 10, maxBytes: 70 });
    journal.append({ value: "a".repeat(40) });
    journal.append({ value: "b".repeat(40) });

    expect(journal.entries).toHaveLength(1);
    expect(journal.bytes).toBeLessThanOrEqual(70);
  });

  it("单个事件超过整个字节预算时拒绝保留", () => {
    const journal = new EventJournal<{ id: number; value: string }>({ maxEntries: 10, maxBytes: 64 });

    expect(() => journal.append({ value: "x".repeat(100) })).toThrow("事件载荷超过");
    expect(journal.entries).toEqual([]);
    expect(journal.bytes).toBe(0);
    expect(journal.latestId).toBe(0);
  });

  it("仅恢复最新序号但没有内存事件时要求重新读取 Projection", () => {
    const journal = new EventJournal<{ id: number; value: string }>();
    journal.restoreLatestId(9);

    expect(journal.replay(5)).toEqual({ kind: "projection_required", latestId: 9 });
    expect(journal.replay(20)).toEqual({ kind: "projection_required", latestId: 9 });
  });
});
