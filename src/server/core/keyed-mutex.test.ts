// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { KeyedMutex } from "./keyed-mutex";

describe("KeyedMutex", () => {
  it("同一实体串行执行并在结束后释放键", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = mutex.run("a", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first:end");
    });
    const second = mutex.run("a", async () => { order.push("second"); });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(mutex.size).toBe(0);
  });
});
