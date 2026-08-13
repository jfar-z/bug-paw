import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import { api, type SessionSnapshot } from "./api";
import { useSessionHistory } from "./use-session-history";

let observerCallback: IntersectionObserverCallback;

class ObserverDouble {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
}

const snapshot = (): SessionSnapshot => ({
  id: "session-1",
  messages: [{ role: "user", __piEntryId: "user-21" }],
  history: { startEntryId: "user-21", branchToken: "branch-a", hasMoreBefore: true, hasMoreAfter: false, turnCount: 20 },
  lastEventId: 0,
});

describe("useSessionHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("IntersectionObserver", ObserverDouble);
  });

  it("顶部哨兵进入预加载区时同一游标只请求一次", async () => {
    vi.spyOn(api, "loadSessionHistory").mockResolvedValue({
      sessionId: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
    });
    const element = document.createElement("div");
    const { result } = renderHook(() => useSessionHistory({
      snapshot: snapshot(),
      scrollRef: { current: element },
      onPrepend: vi.fn(),
      onError: vi.fn(),
    }));
    act(() => result.current.sentinelRef(element));
    act(() => observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(api.loadSessionHistory).toHaveBeenCalledTimes(1));
    act(() => observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(api.loadSessionHistory).toHaveBeenCalledTimes(1);
  });

  it("前置页面提交后保持原消息视口位置", async () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      scrollTop: { value: 120, writable: true },
      scrollHeight: { value: 1000, writable: true },
    });
    let current = snapshot();
    vi.spyOn(api, "loadSessionHistory").mockResolvedValue({
      sessionId: "session-1",
      messages: [{ role: "user", __piEntryId: "user-1" }],
      history: { startEntryId: "user-1", branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 5 },
    });
    const { result, rerender } = renderHook(() => useSessionHistory({
      snapshot: current,
      scrollRef: { current: element } as RefObject<HTMLDivElement | null>,
      onPrepend: (page) => {
        Object.defineProperty(element, "scrollHeight", { value: 1600, writable: true });
        current = { ...current, messages: [...page.messages, ...current.messages], history: page.history };
      },
      onError: vi.fn(),
    }));
    act(() => result.current.sentinelRef(element));
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
    });
    rerender();
    expect(element.scrollTop).toBe(720);
  });

  it("聚焦窗口底部进入预加载区时追加较新页且不抢占滚动位置", async () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      scrollTop: { value: 360, writable: true },
      scrollHeight: { value: 1200, writable: true },
    });
    const current = {
      ...snapshot(),
      history: {
        startEntryId: "user-21",
        endEntryId: "assistant-40",
        branchToken: "branch-a",
        hasMoreBefore: true,
        hasMoreAfter: true,
        turnCount: 20,
      },
    };
    const onAppend = vi.fn();
    vi.spyOn(api, "loadSessionHistoryAfter").mockResolvedValue({
      sessionId: "session-1",
      messages: [{ role: "user", __piEntryId: "user-41" }],
      history: { startEntryId: "user-41", endEntryId: "assistant-60", branchToken: "branch-a", hasMoreBefore: true, hasMoreAfter: false, turnCount: 20 },
    });
    const { result } = renderHook(() => useSessionHistory({
      snapshot: current,
      focused: true,
      scrollRef: { current: element } as RefObject<HTMLDivElement | null>,
      onPrepend: vi.fn(),
      onAppend,
      onError: vi.fn(),
    }));
    act(() => result.current.newerSentinelRef(element));
    await act(async () => {
      observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
    });

    expect(api.loadSessionHistoryAfter).toHaveBeenCalledWith("session-1", "assistant-40", "branch-a", expect.any(AbortSignal));
    expect(onAppend).toHaveBeenCalledOnce();
    expect(element.scrollTop).toBe(360);
  });
});
