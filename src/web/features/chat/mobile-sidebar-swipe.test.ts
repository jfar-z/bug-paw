import { describe, expect, it } from "vitest";

import { resolveSidebarSwipe, shouldIgnoreSidebarSwipe } from "./mobile-sidebar-swipe";

describe("移动端会话侧栏滑动判定", () => {
  it("右划打开、左划关闭，并忽略垂直或短距离移动", () => {
    expect(resolveSidebarSwipe(false, 96, 12)).toBe("open");
    expect(resolveSidebarSwipe(true, -96, 8)).toBe("close");
    expect(resolveSidebarSwipe(false, -96, 8)).toBeUndefined();
    expect(resolveSidebarSwipe(true, 96, 8)).toBeUndefined();
    expect(resolveSidebarSwipe(false, 60, 4)).toBeUndefined();
    expect(resolveSidebarSwipe(false, 100, 90)).toBeUndefined();
  });

  it("交互元素、代码、媒体与横向滚动区不触发侧栏手势", () => {
    const root = document.createElement("section");
    const button = root.appendChild(document.createElement("button"));
    const code = root.appendChild(document.createElement("code"));
    const image = root.appendChild(document.createElement("img"));
    const scroller = root.appendChild(document.createElement("div"));
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 220 },
    });
    scroller.style.overflowX = "auto";
    const scrollerChild = scroller.appendChild(document.createElement("span"));

    expect(shouldIgnoreSidebarSwipe(button, root)).toBe(true);
    expect(shouldIgnoreSidebarSwipe(code, root)).toBe(true);
    expect(shouldIgnoreSidebarSwipe(image, root)).toBe(true);
    expect(shouldIgnoreSidebarSwipe(scrollerChild, root)).toBe(true);
    expect(shouldIgnoreSidebarSwipe(root, root)).toBe(false);
  });
});
