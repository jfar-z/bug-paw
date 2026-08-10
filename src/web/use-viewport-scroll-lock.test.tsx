import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useViewportScrollLock } from "./use-viewport-scroll-lock";

afterEach(() => {
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
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
});
