// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../pi-runtime";
import { SessionSummaryCache } from "./session-summary-cache";

const summary = (id: string): SessionSummary => ({
  id,
  path: `/data/pi/sessions/${id}.jsonl`,
  created: "2026-09-11T00:00:00.000Z",
  modified: "2026-09-11T00:00:00.000Z",
  messageCount: 2,
  firstMessage: "测试消息",
});

describe("SessionSummaryCache", () => {
  it("并发和后续读取只执行一次底层扫描", async () => {
    const loader = vi.fn(async () => [summary("session-1")]);
    const cache = new SessionSummaryCache(loader);

    const [first, second] = await Promise.all([cache.list(), cache.list()]);
    const third = await cache.list();

    expect(first).toEqual([summary("session-1")]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("未命中时刷新一次，并在删除回滚后恢复摘要", async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce([summary("session-1")])
      .mockResolvedValueOnce([summary("session-1"), summary("session-2")]);
    const cache = new SessionSummaryCache(loader);

    expect(await cache.find("session-2")).toEqual(summary("session-2"));
    cache.remove("session-2");
    expect(await cache.find("session-2")).toBeUndefined();
    cache.upsert(summary("session-2"));
    expect(await cache.find("session-2")).toEqual(summary("session-2"));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("并发未命中只触发一次强制刷新", async () => {
    let releaseRefresh: () => void = () => undefined;
    const refreshReady = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const loader = vi.fn()
      .mockResolvedValueOnce([summary("session-1")])
      .mockImplementationOnce(async () => {
        await refreshReady;
        return [summary("session-1")];
      });
    const cache = new SessionSummaryCache(loader);
    await cache.list();

    const first = cache.find("missing-1");
    const second = cache.find("missing-2");
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
