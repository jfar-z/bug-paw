import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";
import { useSessionSearch } from "./use-session-search";

function page(entryId: string, hasMore = false) {
  return {
    hits: [{
      sessionId: "session-1",
      sessionFirstMessage: "第一条",
      archived: false,
      entryId,
      role: "assistant" as const,
      timestamp: "2026-08-13T00:00:00.000Z",
      snippet: entryId,
      matchRanges: [{ start: 0, end: entryId.length }],
    }],
    hasMore,
    ...(hasMore ? { nextCursor: `cursor-${entryId}` } : {}),
  };
}

describe("useSessionSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("输入 300ms 后搜索且保留原始查询字符串", async () => {
    const search = vi.spyOn(api, "searchSessions").mockResolvedValue(page("assistant-1"));
    const { result } = renderHook(() => useSessionSearch("agent-a"));

    act(() => result.current.setQuery(" needle "));
    await act(async () => vi.advanceTimersByTime(299));
    expect(search).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));

    expect(search).toHaveBeenCalledWith("agent-a", { query: " needle " }, expect.any(AbortSignal));
    expect(result.current.state).toBe("success");
  });

  it("新查询取消旧请求且迟到响应不能覆盖新结果", async () => {
    const resolvers: Array<(value: ReturnType<typeof page>) => void> = [];
    const signals: AbortSignal[] = [];
    vi.spyOn(api, "searchSessions").mockImplementation(async (_agentId, _input, signal) => {
      signals.push(signal!);
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const { result } = renderHook(() => useSessionSearch("agent-a"));

    act(() => result.current.setQuery("first"));
    await act(async () => vi.advanceTimersByTime(300));
    act(() => result.current.setQuery("second"));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(300));
    await act(async () => { resolvers[1]!(page("new")); await Promise.resolve(); });
    expect(result.current.hits[0]?.entryId).toBe("new");
    await act(async () => resolvers[0]!(page("old")));

    expect(result.current.hits[0]?.entryId).toBe("new");
  });

  it("立即搜索、继续加载、错误和清空状态完整", async () => {
    const search = vi.spyOn(api, "searchSessions")
      .mockResolvedValueOnce(page("first", true))
      .mockResolvedValueOnce(page("second"))
      .mockRejectedValueOnce(new Error("搜索失败"));
    const { result } = renderHook(() => useSessionSearch("agent-a"));

    act(() => result.current.setQuery("needle"));
    await act(async () => result.current.searchNow());
    expect(result.current.hits.map(({ entryId }) => entryId)).toEqual(["first"]);
    await act(async () => result.current.loadMore());
    expect(search).toHaveBeenNthCalledWith(2, "agent-a", { query: "needle", cursor: "cursor-first" }, expect.any(AbortSignal));
    expect(result.current.hits.map(({ entryId }) => entryId)).toEqual(["first", "second"]);

    act(() => result.current.setQuery("broken"));
    await act(async () => result.current.searchNow());
    expect(result.current).toMatchObject({ state: "error", error: "搜索失败" });

    act(() => result.current.setQuery(""));
    expect(result.current).toMatchObject({ query: "", hits: [], state: "idle" });
  });
});
