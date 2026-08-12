import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveWorkspaceSwipe,
  shouldIgnoreWorkspaceSwipe,
  useMobileWorkspaceSwipe,
  type MobileWorkspaceDrawer,
} from "./mobile-workspace-swipe";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("移动端工作区双向抽屉手势", () => {
  it("根据水平滑动方向打开或关闭对应抽屉", () => {
    expect(resolveWorkspaceSwipe(undefined, 96, 8)).toEqual({ action: "open", drawer: "sessions" });
    expect(resolveWorkspaceSwipe(undefined, -96, 8)).toEqual({ action: "open", drawer: "resources" });
    expect(resolveWorkspaceSwipe("sessions", -96, 8)).toEqual({ action: "close", drawer: "sessions" });
    expect(resolveWorkspaceSwipe("resources", 96, 8)).toEqual({ action: "close", drawer: "resources" });
    expect(resolveWorkspaceSwipe(undefined, 100, 90)).toBeUndefined();
    expect(resolveWorkspaceSwipe(undefined, 60, 4)).toBeUndefined();
  });

  it("使用 pointerup 最终坐标结算快速滑动并维持指针捕获", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(<SwipeHarness />);
    const surface = screen.getByTestId("swipe-surface");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(surface, { setPointerCapture, releasePointerCapture });

    fireEvent.pointerDown(surface, { pointerType: "touch", pointerId: 7, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerType: "touch", pointerId: 7, clientX: 60, clientY: 204 });
    expect(screen.getByTestId("session-translate")).not.toHaveTextContent("none");
    fireEvent.pointerUp(surface, { pointerType: "touch", pointerId: 7, clientX: 130, clientY: 206 });

    expect(screen.getByTestId("open-drawer")).toHaveTextContent("sessions");
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("指针在手势区域外释放时仍完成已经开始的滑动", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(<SwipeHarness />);
    const surface = screen.getByTestId("swipe-surface");
    Object.assign(surface, { setPointerCapture: undefined });

    fireEvent.pointerDown(surface, { pointerType: "touch", pointerId: 9, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerType: "touch", pointerId: 9, clientX: 120, clientY: 204 });
    fireEvent.pointerUp(window, { pointerType: "touch", pointerId: 9, clientX: 120, clientY: 204 });

    expect(screen.getByTestId("open-drawer")).toHaveTextContent("sessions");
  });

  it("pointercancel 只清理手势且不切换抽屉", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(<SwipeHarness />);
    const surface = screen.getByTestId("swipe-surface");
    Object.assign(surface, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });

    fireEvent.pointerDown(surface, { pointerType: "touch", pointerId: 8, clientX: 220, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerType: "touch", pointerId: 8, clientX: 100, clientY: 204 });
    fireEvent.pointerCancel(surface, { pointerType: "touch", pointerId: 8, clientX: 100, clientY: 204 });

    expect(screen.getByTestId("open-drawer")).toHaveTextContent("none");
  });

  it("排除交互元素、媒体和横向滚动区域", () => {
    const root = document.createElement("section");
    const button = root.appendChild(document.createElement("button"));
    const link = root.appendChild(document.createElement("a"));
    const code = root.appendChild(document.createElement("code"));
    const image = root.appendChild(document.createElement("img"));
    const scroller = root.appendChild(document.createElement("div"));
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 220 },
    });
    scroller.style.overflowX = "auto";
    const child = scroller.appendChild(document.createElement("span"));

    expect(shouldIgnoreWorkspaceSwipe(button, root)).toBe(true);
    expect(shouldIgnoreWorkspaceSwipe(link, root)).toBe(true);
    expect(shouldIgnoreWorkspaceSwipe(code, root)).toBe(true);
    expect(shouldIgnoreWorkspaceSwipe(image, root)).toBe(true);
    expect(shouldIgnoreWorkspaceSwipe(child, root)).toBe(true);
    expect(shouldIgnoreWorkspaceSwipe(root, root)).toBe(false);
  });
});

function SwipeHarness() {
  const [openDrawer, setOpenDrawer] = useState<MobileWorkspaceDrawer>();
  const swipe = useMobileWorkspaceSwipe({
    openDrawer,
    onOpenDrawer: setOpenDrawer,
    onCloseDrawer: () => setOpenDrawer(undefined),
  });
  return <section data-testid="swipe-surface" {...swipe.handlers}>
    <span data-testid="open-drawer">{openDrawer ?? "none"}</span>
    <span data-testid="session-translate">{swipe.sessionTranslatePercent ?? "none"}</span>
    <span data-testid="resource-translate">{swipe.resourceTranslatePercent ?? "none"}</span>
  </section>;
}
