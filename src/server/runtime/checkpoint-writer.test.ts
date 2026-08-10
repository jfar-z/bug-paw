// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { CheckpointWriter } from "./checkpoint-writer";

describe("CheckpointWriter", () => {
  it("合并连续更新且旧版本永远不能覆盖新版本", async () => {
    const writes: Array<{ sessionId: string; version: number }> = [];
    const writer = new CheckpointWriter({
      write: async (projection) => { writes.push(projection); },
      debounceMs: 1_000,
      maxDelayMs: 5_000,
    });

    writer.schedule({ sessionId: "s1", version: 1 });
    writer.schedule({ sessionId: "s1", version: 2 });
    writer.schedule({ sessionId: "s1", version: 1 });
    await writer.flush();

    expect(writes).toEqual([{ sessionId: "s1", version: 2 }]);
    await writer.dispose();
  });

  it("防抖定时器只写最后一个 Projection", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const writer = new CheckpointWriter({ write, debounceMs: 1_000, maxDelayMs: 5_000 });
    writer.schedule({ sessionId: "s1", version: 1 });
    writer.schedule({ sessionId: "s1", version: 2 });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ sessionId: "s1", version: 2 });
    await writer.dispose();
    vi.useRealTimers();
  });

  it("定时落盘失败通过结构化出口报告且不会形成未处理拒绝", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const writer = new CheckpointWriter({
      write: async () => { throw new Error("disk unavailable"); },
      debounceMs: 10,
      onError,
    });
    writer.schedule({ sessionId: "s1", version: 1 });

    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("大量 Session 成功落盘后不保留历史状态", async () => {
    const writer = new CheckpointWriter({ write: async () => undefined });
    for (let index = 0; index < 1_000; index += 1) {
      writer.schedule({ sessionId: `s-${index}`, version: 1 });
    }

    await writer.flush();

    expect(writer.pendingStateCount).toBe(0);
    await writer.dispose();
  });
});
