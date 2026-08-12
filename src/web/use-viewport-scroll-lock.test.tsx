import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useViewportScrollLock } from "./use-viewport-scroll-lock";

afterEach(() => {
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
  document.documentElement.style.removeProperty("--app-viewport-height");
  vi.unstubAllGlobals();
});

describe("useViewportScrollLock", () => {
  it("挂载时锁定浏览器根滚动", () => {
    const { unmount } = renderHook(() => useViewportScrollLock());

    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
  });

  it("卸载时恢复 html 和 body 各自原有的滚动设置", () => {
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "scroll";
    const { unmount } = renderHook(() => useViewportScrollLock());

    unmount();

    expect(document.documentElement.style.overflow).toBe("auto");
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("页面刷新后视口高度变化时同步工作台高度", () => {
    const visualViewport = new EventTarget() as VisualViewport;
    Object.defineProperty(visualViewport, "height", { configurable: true, value: 720, writable: true });
    vi.stubGlobal("visualViewport", visualViewport);

    renderHook(() => useViewportScrollLock());

    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("720px");
    Object.defineProperty(visualViewport, "height", { configurable: true, value: 664, writable: true });
    window.dispatchEvent(new Event("pageshow"));

    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("664px");
  });

  it("离开对话页时恢复之前的工作台高度变量", () => {
    const visualViewport = new EventTarget() as VisualViewport;
    Object.defineProperty(visualViewport, "height", { configurable: true, value: 720 });
    vi.stubGlobal("visualViewport", visualViewport);
    document.documentElement.style.setProperty("--app-viewport-height", "680px");

    const { unmount } = renderHook(() => useViewportScrollLock());
    unmount();

    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("680px");
  });
});
