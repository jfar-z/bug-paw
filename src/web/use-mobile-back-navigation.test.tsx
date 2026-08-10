import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRoute } from "./router";
import { MOBILE_BACK_REQUEST_EVENT, useMobileBackNavigation } from "./use-mobile-back-navigation";

const queryListeners = new Set<(event: MediaQueryListEvent) => void>();
let compactViewport = true;
let coarsePointer = true;

beforeEach(() => {
  compactViewport = true;
  coarsePointer = true;
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query.includes("max-width") ? compactViewport : query.includes("pointer") ? coarsePointer : false,
    media: query,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => queryListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => queryListeners.delete(listener),
  })));
  window.history.replaceState({}, "", "/chat");
});

afterEach(() => {
  queryListeners.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useMobileBackNavigation", () => {
  it("优先让沉浸式媒体消费移动端返回", () => {
    const onNavigate = vi.fn();
    const onCloseMedia = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, onCloseMedia);
    renderHook(() => useMobileBackNavigation({ route: { page: "chat" }, enabled: true, onNavigate }));

    act(() => {
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(onCloseMedia).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
    window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, onCloseMedia);
  });

  it("从非对话页面返回时进入对话页面", () => {
    const onNavigate = vi.fn();
    renderHook(() => useMobileBackNavigation({ route: { page: "knowledge-base" }, enabled: true, onNavigate }));

    act(() => {
      window.history.replaceState({}, "", "/knowledge-base");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(onNavigate).toHaveBeenCalledWith({ page: "chat" }, true);
  });

  it("在对话页首次返回提示、第二次返回放行历史退出", () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const exitSpy = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const { result } = renderHook(() => useMobileBackNavigation({ route: { page: "chat" }, enabled: true, onNavigate }));

    act(() => {
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.showExitHint).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(600);
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(exitSpy).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("忽略同一次返回手势连续触发的历史事件", () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const exitSpy = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const { result } = renderHook(() => useMobileBackNavigation({ route: { page: "chat" }, enabled: true, onNavigate }));

    act(() => {
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(result.current.showExitHint).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("宽屏触控设备也启用返回守卫", () => {
    compactViewport = false;
    coarsePointer = true;
    const onNavigate = vi.fn();
    const { result } = renderHook(() => useMobileBackNavigation({ route: { page: "chat" }, enabled: true, onNavigate }));

    act(() => {
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(result.current.showExitHint).toBe(true);
  });

  it("刷新后保留旧守卫标记时仍创建本次加载的返回条目", () => {
    window.history.replaceState({ "pi-agent-mobile-back-guard": true }, "", "/chat");
    const historyLength = window.history.length;

    renderHook(() => useMobileBackNavigation({ route: { page: "chat" }, enabled: true, onNavigate: vi.fn() }));

    expect(window.history.length).toBe(historyLength + 1);
  });

  it("从非对话页恢复后忽略同一手势的重复历史事件", () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    const { result, rerender } = renderHook(
      ({ route }: { route: AppRoute }) => useMobileBackNavigation({ route, enabled: true, onNavigate }),
      { initialProps: { route: { page: "knowledge-base" } as AppRoute } },
    );

    act(() => {
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    rerender({ route: { page: "chat" } });

    act(() => {
      window.history.replaceState({}, "", "/chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(onNavigate).toHaveBeenCalledWith({ page: "chat" }, true);
    expect(result.current.showExitHint).toBe(false);
  });
});
