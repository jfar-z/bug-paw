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
  history: { startEntryId: "user-21", branchToken: "branch-a", hasMoreBefore: true, turnCount: 20 },
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
      history: { branchToken: "branch-a", hasMoreBefore: false, turnCount: 0 },
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
      history: { startEntryId: "user-1", branchToken: "branch-a", hasMoreBefore: false, turnCount: 5 },
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
});
